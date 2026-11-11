// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { BACKENDS, DEFAULT_REQUEST_TIMEOUT_SEC, RateLimiter, postSystemOne, verifyApiKey, type Fetch } from "./providers";
import { JevProviderError } from "./errors";

/** Ambient monotonic clock — deadlineMono values must live on performance.now(), never Date.now(). */
declare const performance: { now(): number };

// ---- fakes: repo fake-fetch DI pattern (calls[] capture) + tiny sleep recorder ----

interface Call {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

const resp = (status: number, body?: unknown, headers?: Record<string, string>): Response =>
  new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
const rawResp = (status: number, text: string, headers?: Record<string, string>): Response =>
  new Response(text, { status, headers });

/** Captures every (url, init) into calls[], then answers by attempt index; a thrown script value rejects. */
const scriptedFetch = (script: (n: number) => Response): { calls: Call[]; fetchImpl: Fetch } => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: Call["init"]) => {
    const n = calls.length;
    calls.push({ url: String(url), init });
    return script(n);
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

const GOOD = { answers: { c0: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10 } };

const errOf = async (p: Promise<unknown>): Promise<JevProviderError> => {
  try { await p; } catch (e) { return e as JevProviderError; }
  throw new Error("expected the promise to reject");
};

const sleepRecorder = () => {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number): Promise<void> => { sleeps.push(ms); } };
};

// ---- integer-timer contract helpers (Node RangeError regression guard) ----

/** AbortSignal.timeout CONTRACT RECORDER — Node throws `RangeError: The value of "delay"
 *  is out of range. It must be an integer.` on fractional delays while Bun silently
 *  accepts them, so bun test cannot observe a float leaking into an abort signal (the
 *  installed-bin outage bug). This patch is a call-through recorder: behavior is
 *  unchanged, and every delay it sees must be a positive integer (>= 1). The original
 *  static is restored in finally; bun runs tests in a file sequentially, so the patch
 *  never bleeds into a neighboring test. */
async function withTimeoutRecorder(run: (recorded: number[]) => Promise<void>): Promise<void> {
  const original = AbortSignal.timeout;
  const recorded: number[] = [];
  AbortSignal.timeout = (ms: number): AbortSignal => { recorded.push(ms); return original(ms); };
  try {
    await run(recorded);
  } finally {
    AbortSignal.timeout = original;
  }
}

/** Abort delays (AbortSignal.timeout): Node requires integers >= 1. */
const expectPositiveIntegers = (values: number[]): void => {
  for (const v of values) expect(Number.isInteger(v) && v > 0).toBe(true);
};

/** Timer sleeps (backoff/deadline capping): integers, 0 allowed once floored. */
const expectNonNegativeIntegers = (values: number[]): void => {
  for (const v of values) expect(Number.isInteger(v) && v >= 0).toBe(true);
};

// ---- postSystemOne: retries, backoff, classification ----

test("timeout-then-success: one retry with jittered backoff, headers on every attempt", async () => {
  const { calls, fetchImpl } = scriptedFetch((n) => {
    if (n === 0) throw { name: "AbortError" };
    return resp(200, GOOD);
  });
  const { sleeps, sleep } = sleepRecorder();
  const r = await postSystemOne({ model: "m", questions: {} }, BACKENDS.openrouter, "k", { fetchImpl, sleep });
  expect(r.answers.c0.noul).toBe(0.9);
  expect(r.usage?.input_tokens).toBe(10);
  expect(calls.length).toBe(2);
  expect(sleeps.length).toBe(1);
  expect(Number.isInteger(sleeps[0])).toBe(true); // integer contract: timers never see float ms
  expect(sleeps[0]).toBeGreaterThanOrEqual(0); // full jitter for attempt 0 — floored, so 0 is possible
  expect(sleeps[0]).toBeLessThanOrEqual(1000); // loose upper bound (exact cap is 500)
  for (const c of calls) {
    expect(c.init.headers).toMatchObject({ "X-Title": "jgrep", Authorization: "Bearer k", "Content-Type": "application/json" });
  }
});

test("429 with Retry-After: 2 then success -> recorded sleep of at least 2000ms", async () => {
  const { calls, fetchImpl } = scriptedFetch((n) => (n === 0 ? resp(429, "slow down", { "Retry-After": "2" }) : resp(200, GOOD)));
  const { sleeps, sleep } = sleepRecorder();
  await postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep });
  expect(calls.length).toBe(2);
  expect(sleeps.length).toBe(1);
  expect(Number.isInteger(sleeps[0])).toBe(true);
  expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
});

test("permanent 400 -> bad_request after exactly one call, zero sleeps", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(400, "bad question"));
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep }));
  expect(e.kind).toBe("bad_request");
  expect(e.retryable).toBe(false);
  expect(e.status).toBe(400);
  expect(e.message).toContain("400");
  expect(e.message).toContain("bad question");
  expect(calls.length).toBe(1);
  expect(sleeps.length).toBe(0);
});

test("402 -> insufficient_credits with billing URL and --provider typesafe hint", async () => {
  const { fetchImpl } = scriptedFetch(() => resp(402, "no credits"));
  const e = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl }));
  expect(e.kind).toBe("insufficient_credits");
  expect(e.retryable).toBe(false);
  expect(e.hint).toContain("https://openrouter.ai/credits");
  expect(e.hint).toContain("--provider typesafe");
});

test("401 -> invalid_api_key naming the provider's key env and key file", async () => {
  const { fetchImpl } = scriptedFetch(() => resp(401, "bad key"));
  const e = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl }));
  expect(e.kind).toBe("invalid_api_key");
  expect(e.message).toContain("OPENROUTER_API_KEY");
  expect(e.hint).toContain("OPENROUTER_API_KEY");
  expect(e.hint).toContain("openrouter.key");
});

test("404 and model-not-found bodies -> model_unavailable without retries", async () => {
  const missing = scriptedFetch(() => resp(404, "unknown model"));
  const e1 = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl: missing.fetchImpl }));
  expect(e1.kind).toBe("model_unavailable");
  expect(e1.hint).toContain("--model");
  expect(e1.hint).toContain("--provider typesafe");
  expect(missing.calls.length).toBe(1);

  const bodyHit = scriptedFetch(() => resp(502, "Error: no endpoints found for this model"));
  const e2 = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: bodyHit.fetchImpl }));
  expect(e2.kind).toBe("model_unavailable"); // body regex wins even though 502 alone would retry
  expect(e2.status).toBe(502);
  expect(bodyHit.calls.length).toBe(1);
});

test("retries exhausted: always-503 with maxRetries 2 -> 3 calls, attempt count in message", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(503, "down"));
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl, sleep, maxRetries: 2 }));
  expect(calls.length).toBe(3);
  expect(e.kind).toBe("server_unreachable");
  expect(e.retryable).toBe(true); // exhausted is still a transient-class failure
  expect(e.message).toContain("after 3 attempts");
  expect(e.message).toContain("503");
  expect(sleeps.length).toBe(2);
  expect(sleeps.every(Number.isInteger)).toBe(true);
});

test("jitter bounds for attempts 0..2 (no Retry-After header)", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(429, "throttled"));
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep, maxRetries: 3 }));
  expect(calls.length).toBe(4);
  expect(sleeps.length).toBe(3);
  expect(sleeps.every(Number.isInteger)).toBe(true);
  [500, 1000, 2000].forEach((max, i) => { // min(30000, 500 * 2**attempt)
    expect(sleeps[i]).toBeGreaterThanOrEqual(0);
    expect(sleeps[i]).toBeLessThanOrEqual(max);
  });
  expect(e.kind).toBe("rate_limited");
});

test("malformed 200 (body {}) -> malformed_response with snippet, zero retries", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(200, {}));
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep }));
  expect(e.kind).toBe("malformed_response");
  expect(e.retryable).toBe(false);
  expect(e.message).toContain("{}");
  expect(calls.length).toBe(1);
  expect(sleeps.length).toBe(0);

  const badAnswers = scriptedFetch(() => resp(200, { answers: "nope" }));
  const e2 = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl: badAnswers.fetchImpl }));
  expect(e2.kind).toBe("malformed_response");
  expect(badAnswers.calls.length).toBe(1);
});

test("non-JSON 200 -> malformed_response, not a misclassified transport retry", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => rawResp(200, "<html>gateway error</html>"));
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep }));
  expect(e.kind).toBe("malformed_response");
  expect(e.message).toContain("<html>gateway error</html>");
  expect(calls.length).toBe(1);
  expect(sleeps.length).toBe(0);
});

test("TLS transport error -> tls_error, no retry, certificate message verbatim in hint", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => { throw new Error("unable to verify the first certificate"); });
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep }));
  expect(e.kind).toBe("tls_error");
  expect(e.retryable).toBe(false);
  expect(e.hint).toBe("unable to verify the first certificate");
  expect(calls.length).toBe(1);
  expect(sleeps.length).toBe(0);
});

test("transport retries exhausted -> final timeout kind carrying the last error as cause", async () => {
  const boom = { name: "AbortError" };
  const { calls, fetchImpl } = scriptedFetch(() => { throw boom; });
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep, maxRetries: 1 }));
  expect(calls.length).toBe(2);
  expect(e.kind).toBe("timeout");
  expect(e.retryable).toBe(true);
  expect(e.message).toContain("after 2 attempts");
  expect(e.cause).toBe(boom);
  expect(sleeps.length).toBe(1);
});

test("deadline already passed -> immediate kind timeout, zero fetches", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(200, GOOD));
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, sleep, deadlineMs: Date.now() - 10 }));
  expect(e.kind).toBe("timeout");
  expect(e.retryable).toBe(false);
  expect(e.hint).toContain("--timeout");
  expect(e.hint).toContain("--request-timeout");
  expect(calls.length).toBe(0);
  expect(sleeps.length).toBe(0);
});

test("backoff is capped by the remaining deadline; an expired deadline aborts with kind timeout", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => { throw { code: "ECONNRESET" }; });
  const sleeps: number[] = [];
  // Real timers: actually waiting is what lets the deadline trip mid-run.
  const sleep = (ms: number): Promise<void> => { sleeps.push(ms); return new Promise<void>((r) => setTimeout(r, ms)); };
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", {
    fetchImpl, sleep, deadlineMs: Date.now() + 50, maxRetries: 30,
  }));
  expect(e.kind).toBe("timeout");
  expect(e.retryable).toBe(false);
  expect(calls.length).toBe(sleeps.length); // every fetch is followed by one capped sleep, then the check aborts
  expect(sleeps.length).toBeGreaterThanOrEqual(1);
  for (const s of sleeps) {
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(50); // never sleeps past the remaining deadline
  }
});

// ---- abort-delay + sleep integer contract (Node RangeError regression: WI-11) ----
// The production bug: the monotonic deadline conversion produced fractional ms
// (e.g. 14999.918084) and Node's AbortSignal.timeout threw RangeError — invisible
// under bun test, which accepts floats. These tests pin the CONTRACT: every delay
// crossing into an abort signal or a timer sleep is an integer.

test("abort-delay contract: deadline-budget path (limiter + deadlineMs) records positive INTEGER timeouts", async () => {
  const { calls, fetchImpl } = scriptedFetch((n) => {
    if (n === 0) throw { name: "AbortError" }; // retryable transport timeout -> second attempt
    return resp(200, GOOD);
  });
  const { sleeps, sleep } = sleepRecorder();
  const l = new RateLimiter(10, 2); // burst 2: pacing itself never delays the two attempts
  await withTimeoutRecorder(async (recorded) => {
    const r = await postSystemOne({}, BACKENDS.typesafe, "k", {
      fetchImpl, sleep, limiter: l, deadlineMs: Date.now() + 200,
    });
    expect(r.answers.c0.noul).toBe(0.9);
    expect(recorded.length).toBe(2); // one abort signal per attempt, both off the deadline budget
    expectPositiveIntegers(recorded); // would be fractional here without the floor
    expectNonNegativeIntegers(sleeps);
    expect(sleeps.length).toBe(1);
  });
  expect(calls.length).toBe(2);
});

test("abort-delay contract: default-deadline path and verifyApiKey record INTEGER ms timeouts", async () => {
  const ok = scriptedFetch(() => resp(200, GOOD));
  const ping = scriptedFetch(() => resp(200, { model: "jev-latest", answers: {} }));
  await withTimeoutRecorder(async (recorded) => {
    await postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: ok.fetchImpl });
    const v = await verifyApiKey(BACKENDS.typesafe, "k", { fetchImpl: ping.fetchImpl });
    expect(v.status).toBe("ok");
    expect(recorded).toEqual([DEFAULT_REQUEST_TIMEOUT_SEC * 1000, 15_000]); // requestTimeoutMs then VERIFY_TIMEOUT_MS
  });
});

test("FIX 0: fractional timer values never crash — the deadline-derived per-attempt timeout is integer-rounded (no RangeError)", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(200, GOOD));
  // requestTimeoutMs > the remaining deadline: the min() picks the FRACTIONAL deadline
  // remainder (deadline - performance.now() is never a whole ms) — the exact value that
  // made node's AbortSignal.timeout throw RangeError "out of range" at pristine HEAD
  // (bun coerces floats, so the suite never caught it).
  const r = await postSystemOne({ model: "m", questions: {} }, BACKENDS.typesafe, "k", {
    fetchImpl,
    deadlineMs: Date.now() + 1234,
    requestTimeoutMs: 5000,
  });
  expect(r.answers.c0.noul).toBe(0.9); // completed: no exception, let alone one mentioning "out of range"
  expect(calls.length).toBe(1);
  // The documented regression shape: deadline under the request timeout.
  const r2 = await postSystemOne({ model: "m", questions: {} }, BACKENDS.typesafe, "k", {
    fetchImpl, deadlineMs: Date.now() + 1234, requestTimeoutMs: 1000,
  });
  expect(r2.answers.c0.noul).toBe(0.9);
  expect(calls.length).toBe(2);
});

// ---- postSystemOne: default deadline (24h safety net) ----

test("default deadline: a bare call (no deadlineMs) is deadline-capped by 24h, not unbounded — a requestTimeoutMs beyond 24h proves the cap", async () => {
  const ok = scriptedFetch(() => resp(200, GOOD));
  await withTimeoutRecorder(async (recorded) => {
    // requestTimeoutMs LARGER than the 24h default: only a present deadline can cap
    // it, so the recorded abort delay proves the default deadline exists (a revert
    // to no-default-deadline would record the full 25h requestTimeoutMs instead).
    const r = await postSystemOne({ model: "m", questions: {} }, BACKENDS.typesafe, "k", {
      fetchImpl: ok.fetchImpl,
      requestTimeoutMs: 25 * 60 * 60 * 1000,
    });
    expect(r.answers.c0.noul).toBe(0.9);
    const limit = 24 * 60 * 60 * 1000;
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toBeLessThanOrEqual(limit);
    expect(recorded[0]).toBeGreaterThan(limit - 60_000); // within a minute of 24h — capped by the deadline, not by anything else
  });
});

// ---- postSystemOne: request shape, cost extraction ----

test("headers and URL: auth + OpenRouter attribution headers, URL from the backend", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(200, GOOD));
  await postSystemOne({ model: "m" }, BACKENDS.openrouter, "sekrit", { fetchImpl });
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe(BACKENDS.openrouter.url);
  expect(calls[0].init.method).toBe("POST");
  expect(calls[0].init.headers).toEqual({
    Authorization: "Bearer sekrit", "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/Emasoft/jgrep", "X-OpenRouter-Title": "jgrep", "X-Title": "jgrep", "X-OpenRouter-Categories": "cli-agent",
  });
});

test("cost extraction: cost beats usage.cost beats cost_usd; model passthrough", async () => {
  const a = scriptedFetch(() => resp(200, { answers: { c0: { type: "noul", noul: 0.1 } }, cost: 0.0042 }));
  expect((await postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: a.fetchImpl })).cost).toBe(0.0042);

  const b = scriptedFetch(() => resp(200, { answers: { c0: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 5, cost: 0.01 } }));
  const rb = await postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: b.fetchImpl });
  expect(rb.cost).toBe(0.01);
  expect(rb.usage?.input_tokens).toBe(5);

  const c = scriptedFetch(() => resp(200, { answers: { c0: { type: "noul", noul: 0.1 } }, cost_usd: 0.25 }));
  expect((await postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: c.fetchImpl })).cost).toBe(0.25);

  const d = scriptedFetch(() => resp(200, GOOD));
  const rd = await postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: d.fetchImpl });
  expect(rd.cost).toBeUndefined();
  expect(rd.model).toBeUndefined();

  const m = scriptedFetch(() => resp(200, { answers: { c0: { type: "noul", noul: 0.1 } }, model: "typesafe/jev-1.13" }));
  expect((await postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: m.fetchImpl })).model).toBe("typesafe/jev-1.13");
});

test("the caller's body object is never mutated", async () => {
  const { fetchImpl } = scriptedFetch(() => resp(200, GOOD));
  const body = { model: "jev-latest", state: { chunks: [{ id: "c0" }] }, questions: { c0: { type: "noul" } } };
  const snapshot = JSON.stringify(body);
  await postSystemOne(body, BACKENDS.typesafe, "k", { fetchImpl });
  expect(JSON.stringify(body)).toBe(snapshot);
});

// ---- RateLimiter ----

test("RateLimiter: ratePerSec <= 0 or non-finite resolves immediately", async () => {
  for (const rate of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const l = new RateLimiter(rate, 1);
    const t = Date.now();
    await l.acquire();
    await l.acquire();
    await l.acquire();
    expect(Date.now() - t).toBeLessThan(50);
  }
});

test("RateLimiter: burst 1 paces sequential acquires (second one waits for a refill)", async () => {
  const l = new RateLimiter(1000, 1);
  const t = Date.now();
  await l.acquire();
  await l.acquire(); // tokens are 0 after the first; must wait ~1ms of refill
  const elapsed = Date.now() - t;
  expect(elapsed).toBeGreaterThanOrEqual(1);
  expect(elapsed).toBeLessThan(200);
});

test("RateLimiter: burst is respected — free tokens up front, then a refill wait", async () => {
  const l = new RateLimiter(10, 2); // 1 token per 100ms -> a refill cannot race the gap
  const t = Date.now();
  await Promise.all([l.acquire(), l.acquire()]);
  expect(Date.now() - t).toBeLessThan(50); // burst of 2 up front
  const t2 = Date.now();
  await l.acquire();
  const waited = Date.now() - t2;
  expect(waited).toBeGreaterThanOrEqual(50);
  expect(waited).toBeLessThan(200);
});

test("RateLimiter: FIFO order across concurrent waiters", async () => {
  const l = new RateLimiter(1000, 1);
  const order: number[] = [];
  const ps = [1, 2, 3].map((i) => l.acquire().then(() => order.push(i)));
  await Promise.all(ps);
  expect(order).toEqual([1, 2, 3]);
});

test("RateLimiter: a queued waiter whose deadline lapses is evicted with kind timeout and the next live waiter gets the token", async () => {
  const l = new RateLimiter(10, 1); // one 100ms slot
  await l.acquire(); // empty the bucket
  const head = l.acquire({ deadlineMono: performance.now() + 30 }).then(() => "granted" as const, (e: unknown) => e);
  const next = l.acquire().then(() => "granted" as const, (e: unknown) => e);
  const headErr = (await head) as JevProviderError;
  expect(headErr).toBeInstanceOf(JevProviderError);
  expect(headErr.kind).toBe("timeout");
  expect(headErr.retryable).toBe(false);
  expect(await next).toBe("granted"); // the corpse's slot went to the next live waiter
  // the expired waiter never drained the bucket: pacing continues at the normal cadence
  const t = Date.now();
  await l.acquire();
  expect(Date.now() - t).toBeLessThan(200); // one slot, not two
});

test("RateLimiter: a new acquire evicts an already-expired waiter instead of queueing behind it", async () => {
  const l = new RateLimiter(1, 1); // 1s slots — the pump timer cannot fire during the test setup
  await l.acquire(); // empty the bucket
  const head = l.acquire({ deadlineMono: performance.now() + 30 }).then(() => "granted" as const, (e: unknown) => e);
  await new Promise<void>((r) => setTimeout(r, 40)); // head's deadline lapses; the pump has not run
  const t = Date.now();
  const late = l.acquire(); // arrival must evict the dead head, not queue behind it
  const headErr = (await head) as JevProviderError;
  expect(Date.now() - t).toBeLessThan(50); // rejected on arrival, not held until the pump
  expect(headErr).toBeInstanceOf(JevProviderError);
  expect(headErr.kind).toBe("timeout");
  expect(headErr.retryable).toBe(false);
  await late; // the live waiter still paces normally to its own refill slot
});

test("RateLimiter: an already-expired deadline rejects before waiting and consumes no token", async () => {
  const l = new RateLimiter(10, 2); // two tokens up front
  const e = await errOf(l.acquire({ deadlineMono: performance.now() - 10 }));
  expect(e).toBeInstanceOf(JevProviderError);
  expect(e.kind).toBe("timeout");
  expect(e.retryable).toBe(false);
  const t = Date.now();
  await Promise.all([l.acquire(), l.acquire()]); // both burst tokens still there -> no refill wait
  expect(Date.now() - t).toBeLessThan(50);
});

test("postSystemOne + limiter: an expired batch deadline is thrown by the limiter before pacing — zero fetches, zero tokens drained", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(200, GOOD));
  const l = new RateLimiter(10, 2);
  const e = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl, limiter: l, deadlineMs: Date.now() - 10 }));
  expect(e.kind).toBe("timeout");
  expect(e.retryable).toBe(false);
  expect(calls.length).toBe(0);
  const t = Date.now();
  await Promise.all([l.acquire(), l.acquire()]); // the dead attempt consumed no token
  expect(Date.now() - t).toBeLessThan(50);
});

// ---- verifyApiKey ----

test("verifyApiKey (no free check: compatible): ok path parses the model and sends the ping payload", async () => {
  const gw = { ...BACKENDS.compatible, url: "https://gw.example.com/v1/systemone" };
  const { calls, fetchImpl } = scriptedFetch(() => resp(200, { model: "jev-latest", answers: {} }));
  const r = await verifyApiKey(gw, "k", { fetchImpl });
  expect(r.status).toBe("ok");
  expect(r.http).toBe(200);
  expect(r.model).toBe("jev-latest");
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe(gw.url);
  expect(calls[0].init.method).toBe("POST");
  expect(JSON.parse(calls[0].init.body!)).toEqual({
    model: "jev-latest",
    state: "ping",
    questions: { ok: { type: "noul", instructions: "Is the state the word ping?" } },
  });
  expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer k", "Content-Type": "application/json" });
});

test("verifyApiKey: TypeSafe and Cloudflare keys are checked with their FREE GET route, never a billed ping", async () => {
  for (const [b, url] of [[BACKENDS.typesafe, "https://api.typesafe.ai/v1/models"], [BACKENDS.cloudflare, "https://api.cloudflare.com/client/v4/user/tokens/verify"]] as const) {
    const { calls, fetchImpl } = scriptedFetch(() => resp(200, { success: true }));
    expect((await verifyApiKey(b, "k", { fetchImpl })).status).toBe("ok");
    expect(calls.map((c) => [c.url, c.init.method, c.init.body])).toEqual([[url, "GET", undefined]]);
  }
});

test("verifyApiKey (review m2): OpenRouter is checked with the FREE GET /api/v1/key, never a billed ping", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(200, { data: { label: "sk-or-v1-abc...", limit: null } }));
  const r = await verifyApiKey(BACKENDS.openrouter, "k", { fetchImpl });
  expect(r.status).toBe("ok");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://openrouter.ai/api/v1/key");
  expect(calls[0].init.method).toBe("GET");
  expect(calls[0].init.body).toBeUndefined();
  expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer k" });
});

test("verifyApiKey (review m2): 402 is a VALID key with no credits; 401 rejected; network failure is unverified, not rejected", async () => {
  const credits = await verifyApiKey(BACKENDS.typesafe, "k", { fetchImpl: scriptedFetch(() => resp(402, "no credits")).fetchImpl });
  expect(credits.status).toBe("no_credits");
  const bad = await verifyApiKey(BACKENDS.openrouter, "k", { fetchImpl: scriptedFetch(() => resp(401, { error: { message: "User not found." } })).fetchImpl });
  expect(bad.status).toBe("rejected");
  expect(bad.http).toBe(401);
  const boom = await verifyApiKey(BACKENDS.typesafe, "k", { fetchImpl: scriptedFetch(() => { throw new Error("socket hang-up"); }).fetchImpl });
  expect(boom.status).toBe("unverified");
  expect(boom.http).toBe(0);
  expect(boom.detail).toContain("socket hang-up");
  const busy = await verifyApiKey(BACKENDS.openrouter, "k", { fetchImpl: scriptedFetch(() => resp(503, "down")).fetchImpl });
  expect(busy.status).toBe("unverified"); // the provider could not answer: the key is not known to be bad
});

test("verifyApiKey (review n4): the timeout follows the caller's request timeout", async () => {
  const ping = scriptedFetch(() => resp(200, { model: "jev-latest", answers: {} }));
  await withTimeoutRecorder(async (recorded) => {
    await verifyApiKey(BACKENDS.typesafe, "k", { fetchImpl: ping.fetchImpl, timeoutMs: 42_000 });
    expect(recorded).toEqual([42_000]);
  });
});

// ---- OpenRouter review follow-ups (live bodies captured 2026-10-02) ----------------

/** OpenRouter's real answer for a missing model: HTTP 400, an `error.message`, and a
 *  top-level `user_id` (redacted here) that must never reach jgrep's error output. */
const OR_MISSING_MODEL = { error: { message: "Model ~typesafe/jev-1.13 does not exist", code: 400 }, user_id: "user_REDACTED123" };

test("M2: OpenRouter 400 'Model X does not exist' -> model_unavailable (fatal), one call", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(400, OR_MISSING_MODEL));
  const e = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl }));
  expect(e.kind).toBe("model_unavailable");
  expect(e.hint).toContain("typesafe/jev-1.13");
  expect(calls.length).toBe(1);
});

test("m4: a JSON error body is reduced to error.message — the user_id never leaks into the message", async () => {
  const { fetchImpl } = scriptedFetch(() => resp(400, { error: { message: "expected record, received array", code: 400 }, user_id: "user_REDACTED123" }));
  const e = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl }));
  expect(e.kind).toBe("bad_request");
  expect(e.message).toContain("expected record, received array");
  expect(e.message).not.toContain("user_");
  const m = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl: scriptedFetch(() => resp(400, OR_MISSING_MODEL)).fetchImpl }));
  expect(m.message).not.toContain("user_");
});

test("m5: OpenRouter 403 -> forbidden (moderation / permission), non-fatal, not invalid_api_key", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(403, { error: { message: "Input flagged by moderation", code: 403 } }));
  const e = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl }));
  expect(e.kind).toBe("forbidden");
  expect(e.retryable).toBe(false);
  expect(e.hint).toMatch(/moderation/i);
  expect(e.hint).not.toContain("jgrep init");
  expect(calls.length).toBe(1);
  const { isFatalError } = await import("./errors");
  expect(isFatalError(e)).toBe(false); // one flagged chunk must not trip the breaker for the rest
});

test("m6: a Retry-After longer than the batch deadline reports rate_limited with the --rate hint, not timeout", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => resp(429, "slow down", { "Retry-After": "20" }));
  const { sleeps, sleep } = sleepRecorder();
  const e = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl, sleep, deadlineMs: Date.now() + 1000 }));
  expect(e.kind).toBe("rate_limited");
  expect(e.hint).toContain("--rate");
  expect(e.message).toContain("Retry-After");
  expect(calls.length).toBe(1);
  expect(sleeps.length).toBe(0); // no point sleeping into a deadline the wait cannot beat
});

test("n3: the insufficient_credits hint never suggests the backend already in use", async () => {
  const { fetchImpl } = scriptedFetch(() => resp(402, "no credits"));
  const ts = await errOf(postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl }));
  expect(ts.hint).not.toContain("--provider typesafe");
  expect(ts.hint).toContain("--provider openrouter");
  const or = await errOf(postSystemOne({}, BACKENDS.openrouter, "k", { fetchImpl }));
  expect(or.hint).toContain("--provider typesafe");
});

declare const Bun: { serve(o: { port: number; fetch(r: Request): Response | Promise<Response> }): { port: number; stop(force?: boolean): void } };

test("redirects are never followed: a 3xx endpoint fails fast (fatal, no retries) instead of carrying the key elsewhere", async () => {
  let hits = 0;
  const server = Bun.serve({ port: 0, fetch: () => { hits++; return new Response("", { status: 302, headers: { location: "https://example.com/steal" } }); } });
  try {
    const gw = { ...BACKENDS.compatible, url: `http://127.0.0.1:${server.port}/v1/systemone` };
    const e = await errOf(postSystemOne({}, gw, "k", { maxRetries: 3, sleep: async () => {} }));
    expect(e.retryable).toBe(false);
    expect(e.kind).toBe("server_unreachable");
    expect(e.hint).toContain("redirect");
    expect(hits).toBe(1);
    const { calls, fetchImpl } = scriptedFetch(() => resp(200, GOOD));
    await postSystemOne({}, BACKENDS.typesafe, "k", { fetchImpl });
    expect((calls[0].init as { redirect?: string }).redirect).toBe("error");
  } finally { server.stop(true); }
});
