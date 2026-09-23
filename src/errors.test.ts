import { test, expect } from "bun:test";
import {
  JevProviderError, RETRYABLE_STATUSES, NON_RETRYABLE_STATUSES, FATAL_KINDS, MODEL_NOT_FOUND_RE,
  classifyStatus, classifyTransport, parseRetryAfter, jitteredDelayMs, isFatalError,
  type JevErrorKind,
} from "./errors";

const STATUS_MATRIX: Record<number, { kind: JevErrorKind; retryable: boolean }> = {
  408: { kind: "timeout", retryable: true },
  429: { kind: "rate_limited", retryable: true },
  500: { kind: "server_unreachable", retryable: true },
  502: { kind: "server_unreachable", retryable: true },
  503: { kind: "server_unreachable", retryable: true },
  504: { kind: "server_unreachable", retryable: true },
  529: { kind: "server_unreachable", retryable: true },
  400: { kind: "bad_request", retryable: false },
  401: { kind: "invalid_api_key", retryable: false },
  402: { kind: "insufficient_credits", retryable: false },
  403: { kind: "invalid_api_key", retryable: false },
  404: { kind: "model_unavailable", retryable: false },
  405: { kind: "bad_request", retryable: false },
  422: { kind: "bad_request", retryable: false },
};

test("classifyStatus: exact kind/retryable for every listed status", () => {
  for (const s of RETRYABLE_STATUSES) expect(classifyStatus(s, "")).toEqual(STATUS_MATRIX[s]);
  for (const s of NON_RETRYABLE_STATUSES) expect(classifyStatus(s, "")).toEqual(STATUS_MATRIX[s]);
  expect(classifyStatus(529, "")).toEqual({ kind: "server_unreachable", retryable: true });
  expect(classifyStatus(418, "")).toEqual({ kind: "bad_request", retryable: false });
});

test("classifyStatus: model-not-found body takes precedence, even over 5xx", () => {
  expect(classifyStatus(503, "Error: no endpoints found matching model")).toEqual({ kind: "model_unavailable", retryable: false });
  expect(classifyStatus(500, "model not found: jev-latest")).toEqual({ kind: "model_unavailable", retryable: false });
  expect(MODEL_NOT_FOUND_RE.test("No Endpoints Found")).toBe(true);
});

test("drift: every status in RETRYABLE/NON_RETRYABLE_STATUSES classifies with the matching retryable flag", () => {
  // Guards the SETS against drifting away from classifyStatus: a status listed as
  // retryable must classify retryable, a non-retryable one must not.
  for (const s of RETRYABLE_STATUSES) {
    expect(classifyStatus(s, "").retryable).toBe(true);
    expect(NON_RETRYABLE_STATUSES.has(s)).toBe(false); // a status belongs to exactly one set
  }
  for (const s of NON_RETRYABLE_STATUSES) {
    expect(classifyStatus(s, "").retryable).toBe(false);
    expect(RETRYABLE_STATUSES.has(s)).toBe(false);
  }
});

test("classifyTransport: abort/timeout, network codes, TLS, wrapped cause, fallback", () => {
  expect(classifyTransport({ name: "AbortError" })).toEqual({ kind: "timeout", retryable: true });
  expect(classifyTransport({ name: "TimeoutError" })).toEqual({ kind: "timeout", retryable: true });
  expect(classifyTransport({ code: "ABORT_ERR" })).toEqual({ kind: "timeout", retryable: true });
  expect(classifyTransport({ code: "ECONNRESET" })).toEqual({ kind: "server_unreachable", retryable: true });
  expect(classifyTransport({ code: "EAI_AGAIN" })).toEqual({ kind: "server_unreachable", retryable: true });
  expect(classifyTransport({ code: "ENOTFOUND" })).toEqual({ kind: "server_unreachable", retryable: true });
  expect(classifyTransport({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toEqual({ kind: "tls_error", retryable: false });
  expect(classifyTransport({ message: "unable to verify the first certificate" })).toEqual({ kind: "tls_error", retryable: false });
  expect(classifyTransport({ cause: { code: "ECONNREFUSED" } })).toEqual({ kind: "server_unreachable", retryable: true });
  expect(classifyTransport({ message: "fetch failed", cause: { code: "ECONNREFUSED" } })).toEqual({ kind: "server_unreachable", retryable: true });
  expect(classifyTransport({ message: "weird" })).toEqual({ kind: "server_unreachable", retryable: true });
});

test("parseRetryAfter: delta-seconds, HTTP-date, junk and 5-minute cap", () => {
  expect(parseRetryAfter("2")).toBe(2000);
  expect(parseRetryAfter("0")).toBe(0);
  expect(parseRetryAfter("nope")).toBe(null);
  expect(parseRetryAfter(null)).toBe(null);
  expect(parseRetryAfter(undefined)).toBe(null);
  expect(parseRetryAfter("")).toBe(null);
  const in30s = new Date(Date.now() + 30_000).toUTCString();
  const d = parseRetryAfter(in30s);
  expect(d).not.toBeNull();
  expect(d!).toBeGreaterThan(29_000);
  expect(d!).toBeLessThanOrEqual(30_000);
  expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  expect(parseRetryAfter("999999")).toBe(300_000);
});

test("jitteredDelayMs: full jitter stays within [0, min(cap, base*2^attempt)]", () => {
  for (let attempt = 0; attempt <= 6; attempt++) {
    const max = Math.min(30_000, 500 * 2 ** attempt);
    for (let i = 0; i < 50; i++) {
      const d = jitteredDelayMs(attempt);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(max);
    }
  }
});

test("jitteredDelayMs: deterministic rand, negative attempt clamps to 0, cap respected", () => {
  expect(jitteredDelayMs(0, 500, 30_000, () => 0.5)).toBe(250);
  expect(jitteredDelayMs(1, 500, 30_000, () => 0.5)).toBe(500);
  expect(jitteredDelayMs(-3, 500, 30_000, () => 0.5)).toBe(250);
  expect(jitteredDelayMs(10, 500, 30000, () => 1)).toBe(30000);
});

test("JevProviderError carries fields; isFatalError true only for FATAL_KINDS", () => {
  const cause = new Error("boom");
  const e = new JevProviderError("rate_limited", "429 too many requests", {
    provider: "typesafe", status: 429, retryable: true, hint: "slow down", cause,
  });
  expect(e).toBeInstanceOf(Error);
  expect(e).toBeInstanceOf(JevProviderError);
  expect(e.name).toBe("JevProviderError");
  expect(e.message).toBe("429 too many requests");
  expect(e.kind).toBe("rate_limited");
  expect(e.provider).toBe("typesafe");
  expect(e.status).toBe(429);
  expect(e.retryable).toBe(true);
  expect(e.hint).toBe("slow down");
  expect(e.cause).toBe(cause);

  for (const kind of FATAL_KINDS) {
    expect(isFatalError(new JevProviderError(kind, "x", { provider: "p", retryable: false }))).toBe(true);
  }
  for (const kind of ["rate_limited", "bad_request", "malformed_response", "timeout", "circuit_breaker_open"] as const) {
    expect(isFatalError(new JevProviderError(kind, "x", { provider: "p", retryable: true }))).toBe(false);
  }
  expect(isFatalError(new Error("plain"))).toBe(false);
  expect(isFatalError(null)).toBe(false);
  expect(isFatalError("nope")).toBe(false);
});
