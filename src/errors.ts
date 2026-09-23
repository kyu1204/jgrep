// WI-12 error taxonomy: typed provider errors, status/transport classification,
// Retry-After parsing and full-jitter backoff math. Pure functions, no I/O, no deps.
export type JevErrorKind =
  | "insufficient_credits" | "invalid_api_key" | "model_unavailable" | "rate_limited"
  | "bad_request" | "malformed_response" | "server_unreachable" | "tls_error"
  | "timeout" | "circuit_breaker_open";

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
/** Fatal kinds trip the circuit breaker and abort the run early (§1.5). */
export const FATAL_KINDS: ReadonlySet<JevErrorKind> = new Set([
  "insufficient_credits", "invalid_api_key", "model_unavailable", "server_unreachable", "tls_error",
]);
export const MODEL_NOT_FOUND_RE = /model not found|no endpoints found/i;

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
 * server_unreachable, so a per-code table would only duplicate the fallthrough.
 */
export function classifyTransport(err: unknown): { kind: JevErrorKind; retryable: boolean } {
  const layers: ErrLayer[] = [];
  let cur: unknown = err;
  while (cur != null && typeof cur === "object" && layers.length < 5) {
    layers.push(cur as ErrLayer);
    cur = (cur as ErrLayer).cause;
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
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
