// --tag (WI-4) hit tagging: one `choice` question per STANDING hit (after --verify
// filtering), batched <=16 hits per request through the same pool/postSystemOne
// machinery as the verify pass, the winning criterion riding on the hit as
// tag/tag_p. The deliberate error policy — a failed tag batch leaves those hits
// untagged and records NOTHING in errors[] — is pinned here too. Same fake-fetch DI
// pattern as verify.test.ts / funcs.test.ts (explicit apiKey everywhere, so the lazy
// key resolver never touches the filesystem); the CLI scenarios run the real
// entrypoint against a localhost-only fake gateway — no network, no key files,
// --no-cache so ~/.jgrep/cache.json stays out of it.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import { VERIFY_PREFIX } from "./jgrep";
import { buildTagRequest, jgrep, jgrepFuncs, parseTagCategories, TAG_BATCH_MAX, type Chunk } from "./jgrep";
import type { Fetch } from "./providers";

process.env.JGREP_NO_MAIN = "1";
const { parse, USAGE } = await import("./cli");

declare const Bun: {
  serve(opts: { port?: number; fetch(req: Request): Response | Promise<Response> }): {
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
  spawn(cmd: string[], opts?: { env?: Record<string, string | undefined>; stdout?: "pipe"; stderr?: "pipe" }): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
  spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined> }): {
    exitCode: number | null;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
};

// ---- fakes --------------------------------------------------------------------

interface TagAnswer { choice: string; probabilities: Record<string, number> }

/** Fake Jev: every noul question answers `mainP`; every choice question (the tag
 *  pass) answers from `tagAnswers` in question order across the tag batches. Set
 *  failTag to kill tag requests with a transport error (retries exhausted at 0). */
const mkFetch = (mainP: number, tagAnswers: TagAnswer[] = [], opts: { failTag?: boolean } = {}) => {
  const calls: Record<string, any>[] = [];
  let ti = 0;
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const qids = Object.keys(body.questions);
    const answers: Record<string, unknown> = {};
    if (body.questions[qids[0]]?.type === "choice") {
      if (opts.failTag) throw new Error("connection reset"); // same failure shape as verify.test.ts
      for (const id of qids) answers[id] = { type: "choice", ...tagAnswers[ti++] };
    } else {
      for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: mainP };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

const isTagRequest = (b: Record<string, any>) => Object.values<any>(b.questions).some((q) => q.type === "choice");

const mk = (file: string, start: number, end: number, text: string): Chunk => ({ file, start, end, text });
const twoChunks = [
  mk("a.ts", 1, 3, "export function alpha() {\n  return 1;\n}"),
  mk("b.ts", 9, 11, "export function beta() {\n  return 2;\n}"),
];
const opts = (over: Record<string, unknown> = {}) => ({ threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", ...over });

/** Async spawn: Bun.spawnSync blocks this process's event loop, which would deadlock
 *  the in-process fake gateway (cli.test.ts pattern). */
const spawn = async (args: string[], env: Record<string, string | undefined>) => {
  const proc = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};

/** Jev System One fake: noul questions answer 0.9; choice questions (the tag pass)
 *  answer t0/t1 from `tagBehavior` — or the whole tag request fails with a 500. */
const startTagGateway = (tagBehavior: "ok" | "fail") =>
  Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body: { state: { chunks?: { id: string }[] }; questions: Record<string, { type: string }> } = await req.json();
      const answers: Record<string, unknown> = {};
      const qids = Object.keys(body.questions ?? {});
      if (qids.length > 0 && body.questions[qids[0]].type === "choice") {
        if (tagBehavior === "fail") return new Response("tag endpoint down", { status: 500 });
        for (const id of qids) answers[id] = { type: "choice", choice: `t${Number(id.slice(1)) % 2}`, probabilities: { t0: 0.8, t1: 0.6 } };
      } else {
        for (const c of body.state.chunks ?? []) answers[c.id] = { type: "noul", noul: 0.9 };
      }
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    },
  });

const gatewayEnv = (port: number) => ({
  ...process.env, JGREP_NO_MAIN: "",
  JEV_GATEWAY_URL: `http://127.0.0.1:${port}/v1/systemone`, JEV_GATEWAY_API_KEY: "test-key",
});

// ---- core: request shape + answer mapping ---------------------------------------

test("parseTagCategories: splits on commas, trims, drops empties", () => {
  expect(parseTagCategories("real bug, idiomatic")).toEqual(["real bug", "idiomatic"]);
  expect(parseTagCategories(" a , ,b,")).toEqual(["a", "b"]);
  expect(parseTagCategories("")).toEqual([]);
  expect(TAG_BATCH_MAX).toBe(16);
});

test("--tag: one tag request with a choice question per hit, criteria keys t0/t1; answers map back to tag/tag_p", async () => {
  const { calls, fetchImpl } = mkFetch(0.9, [
    { choice: "t0", probabilities: { t0: 0.8, t1: 0.2 } },
    { choice: "t1", probabilities: { t0: 0.4, t1: 0.6 } },
  ]);
  const r = await jgrep("returns a number", twoChunks, { ...opts({ tag: "real bug,idiomatic" }), fetchImpl, cache: {} });
  expect(r.hits).toHaveLength(2);
  expect(calls).toHaveLength(2); // the main batch + exactly ONE tag request
  const tag = calls[1];
  expect(tag.model).toBe("jev-latest");
  expect(tag.state.chunks.map((c: any) => c.id)).toEqual(["h0", "h1"]);
  expect(tag.state.chunks.map((c: any) => c.file)).toEqual(["a.ts", "b.ts"]);
  expect(Object.keys(tag.questions)).toEqual(["h0", "h1"]); // one choice question per hit
  expect(tag.questions.h0.type).toBe("choice");
  expect(tag.questions.h0.instructions).toBe("Which category best fits the code in chunk h0? Choose exactly one.");
  expect(tag.questions.h1.instructions).toBe("Which category best fits the code in chunk h1? Choose exactly one.");
  expect(Object.keys(tag.questions.h0.criteria)).toEqual(["t0", "t1"]); // categories keyed t0..tN
  expect(tag.questions.h0.criteria).toEqual({ t0: "real bug", t1: "idiomatic" });
  expect(tag.questions.h1.criteria).toEqual({ t0: "real bug", t1: "idiomatic" });
  // answers mapped back: hit 0 -> "real bug" p 0.8, hit 1 -> "idiomatic" p 0.6
  expect(r.hits[0].tag).toBe("real bug");
  expect(r.hits[0].tag_p).toBe(0.8);
  expect(r.hits[1].tag).toBe("idiomatic");
  expect(r.hits[1].tag_p).toBe(0.6);
  expect(r.errors).toEqual([]);
});

test("buildTagRequest: batch-local h{i} ids, kind-keyed chunk bodies, one criteria object per question", () => {
  const req = buildTagRequest([{ ...mk("a.ts", 2, 9, "const x = 1;"), p: 0.9 }], ["real bug", "idiomatic"], "diff", "m");
  expect(req.model).toBe("m");
  expect(req.state.chunks).toEqual([{ id: "h0", file: "a.ts", lines: "2-9", diff: "const x = 1;" }]);
  expect(req.questions.h0).toEqual({
    type: "choice",
    instructions: "Which category best fits the code in chunk h0? Choose exactly one.",
    criteria: { t0: "real bug", t1: "idiomatic" },
  });
});

test("--tag: a provider that echoes the category NAME (not the t{i} key) maps the same; an unusable answer leaves the hit untagged", async () => {
  const { calls, fetchImpl } = mkFetch(0.9, [
    { choice: "real bug", probabilities: { "real bug": 0.9 } },
    { choice: "", probabilities: {} }, // unusable: no name, no probability
  ]);
  const r = await jgrep("returns a number", twoChunks, { ...opts({ tag: "real bug,idiomatic" }), fetchImpl, cache: {} });
  expect(calls).toHaveLength(2);
  expect(r.hits[0].tag).toBe("real bug");
  expect(r.hits[0].tag_p).toBe(0.9);
  expect(r.hits[1].tag).toBeUndefined(); // untagged, not a crash
  expect(r.hits[1].tag_p).toBeUndefined();
  expect(r.errors).toEqual([]);
});

// ---- error policy: a failed tag batch degrades to untagged hits -------------------

test("--tag: a failed tag batch leaves the hits untagged — no tags, no errors, the search result stands", async () => {
  const { calls, fetchImpl } = mkFetch(0.9, [], { failTag: true });
  const r = await jgrep("returns a number", twoChunks, { ...opts({ tag: "real bug,idiomatic", maxRetries: 0 }), fetchImpl, cache: {} });
  expect(calls).toHaveLength(2); // the search answered; the tag batch died after its one attempt
  expect(r.hits.map((h) => h.p)).toEqual([0.9, 0.9]); // hits unchanged
  expect(r.hits.every((h) => h.tag === undefined && h.tag_p === undefined)).toBe(true);
  expect(r.errors).toEqual([]); // recorded NOTHING (deliberate error policy, documented in jgrep.ts)
  expect(r.chunks).toBe(2);
});

// ---- ordering: after --verify; batching: <=16 hits per request --------------------

test("--tag runs AFTER --verify filtering: only standing hits get tag questions", async () => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const qids = Object.keys(body.questions);
    const answers: Record<string, unknown> = {};
    if (isTagRequest(body)) {
      answers[qids[0]] = { type: "choice", choice: "t1", probabilities: { t0: 0.3, t1: 0.7 } };
    } else if (qids.some((id) => body.questions[id].instructions.startsWith(VERIFY_PREFIX))) {
      for (const id of qids) answers[id] = { type: "noul", noul: Number(id.slice(1)) === 0 ? 0.9 : 0.1 };
    } else {
      for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.9 };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as Fetch;
  const r = await jgrep("returns a number", twoChunks, { ...opts({ verify: true, tag: "real bug,idiomatic" }), fetchImpl, cache: {} });
  expect(r.hits.map((h) => h.file)).toEqual(["a.ts"]); // the verify-dropped hit never reaches the tag pass
  expect(calls).toHaveLength(3); // main + verify + ONE tag request
  const tag = calls[2];
  expect(isTagRequest(tag)).toBe(true);
  expect(Object.keys(tag.questions)).toEqual(["h0"]); // one question for the ONE standing hit
  expect(r.hits[0].tag).toBe("idiomatic");
  expect(r.hits[0].tag_p).toBe(0.7);
});

test("--tag batches <=16 hits per request even when --batch was raised", async () => {
  const chunks = Array.from({ length: 20 }, (_, i) => mk(`f${i}.ts`, 1, 2, `chunk ${i}`));
  const answers: TagAnswer[] = Array.from({ length: 20 }, () => ({ choice: "t0", probabilities: { t0: 0.8, t1: 0.2 } }));
  const { calls, fetchImpl } = mkFetch(0.9, answers);
  const r = await jgrep("chunk", chunks, { ...opts({ batch: 64, tag: "real bug,idiomatic" }), fetchImpl, cache: {} });
  expect(r.hits).toHaveLength(20);
  expect(calls).toHaveLength(3); // ONE main request (batch 64) + 2 tag requests (16 + 4)
  const tagReqs = calls.filter(isTagRequest);
  expect(tagReqs.map((b) => Object.keys(b.questions).length)).toEqual([16, 4]);
  expect(r.hits.every((h) => h.tag === "real bug" && h.tag_p === 0.8)).toBe(true);
});

test("--tag: hits = 0 -> no tag request at all", async () => {
  const { calls, fetchImpl } = mkFetch(0.1); // everything below the threshold
  const r = await jgrep("returns a number", twoChunks, { ...opts({ tag: "real bug,idiomatic" }), fetchImpl, cache: {} });
  expect(r.hits).toEqual([]);
  expect(calls).toHaveLength(1); // only the main pass
});

test("--tag with --funcs: pass 1 never tags (its hits are only a shortlist); pass 2 tags the real hits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-tagfuncs-"));
  try {
    fs.writeFileSync(path.join(dir, "retry.ts"),
      "export function retryWithBackoff(op: () => Promise<void>, tries: number) {\n  // sleeps with exponential backoff between attempts\n  return attempt(op, tries);\n}\n");
    const calls: Record<string, any>[] = [];
    // Passes 1/2 judge by content (/backoff/); the tag pass gets its scripted answer.
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const qids = Object.keys(body.questions);
      const answers: Record<string, unknown> = {};
      if (isTagRequest(body)) answers[qids[0]] = { type: "choice", choice: "t0", probabilities: { t0: 0.8, t1: 0.2 } };
      // case-insensitive: the signature chunk carries "retryWithBackoff" (capital B),
      // the pass-2 code chunk carries the lowercase "backoff" comment.
      else for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: /backoff/i.test(c.code) ? 0.9 : 0.05 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    }) as unknown as Fetch;
    const r = await jgrepFuncs("retries with backoff", [path.join(dir, "retry.ts")], { ...opts({ tag: "real bug,idiomatic" }), fetchImpl, cache: {} });
    const tagReqs = calls.filter(isTagRequest);
    expect(tagReqs).toHaveLength(1); // pass 2 only — pass 1's shortlist hits are never tagged
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].tag).toBe("real bug");
    expect(r.hits[0].tag_p).toBe(0.8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CLI surface ------------------------------------------------------------------

test("cli parse: --tag needs >= 2 categories — 1 is a usage error; the raw list passes through", () => {
  expect(parse(["--tag", "real bug, idiomatic", "q"]).tag).toBe("real bug, idiomatic");
  expect(() => parse(["--tag", "solo", "q"])).toThrow(/--tag needs at least 2 comma-separated categories/);
  expect(() => parse(["--tag", "solo,", "q"])).toThrow(/got 1/); // empties do not count as a category
  expect(() => parse(["--tag", "", "q"])).not.toThrow(); // empty = flag not effectively passed
});

test("cli main: --tag with 1 category exits 2 with the usage error before any request", async () => {
  const p = await spawn(["bun", "src/cli.ts", "--tag", "solo", "q"], { ...process.env, JGREP_NO_MAIN: "" });
  expect(p.exitCode).toBe(2);
  expect(p.stderr).toContain("--tag needs at least 2 comma-separated categories");
});

// The cap was 60 lines while --help was a bare flag list; 0.7.0 groups the flags and adds
// env vars, examples and use cases (the help is also embedded in the agent skill), so the
// cap is 145: room for that, while still catching a help that balloons. It was 140, and the
// sixth built-in (`mlx`, one env line) pushed it over — the fix is the cap, not deleting a
// documented use case to squeeze under it: a help that hides a feature to stay short is
// worse than a help five lines longer.
test("USAGE documents --tag on one line and stays within the 145-line help cap", () => {
  const line = USAGE.split("\n").find((l) => l.includes("--tag"));
  expect(line).toBeDefined();
  expect(line).toContain("[tag]");
  expect(USAGE.split("\n").length).toBeLessThanOrEqual(145);
});

// ---- CLI end-to-end over the fake gateway ------------------------------------------

test("cli e2e: --tag text output shows [tag] after the p column; --json carries tag/tag_p", async () => {
  const server = startTagGateway("ok");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-tag-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "export function beta() {\n  return 2;\n}\n");
    const text = await spawn(
      ["bun", "src/cli.ts", "--tag", "real bug,idiomatic", "--no-cache", "--provider", "compatible", "returns a number", dir],
      gatewayEnv(server.port),
    );
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("[real bug]");
    expect(text.stdout).toContain("[idiomatic]");
    expect(text.stdout).toMatch(/p=0\.90 \[real bug\]/); // directly after the p column
    expect(text.stdout).toMatch(/p=0\.90 \[idiomatic\]/);

    const json = JSON.parse((await spawn(
      ["bun", "src/cli.ts", "--json", "--tag", "real bug,idiomatic", "--no-cache", "--provider", "compatible", "returns a number", dir],
      gatewayEnv(server.port),
    )).stdout);
    expect(json).toHaveLength(2);
    for (const h of json) expect(Object.keys(h).sort()).toEqual(["end", "file", "p", "start", "tag", "tag_p", "text"]);
    expect(json[0].file).toContain("a.ts"); // h0 = the first hit in file order
    expect(json[0].tag).toBe("real bug");
    expect(json[0].tag_p).toBe(0.8);
    expect(json[1].tag).toBe("idiomatic");
    expect(json[1].tag_p).toBe(0.6);
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli e2e: a failing tag endpoint leaves the hits clean — same output shape, exit 0, no error kinds", async () => {
  const server = startTagGateway("fail");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-tagfail-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--json", "--tag", "real bug,idiomatic", "--no-cache", "--retries", "0", "--timeout", "2",
       "--provider", "compatible", "returns a number", dir],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(0); // exit semantics unchanged: hits, no errors
    const hits = JSON.parse(p.stdout);
    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0]).sort()).toEqual(["end", "file", "p", "start", "text"]); // bare v0.3.0 shape: no tags
    expect(p.stderr).not.toContain("errored"); // nothing recorded (deliberate error policy)
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
