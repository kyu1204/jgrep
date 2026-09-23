// Step 6 isolation tests: partial-failure isolation, batch deadlines, circuit
// breaker, failFast, cache persistence on partial failure, rate limiting —
// exercised through jgrep()/scoreRows() with the repo's fake-fetch DI pattern.
// Every run passes an explicit apiKey so key resolution never touches the
// filesystem or env.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { JevProviderError } from "./errors";
import type { Fetch } from "./providers";
import { jgrep, type Chunk } from "./jgrep";
import { flattenAnswers, scoreRows, type Questions, type Row } from "./rows";

// ---- fakes -------------------------------------------------------------------

/** n synthetic chunks with distinct file/text so requests can be told apart by content
 *  (request chunk ids are batch-local: every request numbers its chunks c0..cN). */
const nChunks = (n: number): Chunk[] =>
  Array.from({ length: n }, (_, i) => ({ file: `f${i}.ts`, start: 1, end: 2, text: `chunk ${i}` }));

/** Always-200 fake: answers every chunk with `p`, capturing parsed request bodies. */
const okFetch = (p = 0.9) => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: p };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

/** Always-200 fake for rows requests: answers the single `match` question per row. */
const okRowsFetch = (p = 0.9) => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.match`] = { type: "noul", noul: p };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 5 } }), { status: 200 });
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

/** Fake fetch that hangs forever and only rejects when the attempt signal aborts,
 *  rejecting with the signal's own reason so classification sees a real timeout. */
const hangFetch = (async (_url: unknown, init: { signal?: AbortSignal }) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    const abort = () => reject(signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (!signal || signal.aborted) abort();
    else signal.addEventListener("abort", abort);
  })) as unknown as Fetch;

// ---- jgrep: partial isolation + cache persistence ------------------------------

test("partial isolation: failing batch yields hits + server_unreachable ChunkErrors; good chunks still cached", async () => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    // Batch index 1 is the one carrying chunk file f2.ts (request ids are batch-local).
    if (body.state.chunks.some((c: any) => c.file === "f2.ts")) return new Response("boom", { status: 500 });
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as Fetch;
  const cache: Record<string, number> = {};
  const r = await jgrep("q", nChunks(4), { threshold: 0.7, batch: 2, concurrency: 2, maxRetries: 0, apiKey: "k", fetchImpl, cache });

  expect(calls).toHaveLength(2); // both batches attempted, the failed one is not retried (maxRetries 0)
  expect(r.hits.map((h) => h.file)).toEqual(["f0.ts", "f1.ts"]); // the other batch's hits survive
  expect(r.chunks).toBe(4);
  expect(r.errors.map((e) => e.file).sort()).toEqual(["f2.ts", "f3.ts"]); // exactly the batch-2 chunks
  expect(r.errors.every((e) => e.kind === "server_unreachable")).toBe(true);
  // Cache persistence on partial failure: the passed-in cache object gains the
  // successful chunks' entries (this is what cli.ts persists in a finally) and
  // NOTHING for the errored chunks.
  expect(Object.keys(cache)).toHaveLength(2);
  expect(r.all.map((h) => h.file)).toEqual(["f0.ts", "f1.ts"]); // errored chunks are absent from `all`
});

// ---- jgrep: batch guard ---------------------------------------------------------

test("batch guard: jgrep(batch: 0) terminates (normalized to 1 chunk per request)", async () => {
  // batch 0 would spin the batching loop forever (+= 0); the library clamps to 1.
  const { calls, fetchImpl } = okFetch();
  const r = await jgrep("q", nChunks(3), { threshold: 0.7, batch: 0, concurrency: 4, apiKey: "k", fetchImpl, cache: {} });
  expect(calls).toHaveLength(3);
  expect(calls.every((c) => c.state.chunks.length === 1)).toBe(true);
  expect(r.errors).toEqual([]);
  expect(r.hits).toHaveLength(3);
});

test("batch guard: a fractional batch is floored (no overlapping batches)", async () => {
  // 5 chunks with batch 2.5: floor -> 2 per request -> batches of 2, 2, 1.
  const { calls, fetchImpl } = okFetch();
  const r = await jgrep("q", nChunks(5), { threshold: 0.7, batch: 2.5, concurrency: 4, apiKey: "k", fetchImpl, cache: {} });
  expect(calls.map((c) => c.state.chunks.length).sort()).toEqual([1, 2, 2]);
  expect(r.errors).toEqual([]);
  expect(r.hits).toHaveLength(5);
});

// ---- jgrep: partial 200 answers are typed errors --------------------------------

test("partial 200: a chunk the provider does not answer becomes malformed_response, absent from all/hits", async () => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    // A 200 that answers every chunk EXCEPT f2.ts (batch ids are request-local c0..cN).
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) if (c.file !== "f2.ts") answers[c.id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as Fetch;
  const cache: Record<string, number> = {};
  const r = await jgrep("q", nChunks(4), { threshold: 0.7, batch: 2, concurrency: 2, apiKey: "k", fetchImpl, cache });

  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].kind).toBe("malformed_response");
  expect(r.errors[0].message).toContain("no usable answer");
  expect(r.errors[0].file).toBe("f2.ts");
  expect(r.all.map((h) => h.file)).toEqual(["f0.ts", "f1.ts", "f3.ts"]); // f2 absent, no p:NaN entry
  expect(r.hits.map((h) => h.file)).toEqual(["f0.ts", "f1.ts", "f3.ts"]);
  expect(r.chunks).toBe(4);
  expect(Object.keys(cache)).toHaveLength(3); // the unanswered chunk is not cached
});

// ---- jgrep: batch deadlines ----------------------------------------------------

test("deadline: timeoutSec 0 is already expired -> immediate kind timeout errors, zero fetch calls", async () => {
  const { calls, fetchImpl } = okFetch();
  const r = await jgrep("q", nChunks(4), { threshold: 0.7, batch: 2, concurrency: 2, timeoutSec: 0, maxRetries: 0, apiKey: "k", fetchImpl, cache: {} });
  expect(calls).toHaveLength(0); // the deadline is checked before any attempt
  expect(r.errors).toHaveLength(4);
  expect(r.errors.every((e) => e.kind === "timeout")).toBe(true);
  expect(r.hits).toHaveLength(0);
  expect(r.chunks).toBe(4);
});

test("deadline: timeoutSec 1 with hanging fetch and maxRetries 0 -> kind timeout, run completes", async () => {
  const r = await jgrep("q", nChunks(2), { threshold: 0.7, batch: 1, concurrency: 2, timeoutSec: 1, maxRetries: 0, apiKey: "k", fetchImpl: hangFetch, cache: {} });
  expect(r.errors).toHaveLength(2);
  expect(r.errors.every((e) => e.kind === "timeout")).toBe(true);
  expect(r.hits).toHaveLength(0);
  expect(r.chunks).toBe(2);
}, 15_000);

// ---- jgrep: circuit breaker ----------------------------------------------------

test("circuit breaker: 3 consecutive 402 batches abort; unprocessed chunks reported, 3 fetch calls total", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    calls.push(init.body);
    if (calls.length <= 3) return new Response("out of credits", { status: 402 }); // concurrency 1: call k == batch k-1
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as Fetch;
  const r = await jgrep("q", nChunks(12), { threshold: 0.7, batch: 2, concurrency: 1, apiKey: "k", fetchImpl, cache: {} });

  expect(calls).toHaveLength(3); // stopped dispatching after the third fatal
  expect(r.errors).toHaveLength(12); // chunks of the 3 failed batches + the 3 unprocessed batches
  expect(r.errors.filter((e) => e.kind === "insufficient_credits")).toHaveLength(6);
  expect(r.errors.filter((e) => e.kind === "circuit_breaker_open")).toHaveLength(6);
  expect(r.errors.filter((e) => e.kind === "circuit_breaker_open").every((e) => e.message.includes("circuit breaker"))).toBe(true);
  expect(r.chunks).toBe(12);
  expect(r.hits).toHaveLength(0);
});

// ---- jgrep: failFast -----------------------------------------------------------

test("failFast: one 402 batch makes jgrep() reject with the provider error", async () => {
  const fetchImpl = (async () => new Response("out of credits", { status: 402 })) as unknown as Fetch;
  let caught: unknown;
  try {
    await jgrep("q", nChunks(2), { threshold: 0.7, batch: 2, concurrency: 1, failFast: true, apiKey: "k", fetchImpl, cache: {} });
  } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(JevProviderError);
  const err = caught as JevProviderError;
  expect(err.kind).toBe("insufficient_credits");
  expect(err.provider).toBe("typesafe");
});

// ---- jgrep: failFast invalid_api_key hint distinguishes expired vs wrong key ------

test("failFast: a 401 after one successful batch amends the hint — key worked earlier this run", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    calls.push(init.body);
    if (calls.length === 1) { // concurrency 1: call 1 == batch 0, which must succeed first
      const body = JSON.parse(init.body);
      const answers: Record<string, unknown> = {};
      for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.9 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    }
    return new Response("expired", { status: 401 });
  }) as unknown as Fetch;
  let caught: unknown;
  try {
    await jgrep("q", nChunks(4), { threshold: 0.7, batch: 2, concurrency: 1, failFast: true, apiKey: "k", fetchImpl, cache: {} });
  } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(JevProviderError);
  const err = caught as JevProviderError;
  expect(err.kind).toBe("invalid_api_key");
  expect(err.hint).toContain("worked earlier this run");
  expect(err.hint).toContain("expired or revoked");
  // the base hint survives the amendment
  expect(err.hint).toContain("TYPESAFE_API_KEY");
});

test("failFast: a 401 as the very first batch keeps the base hint — no earlier-success claim", async () => {
  const fetchImpl = (async () => new Response("bad key", { status: 401 })) as unknown as Fetch;
  let caught: unknown;
  try {
    await jgrep("q", nChunks(2), { threshold: 0.7, batch: 2, concurrency: 1, failFast: true, apiKey: "k", fetchImpl, cache: {} });
  } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(JevProviderError);
  const err = caught as JevProviderError;
  expect(err.kind).toBe("invalid_api_key");
  expect(err.hint).toBeDefined();
  expect(err.hint).not.toContain("worked earlier this run");
});

// ---- jgrep: back-compat on the clean path --------------------------------------

test("back-compat: a clean run keeps hits/tokens and reports errors: []", async () => {
  const { calls, fetchImpl } = okFetch();
  const r = await jgrep("q", nChunks(3), { threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", fetchImpl, cache: {} });
  expect(calls).toHaveLength(2); // 3 chunks, batch 2
  expect(r.errors).toEqual([]);
  expect(r.hits).toHaveLength(3);
  expect(r.tokens).toBe(20); // 2 requests x 10 tokens
});

// ---- jgrep: rate limiting ------------------------------------------------------

test("ratePerSec: a paced run completes with correct results (bucket math is unit-tested)", async () => {
  const { calls, fetchImpl } = okFetch();
  const r = await jgrep("q", nChunks(6), { threshold: 0.7, batch: 2, concurrency: 4, ratePerSec: 1000, apiKey: "k", fetchImpl, cache: {} });
  expect(calls).toHaveLength(3);
  expect(r.errors).toEqual([]);
  expect(r.hits).toHaveLength(6);
});

// ---- rows ----------------------------------------------------------------------

test("rows: a failed pack yields RowErrors; other rows still answered and cached", async () => {
  const rows: Row[] = [{ handle: "@a" }, { handle: "@b" }, { handle: "@c" }, { handle: "@d" }];
  const questions: Questions = { match: { type: "noul", instructions: "q" } };
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    // The second pack carries row @c (row ids are pack-local: r0..rN).
    if (body.state.rows.some((r: any) => r.handle === "@c")) return new Response("boom", { status: 500 });
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.match`] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 5 } }), { status: 200 });
  }) as unknown as Fetch;
  const cache: Record<string, unknown> = {};
  const r = await scoreRows(rows, questions, { batch: 2, concurrency: 2, maxRetries: 0, apiKey: "k", fetchImpl, cache });

  expect(r.errors.map((e) => e.row).sort((a, b) => a - b)).toEqual([2, 3]);
  expect(r.errors.every((e) => e.kind === "server_unreachable")).toBe(true);
  expect(r.answers[0]?.match?.noul).toBe(0.9);
  expect(r.answers[1]?.match?.noul).toBe(0.9);
  expect(r.answers[2]).toBeNull(); // errored rows are not answered (null, never a hole)
  expect(r.answers[3]).toBeNull();
  expect(Object.keys(cache)).toHaveLength(2); // complete rows cached, errored rows not
});

test("rows batch guard: a fractional batch is floored (no overlapping packs)", async () => {
  // 3 rows with batch 1.5: floor -> 1 row per pack (a raw 1.5 would put @b in two packs).
  const rows: Row[] = [{ handle: "@a" }, { handle: "@b" }, { handle: "@c" }];
  const { calls, fetchImpl } = okRowsFetch();
  const r = await scoreRows(rows, { match: { type: "noul", instructions: "q" } }, { batch: 1.5, concurrency: 3, apiKey: "k", fetchImpl, cache: {} });
  expect(calls.map((c) => c.state.rows.length).sort()).toEqual([1, 1, 1]);
  expect(r.errors).toEqual([]);
  expect(r.requests).toBe(3);
  expect(r.answers.every((a) => a?.match?.noul === 0.9)).toBe(true);
});

test("rows back-compat: a clean run reports errors: [] with unchanged answers", async () => {
  const { fetchImpl } = okRowsFetch();
  const r = await scoreRows(
    [{ handle: "@a" }, { handle: "@b" }],
    { match: { type: "noul", instructions: "q" } },
    { batch: 2, concurrency: 2, apiKey: "k", fetchImpl, cache: {} },
  );
  expect(r.errors).toEqual([]);
  expect(r.cached).toBe(0);
  expect(r.requests).toBe(1);
  expect(r.answers[0]?.match?.noul).toBe(0.9);
  expect(r.answers[1]?.match?.noul).toBe(0.9);
});

// ---- rows: circuit breaker ------------------------------------------------------

test("circuit breaker (rows): requests counts only dispatched packs — unprocessed packs excluded", async () => {
  // 12 rows -> 6 packs of 2; 3 consecutive fatal 402s (concurrency 1) trip the breaker,
  // leaving 3 packs never attempted. `requests` must equal what was actually dispatched.
  const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ handle: `@r${i}` }));
  const questions: Questions = { match: { type: "noul", instructions: "q" } };
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    calls.push(init.body);
    return new Response("out of credits", { status: 402 });
  }) as unknown as Fetch;
  const r = await scoreRows(rows, questions, { batch: 2, concurrency: 1, apiKey: "k", fetchImpl, cache: {} });

  expect(calls).toHaveLength(3); // the breaker stopped dispatching after 3 consecutive fatals
  expect(r.requests).toBe(3); // requests === dispatched (6 packs - 3 unprocessed)
  expect(r.errors.filter((e) => e.kind === "insufficient_credits")).toHaveLength(6);
  expect(r.errors.filter((e) => e.kind === "circuit_breaker_open")).toHaveLength(6);
  expect(r.answers.every((a) => a === null)).toBe(true);
});

// ---- rows: dense answers on partial failure ------------------------------------
// `answers` used to be a holey array (errored rows unset), so rowsMain's
// `r.answers.map(flatten)` skipped the holes and `Number(flat[i].match)` threw a
// TypeError on the desynced index. Errored rows are null now — dense, aligned.

test("rows: a partial failure leaves a DENSE answers array; flattenAnswers maps without throwing", async () => {
  const rows: Row[] = [{ handle: "@a" }, { handle: "@b" }, { handle: "@c" }, { handle: "@d" }];
  const questions: Questions = { match: { type: "noul", instructions: "q" } };
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    // The second pack carries row @c (row ids are pack-local: r0..rN).
    if (body.state.rows.some((r: any) => r.handle === "@c")) return new Response("boom", { status: 500 });
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.match`] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 5 } }), { status: 200 });
  }) as unknown as Fetch;
  const r = await scoreRows(rows, questions, { batch: 2, concurrency: 2, maxRetries: 0, apiKey: "k", fetchImpl, cache: {} });

  expect(r.errors.map((e) => e.row).sort((a, b) => a - b)).toEqual([2, 3]);
  // dense, not holey: Object.keys() counts every index once each index is owned
  expect(r.answers.length).toBe(4);
  expect(Object.keys(r.answers).length).toBe(4);

  // rowsMain-equivalent flatten mapping: total, position-aligned, never throws
  const flat = flattenAnswers(r);
  expect(flat.length).toBe(4);
  expect(Object.keys(flat).length).toBe(4);
  expect(flat[0]).toEqual({ match: 0.9 });
  expect(flat[1]).toEqual({ match: 0.9 });
  expect(flat[2]).toBeNull();
  expect(flat[3]).toBeNull();
  // the single-description mapping that used to crash on holes (`Number(flat[i].match)`
  // with flat[i] undefined) is safe now: errored rows map to NaN and get skipped
  const ps = rows.map((_, i) => Number(flat[i]?.match ?? NaN));
  expect(ps.filter(Number.isFinite)).toEqual([0.9, 0.9]);
});
