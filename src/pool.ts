// runPool — the shared worker pool behind jgrep() and scoreRows(): partial-failure
// isolation + circuit breaker (WI-12 core, plan §1.5). Both call sites used to
// hand-roll the same shared-counter pool where one rejection killed the whole run.
//
// Semantics:
//   - Non-fatal item failure -> recorded in errors[], the run continues.
//   - Fatal-kind failure     -> recorded too; breakerThreshold CONSECUTIVE fatals
//                               (any success resets the counter) trip the breaker:
//                               no new dispatches, in-flight items finish, and
//                               everything never attempted is reported as unprocessed.
//   - failFast               -> rethrow the FIRST fatal error instead (today's
//                               abort-on-first-fatal behavior).
import { isFatalError, JevProviderError } from "./errors";

export interface PoolOptions {
  /** Worker count; capped at items.length, floored at 1 (<= 0 counts as 1). */
  concurrency: number;
  /** Rethrow the first fatal-kind error (restores today's abort-on-first-fatal). */
  failFast?: boolean;
  /** Consecutive fatal-kind failures before the breaker trips. Default 3. */
  breakerThreshold?: number;
  /** Fired after each item settles — success OR error. */
  onProgress?: (done: number, total: number) => void;
}

export interface PoolResult<R> {
  /** Successful per-item results, in COMPLETION order (re-associate via the worker's own return value). */
  results: R[];
  /** Failed items (non-fatal, or fatal-but-below-threshold), in settlement order. */
  errors: { index: number; error: JevProviderError }[];
  /** True when the circuit breaker tripped. */
  aborted: boolean;
  /** Items never attempted because of the abort. */
  unprocessed: number;
  /** At least one item succeeded (drives the invalid_api_key "expired vs wrong key" hint). */
  hadSuccess: boolean;
}

/**
 * An unknown thrown value (not a JevProviderError) is an escape hatch that should
 * never trigger with the Step-3 engine (postSystemOne always throws typed errors).
 * It is wrapped as kind "bad_request": the least-wrong non-fatal, non-retryable
 * kind — claiming a transport failure (server_unreachable) would be a guess AND a
 * fatal kind that would wrongly count toward the breaker, while bad_request just
 * isolates the item and lets the run continue. The original value stays reachable
 * via `cause`.
 */
function wrapUnknown(e: unknown): JevProviderError {
  return new JevProviderError("bad_request", String((e as { message?: unknown } | undefined)?.message ?? e), {
    provider: "pool", retryable: false, cause: e,
  });
}

export async function runPool<T, R>(
  items: T[],
  opts: PoolOptions,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PoolResult<R>> {
  const total = items.length;
  if (total === 0) return { results: [], errors: [], aborted: false, unprocessed: 0, hadSuccess: false };
  const requested = Number.isFinite(opts.concurrency) ? Math.floor(opts.concurrency) : 1;
  const concurrency = Math.min(Math.max(1, requested), total);
  const threshold = Math.max(1, opts.breakerThreshold ?? 3);

  let next = 0; // shared dispatch counter — see the invariant inside the loop
  let done = 0; // settled items, success OR error
  let consecutiveFatal = 0;
  let stopped = false; // no new dispatches; in-flight items still finish
  let aborted = false; // the circuit breaker tripped
  let hadSuccess = false;
  let rejected = false; // a failFast error is propagating: late settlements mutate nothing
  const results: R[] = [];
  const errors: PoolResult<R>["errors"] = [];

  const runWorker = async (): Promise<void> => {
    while (!stopped && next < total) {
      // §1.7 invariant: read+increment of the shared counter with NO await between —
      // single-threaded JS makes that the atomicity guarantee.
      const index = next++;
      try {
        const r = await worker(items[index], index);
        if (!rejected) {
          results.push(r); // completion order, not item order
          hadSuccess = true;
          consecutiveFatal = 0; // any success resets the breaker counter
        }
      } catch (e) {
        const err = e instanceof JevProviderError ? e : wrapUnknown(e);
        if (!rejected) {
          errors.push({ index, error: err });
          if (isFatalError(err)) {
            consecutiveFatal++;
            if (opts.failFast) {
              // The original error propagates out of Promise.all immediately.
              // In-flight workers are NOT cancelled: they finish their current item
              // (results discarded — nobody observes them) and dispatch nothing new.
              // `rejected` guards the settlement tail so a late in-flight settlement
              // cannot mutate results/errors/consecutiveFatal, refire onProgress, or
              // throw again (a second throw after Promise.all settled would surface
              // as an unhandled rejection).
              stopped = true;
              rejected = true;
              throw err;
            }
            if (consecutiveFatal >= threshold) {
              // Breaker tripped: in-flight items finish (they were attempted, so they
              // never count as unprocessed); only undispatched items do.
              aborted = true;
              stopped = true;
            }
          }
        }
      }
      if (!rejected) opts.onProgress?.(++done, total);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, runWorker));
  return { results, errors, aborted, unprocessed: aborted ? total - next : 0, hadSuccess };
}
