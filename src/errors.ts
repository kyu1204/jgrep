// WI-12 error taxonomy: typed provider errors, status/transport classification,
// Retry-After parsing and full-jitter backoff math. Pure functions, no I/O, no deps.
// A runtime list (the type derives from it) so cli.ts USAGE can name the kinds from here.
export const ERROR_KINDS = [
  "insufficient_credits", "invalid_api_key", "model_unavailable", "rate_limited",
  "bad_request", "malformed_response", "server_unreachable", "tls_error",
  "timeout", "circuit_breaker_open",
  "budget_exhausted", // WI-7 --budget: a per-provider reservation refusal (TRDD-3KBUODCE): falls back to the next entry (a free local server at $0 is reached); still non-fatal (not in FATAL_KINDS)
  "forbidden",        // OpenRouter 403: moderation flag or a key/model permission — per request, never fatal
] as const;
export type JevErrorKind = (typeof ERROR_KINDS)[number];

export interface JevErrorOpts { provider: string; status?: number; retryable: boolean; hint?: string; cause?: unknown }

export class JevProviderError extends Error {
  kind: JevErrorKind;
  provider: string;
  status?: number;
  retryable: boolean;
  hint?: string;
  cause?: unknown;
  constructor(kind: JevErrorKind, message: string, opts: JevErrorOpts) {
    super(message);
    this.name = "JevProviderError";
    this.kind = kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }
}

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);
export const NON_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 405, 422]);
/** Fatal kinds trip the circuit breaker and abort the run early (§1.5).
 *  "budget_exhausted" (WI-7 --budget) is deliberately NOT here: it is a per-provider
 *  reservation refusal (TRDD-3KBUODCE), not a provider failure — non-retryable by
 *  construction (nothing to retry) but it must not count toward the breaker, so every
 *  remaining batch reports the same budget stop instead of the run mutating into
 *  circuit_breaker_open errors. It IS a fallback kind (FALLBACK_KINDS): a pricier entry
 *  that refuses falls back to the next one, so a free local server (mlx, $0) is reached
 *  even when the budget is spent. */
export const FATAL_KINDS: ReadonlySet<JevErrorKind> = new Set([
  "insufficient_credits", "invalid_api_key", "model_unavailable", "server_unreachable", "tls_error",
]);
// "Model X does not exist" is OpenRouter's real answer for a missing model — as HTTP 400,
// not 404 (live 2026-10-02). Without it a bad --model became a non-fatal bad_request on
// every batch instead of one fatal model_unavailable with the pin-a-version hint.
export const MODEL_NOT_FOUND_RE = /model not found|no endpoints found|\bmodel\b[^"]*\bdoes not exist/i;

// ---- classification ----------------------------------------------------------

/**
 * Map an HTTP status (+ bounded body snippet) to kind/retryable. The kind doubles as
 * the FINAL error kind when retries are exhausted. A model-not-found body wins over
 * everything checked after it — notably other 5xx, which would otherwise retry
 * forever against a permanently missing model.
 */
export function classifyStatus(status: number, bodySnippet: string): { kind: JevErrorKind; retryable: boolean } {
  if (status === 402) return { kind: "insufficient_credits", retryable: false };
  if (status === 401 || status === 403) return { kind: "invalid_api_key", retryable: false };
  if (status === 404 || MODEL_NOT_FOUND_RE.test(bodySnippet)) return { kind: "model_unavailable", retryable: false };
  if (status === 429) return { kind: "rate_limited", retryable: true };
  if (status === 408) return { kind: "timeout", retryable: true };
  if (status >= 500) return { kind: "server_unreachable", retryable: true };
  return { kind: "bad_request", retryable: false };
}

const TLS_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_SSL_WRONG_VERSION_NUMBER",
]);
const ABORT_NAMES = new Set(["AbortError", "TimeoutError"]);
const TLS_MESSAGE_RE = /certificate|TLS|SSL/i;
type ErrLayer = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

/**
 * Inspect a transport error (and undici/Bun wrap causes) for kind/retryable.
 * Abort-shaped errors are timeouts; TLS-shaped ones are fatal; EVERYTHING else —
 * connection resets, refusals, DNS failures, unknown junk — is a retryable
 * server_unreachable, so the per-code table would only duplicate the fallthrough.
 */
function layersOf(err: unknown): ErrLayer[] {
  const layers: ErrLayer[] = [];
  let cur: unknown = err;
  while (cur != null && typeof cur === "object" && layers.length < 5) {
    layers.push(cur as ErrLayer);
    cur = (cur as ErrLayer).cause;
  }
  return layers;
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** fetch(..., { redirect: "error" }) rejecting on a 3xx: Bun throws code
 *  "UnexpectedRedirect", Node/undici a TypeError whose cause says "unexpected redirect". */
export function isRedirectError(err: unknown): boolean {
  return layersOf(err).some((l) => str(l.code) === "UnexpectedRedirect" || /unexpected redirect/i.test(str(l.message)));
}

export function classifyTransport(err: unknown): { kind: JevErrorKind; retryable: boolean } {
  const layers = layersOf(err);
  // A redirect is a misconfigured endpoint, not a transient failure: retrying cannot fix
  // it, and following it would carry the Authorization header to another server.
  if (isRedirectError(err)) return { kind: "server_unreachable", retryable: false };
  if (layers.some((l) => ABORT_NAMES.has(str(l.name)) || str(l.code) === "ABORT_ERR")) {
    return { kind: "timeout", retryable: true };
  }
  if (layers.some((l) => TLS_CODES.has(str(l.code)) || TLS_MESSAGE_RE.test(str(l.message)))) {
    return { kind: "tls_error", retryable: false };
  }
  return { kind: "server_unreachable", retryable: true };
}

// ---- retry math --------------------------------------------------------------

/** Retry-After is capped at 5 minutes so a hostile header cannot stall the run. */
export const RETRY_AFTER_MAX_MS = 300_000;

/** Delta-seconds or HTTP-date to milliseconds; null when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Math.min(RETRY_AFTER_MAX_MS, Number(v) * 1000);
  if (!Number.isNaN(Number(v))) return null; // plain number, but not integer delta-seconds
  const at = new Date(v).getTime();
  if (Number.isNaN(at)) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, at - Date.now()));
}

/** Full jitter: rand() * min(cap, base * 2^attempt), attempt 0-based. Returns a FLOAT by
 *  design (rand scaling) — flooring is owned by the call site (postSystemOne), the single
 *  place a delay crosses into a timer, so the integer contract has exactly one owner. */
export function jitteredDelayMs(attempt: number, base = 500, cap = 30_000, rand: () => number = Math.random): number {
  return rand() * Math.min(cap, base * 2 ** Math.max(0, attempt));
}

export function isFatalError(e: unknown): boolean {
  return e instanceof JevProviderError && FATAL_KINDS.has(e.kind);
}
