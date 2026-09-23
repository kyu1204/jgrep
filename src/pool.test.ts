// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { JevProviderError, type JevErrorKind } from "./errors";
import { runPool } from "./pool";

const fatal = (kind: JevErrorKind = "invalid_api_key", msg = "fatal") =>
  new JevProviderError(kind, msg, { provider: "test", retryable: false });
const nonFatal = (kind: JevErrorKind = "timeout", msg = "non-fatal") =>
  new JevProviderError(kind, msg, { provider: "test", retryable: true });

test("happy path: 10 items, concurrency 4, all succeed", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const r = await runPool(items, { concurrency: 4 }, async (n) => n * 2);
  expect(r.results.length).toBe(10);
  expect([...r.results].sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  expect(r.errors).toEqual([]);
  expect(r.aborted).toBe(false);
  expect(r.unprocessed).toBe(0);
  expect(r.hadSuccess).toBe(true);
});

test("partial isolation: non-fatal failures are recorded, the run continues", async () => {
  const items = [0, 1, 2, 3, 4, 5];
  let invocations = 0;
  const r = await runPool(items, { concurrency: 2 }, async (n) => {
    invocations++;
    if (n === 2 || n === 4) throw nonFatal("timeout", "too slow");
    return n * 10;
  });
  expect(invocations).toBe(6); // every item attempted, none skipped
  expect(r.results.length).toBe(4);
  expect([...r.results].sort((a, b) => a - b)).toEqual([0, 10, 30, 50]);
  expect(r.errors.map((e) => e.index).sort((a, b) => a - b)).toEqual([2, 4]);
  expect(r.errors.every((e) => e.error.kind === "timeout")).toBe(true);
  expect(r.aborted).toBe(false); // timeout is not a fatal kind
  expect(r.unprocessed).toBe(0);
  expect(r.hadSuccess).toBe(true);
});

test("breaker trips: 3 consecutive fatals abort the run (concurrency 1, exact)", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let i = 0; // invocation order, not item identity
  const r = await runPool(items, { concurrency: 1 }, async () => {
    if (i++ < 3) throw fatal("invalid_api_key", "bad key");
    return "ok";
  });
  expect(r.aborted).toBe(true);
  expect(i).toBe(3); // dispatched exactly 3 items, then stopped
  expect(r.unprocessed).toBe(7);
  expect(r.errors.length).toBe(3);
  expect(r.errors.every((e) => e.error.kind === "invalid_api_key")).toBe(true);
  expect(r.results).toEqual([]);
  expect(r.hadSuccess).toBe(false);
});

test("breaker trips with concurrency 4: stops dispatching, in-flight items finish", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let i = 0;
  const r = await runPool(items, { concurrency: 4 }, async () => {
    const invocation = i++;
    if (invocation < 3) throw fatal("invalid_api_key", "bad key");
    return "ok";
  });
  expect(r.aborted).toBe(true);
  expect(i).toBeGreaterThanOrEqual(3);
  expect(i).toBeLessThanOrEqual(6); // 3 fatals + whatever was dispatched before the trip settled
  expect(i + r.unprocessed).toBe(10); // every item is either attempted or unprocessed
  expect(r.unprocessed).toBeGreaterThan(0);
  expect(r.errors.length).toBe(3);
  expect(r.hadSuccess).toBe(true); // items dispatched before the trip still completed
});

test("success resets the fatal counter: F F S F F S F F never trips (threshold 3)", async () => {
  const items = Array.from({ length: 8 }, (_, i) => i);
  let i = 0;
  const r = await runPool(items, { concurrency: 1, breakerThreshold: 3 }, async () => {
    const invocation = i++;
    if (invocation % 3 !== 2) throw fatal("insufficient_credits"); // F F S F F S F F
    return "ok";
  });
  expect(r.aborted).toBe(false); // 2 consecutive fatals max, a success always interleaves
  expect(i).toBe(8);
  expect(r.errors.length).toBe(6);
  expect(r.results.length).toBe(2);
  expect(r.hadSuccess).toBe(true);
  expect(r.unprocessed).toBe(0);
});

test("counter reset with concurrency 4: one fatal among successes never trips", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const r = await runPool(items, { concurrency: 4 }, async (n) => {
    if (n === 0) throw fatal("model_unavailable", "gone");
    return "ok";
  });
  expect(r.aborted).toBe(false);
  expect(r.errors.map((e) => e.index).sort((a, b) => a - b)).toEqual([0]); // fatal-but-below-threshold is still recorded
  expect(r.results.length).toBe(9);
  expect(r.unprocessed).toBe(0);
});

test("failFast: the first fatal rejects with the exact original error; in-flight tolerated", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const boom = fatal("insufficient_credits", "out of credits");
  let invocations = 0, completions = 0;
  let caught: unknown;
  try {
    await runPool(items, { concurrency: 4, failFast: true }, async (n) => {
      invocations++;
      if (n === 0) throw boom;
      await new Promise((res) => setTimeout(res, 5)); // in-flight work
      completions++;
      return "ok";
    });
  } catch (e) { caught = e; }
  expect(caught).toBe(boom); // same instance, not a wrapper
  await new Promise((res) => setTimeout(res, 30)); // let in-flight workers drain
  expect(invocations).toBeLessThanOrEqual(4); // nothing dispatched after the fatal
  expect(completions).toBe(invocations - 1); // in-flight items still finished, nothing cancelled
});

test("failFast: late in-flight settlements mutate nothing, never rethrow, never refire onProgress", async () => {
  // 4 workers, all dispatched before the first fatal settles. Item 0 rejects fast;
  // item 1 rejects LATER with a second fatal, items 2 and 3 succeed later. After the
  // rejection none of that may be observable: no results/errors mutations, no
  // onProgress, and no second throw (an unhandled rejection after Promise.all settled).
  const items = Array.from({ length: 12 }, (_, i) => i);
  const boom = fatal("insufficient_credits", "out of credits");
  const lateBoom = fatal("invalid_api_key", "late fatal from an in-flight item");
  const progress: number[] = [];
  let caught: unknown;
  try {
    await runPool(items, { concurrency: 4, failFast: true, onProgress: (done) => progress.push(done) }, async (n) => {
      if (n === 0) throw boom; // the fast fatal: rejects the run immediately
      if (n === 1) { await new Promise((res) => setTimeout(res, 30)); throw lateBoom; } // late in-flight fatal
      if (n === 2 || n === 3) await new Promise((res) => setTimeout(res, 30)); // late in-flight successes
      return "ok";
    });
  } catch (e) { caught = e; }
  expect(caught).toBe(boom); // the first fatal is the rejection; the late one was swallowed
  await new Promise((res) => setTimeout(res, 60)); // drain every in-flight settlement
  expect(progress).toEqual([]); // onProgress never fired: the fatal threw before it, late settlements are guarded
});

test("failFast with a non-fatal first error: records it and keeps going", async () => {
  const items = [0, 1, 2, 3, 4, 5];
  let invocations = 0;
  const r = await runPool(items, { concurrency: 2, failFast: true }, async (n) => {
    invocations++;
    if (n === 0 || n === 3) throw nonFatal("rate_limited", "429");
    return `ok${n}`;
  });
  expect(invocations).toBe(6); // failFast only applies to fatal kinds
  expect(r.errors.map((e) => e.index).sort((a, b) => a - b)).toEqual([0, 3]);
  expect(r.errors.every((e) => e.error.kind === "rate_limited")).toBe(true);
  expect(r.results.length).toBe(4);
  expect(r.aborted).toBe(false);
  expect(r.hadSuccess).toBe(true);
});

test("an unknown thrown value is wrapped as bad_request with the cause preserved", async () => {
  const items = [0, 1, 2];
  const boom = new Error("boom");
  const r = await runPool(items, { concurrency: 2 }, async (n) => {
    if (n === 1) throw boom;
    return `ok${n}`;
  });
  expect(r.errors.length).toBe(1);
  expect(r.errors[0].index).toBe(1);
  const e = r.errors[0].error;
  expect(e).toBeInstanceOf(JevProviderError);
  expect(e.kind).toBe("bad_request");
  expect(e.retryable).toBe(false);
  expect(e.cause).toBe(boom);
  expect(e.message).toBe("boom");
  expect(r.results.length).toBe(2);
  expect(r.aborted).toBe(false); // bad_request is not a fatal kind
  expect(r.hadSuccess).toBe(true);
});

test("onProgress fires once per settled item, counting successes and errors", async () => {
  const items = [0, 1, 2, 3, 4];
  const calls: Array<[number, number]> = [];
  await runPool(items, { concurrency: 3, onProgress: (done, total) => calls.push([done, total]) }, async (n) => {
    if (n === 1 || n === 3) throw nonFatal("timeout");
    return "ok";
  });
  expect(calls.length).toBe(items.length);
  expect(calls[calls.length - 1]).toEqual([5, 5]);
  expect(calls.map((c) => c[0])).toEqual([1, 2, 3, 4, 5]); // strictly increments, errors included
  expect(calls.every((c) => c[1] === 5)).toBe(true);
});

test("concurrency <= 0 is treated as 1; a single worker keeps item order", async () => {
  const r = await runPool([1, 2, 3], { concurrency: 0 }, async (n) => n * 3);
  expect(r.results).toEqual([3, 6, 9]); // completion order === item order with one worker
  const r2 = await runPool([1, 2, 3], { concurrency: -5 }, async (n) => n);
  expect(r2.results.length).toBe(3);
  expect(r2.hadSuccess).toBe(true);
});

test("empty items resolve immediately with an empty result", async () => {
  const r = await runPool<number, number>([], { concurrency: 4 }, async (n) => n);
  expect(r).toEqual({ results: [], errors: [], aborted: false, unprocessed: 0, hadSuccess: false });
});

test("results are in completion order, not item order (concurrency > 1)", async () => {
  const items = [0, 1, 2, 3];
  const r = await runPool(items, { concurrency: 4 }, async (n) => {
    if (n === 0) await new Promise((res) => setTimeout(res, 10)); // item 0 finishes last
    return n;
  });
  expect([...r.results].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]); // all present
  expect(r.results[r.results.length - 1]).toBe(0); // ...but the slow one is last: completion order
});
