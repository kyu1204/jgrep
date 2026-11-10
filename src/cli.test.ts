// Step 7 CLI-surface tests: parse() flag types/defaults/numeric validation, the
// --provider choice enumeration (validated in main() via resolveChain), and hermetic
// end-to-end error rendering through the real entrypoint. The subprocess scenarios
// all fail during argument/provider resolution — before any cache IO or network
// call — so only stderr/exit-code are observed.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { JevProviderError } from "./errors";

declare const process: { env: Record<string, string | undefined> };
declare const Bun: {
  spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined> }): {
    exitCode: number | null;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
  spawn(cmd: string[], opts?: {
    env?: Record<string, string | undefined>;
    stdout?: string;
    stderr?: string;
  }): { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> };
  serve(opts: { port?: number; fetch(req: Request): Response | Promise<Response> }): {
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
};

process.env.JGREP_NO_MAIN = "1";
const { parse } = await import("./cli");
const { resolveChain } = await import("./providers");

// ---- parse(): new flags --------------------------------------------------------

test("cli parse: new flags parse with correct types and defaults", () => {
  const o = parse(["q"]);
  expect(o).toMatchObject({ provider: "", model: "", timeout: 15, requestTimeout: 30, retries: 4, rate: 0, failFast: false, estimateOnly: false });
  expect(typeof o.timeout).toBe("number");
  expect(typeof o.retries).toBe("number");
  expect(typeof o.failFast).toBe("boolean");
  expect(typeof o.estimateOnly).toBe("boolean");

  const o2 = parse(["--provider", "openrouter", "--model", "typesafe/jev-1.13", "--timeout", "30", "--request-timeout", "60", "--retries", "2", "--rate", "5", "--fail-fast", "--estimate", "q", "src/"]);
  expect(o2).toMatchObject({
    provider: "openrouter", model: "typesafe/jev-1.13", timeout: 30, requestTimeout: 60,
    retries: 2, rate: 5, failFast: true, estimateOnly: true, question: "q", paths: ["src/"],
  });
});

test("cli parse: --provider accepts any string; main()'s resolveChain rejects unknown, listing the configured providers", () => {
  const o = parse(["--provider", "unknown", "q"]);
  expect(o.provider).toBe("unknown"); // parse itself does not validate — main() does, for the typed error
  let caught: unknown;
  try { resolveChain({ pin: o.provider, version: "t" }); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(JevProviderError);
  const err = caught as JevProviderError;
  expect(err.kind).toBe("bad_request");
  for (const choice of ["openrouter", "typesafe", "compatible", "cloudflare", "vercel"]) expect(err.message).toContain(choice);
});

test("cli parse: per-option numeric ranges (deadline > 0; counts are whole)", () => {
  // threshold and rate keep the plain finite/non-negative rule (rate 0 = unlimited)
  expect(() => parse(["--threshold", "abc", "q"])).toThrow(/numeric option expected/);
  expect(() => parse(["--threshold", "-1", "q"])).toThrow(/numeric option expected/);
  expect(() => parse(["--rate", "abc", "q"])).toThrow(/numeric option expected/);
  expect(() => parse(["--rate", "-1", "q"])).toThrow(/numeric option expected/);
  expect(() => parse(["--rate", "0", "q"])).not.toThrow(); // 0 = unlimited stays legal
  // a zero deadline is meaningless: both timeouts must be positive
  expect(() => parse(["--timeout", "0", "q"])).toThrow(/timeout must be a positive number/);
  expect(() => parse(["--timeout", "-1", "q"])).toThrow(/timeout must be a positive number/);
  expect(() => parse(["--timeout", "abc", "q"])).toThrow(/timeout must be a positive number/);
  expect(() => parse(["--timeout", "15", "q"])).not.toThrow();
  expect(() => parse(["--request-timeout", "0", "q"])).toThrow(/request-timeout must be a positive number/);
  expect(() => parse(["--request-timeout", "30", "q"])).not.toThrow();
  // concurrency counts parallel requests: a positive integer
  expect(() => parse(["-c", "0", "q"])).toThrow(/concurrency must be a positive integer/);
  expect(() => parse(["-c", "1.5", "q"])).toThrow(/concurrency must be a positive integer/);
  expect(() => parse(["-c", "1", "q"])).not.toThrow();
  // retries count tolerated failures: a non-negative integer (0 = no retries)
  expect(() => parse(["--retries", "-1", "q"])).toThrow(/retries must be a non-negative integer/);
  expect(() => parse(["--retries", "1.5", "q"])).toThrow(/retries must be a non-negative integer/);
  expect(() => parse(["--retries", "0", "q"])).not.toThrow();
});

test("cli parse: --batch must be a positive integer — 0 would spin the batching loop, a fraction overlaps batches", () => {
  expect(() => parse(["-b", "0", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["--batch", "0", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["-b", "1.5", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["-b", "2.5", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["-b", "abc", "q"])).toThrow(/batch must be a positive integer/); // NaN reaches the batch check
  expect(() => parse(["-b", "-1", "q"])).toThrow(/batch must be a positive integer/); // integer but < 1
  expect(() => parse(["-b", "1", "q"])).not.toThrow();
  expect(() => parse(["-b", "16", "q"])).not.toThrow();
});

test("cli parse: old and new flags coexist (--diff positional heuristic untouched)", () => {
  const o = parse(["--diff", "--json", "--fail-fast", "--provider", "openrouter", "--staged", "q"]);
  expect(o).toMatchObject({ json: true, failFast: true, provider: "openrouter", diff: ["--staged"], question: "q" });
  const o2 = parse(["--diff", "origin/main", "--estimate", "--rate", "10", "q", "src/"]);
  expect(o2).toMatchObject({ diff: ["origin/main"], estimateOnly: true, rate: 10, question: "q", paths: ["src/"] });
});

test("cli: JGREP_NO_MAIN import pattern still works (parse importable, main not auto-run)", () => {
  expect(typeof parse).toBe("function");
});

test("cli parse: --json-errors implies --json; --json alone keeps the array shape", () => {
  expect(parse(["q"])).toMatchObject({ json: false, jsonErrors: false });
  expect(parse(["--json", "q"])).toMatchObject({ json: true, jsonErrors: false });
  expect(parse(["--json-errors", "q"])).toMatchObject({ json: true, jsonErrors: true });
  expect(parse(["--json", "--json-errors", "q"])).toMatchObject({ json: true, jsonErrors: true });
  expect(parse(["--json-errors", "--diff", "--staged", "q"])).toMatchObject({ json: true, jsonErrors: true, diff: ["--staged"] });
});

// ---- main() via the real entrypoint: hermetic subprocess checks -----------------
// JGREP_NO_MAIN leaks into child env from this process (bun test shares one), so it
// is cleared explicitly; JEV_GATEWAY_URL too, so the gateway scenario is deterministic.

const run = (args: string[]) =>
  Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, JGREP_NO_MAIN: "", JEV_GATEWAY_URL: "", JGREP_ENDPOINT: "" },
  });

test("cli main: --provider unknown exits 2 with the typed error and every configured provider", () => {
  const p = run(["--provider", "unknown", "q"]);
  expect(p.exitCode).toBe(2);
  const err = p.stderr.toString();
  expect(err).toContain("bad_request: unknown provider");
  for (const choice of ["openrouter", "typesafe", "compatible", "cloudflare", "vercel"]) expect(err).toContain(choice);
  expect(err).toContain("use one of:"); // the grey hint line under the error
});

test("cli main: compatible without its endpoint exits 2 naming base_url and JEV_GATEWAY_URL", () => {
  const p = run(["--provider", "compatible", "q"]);
  expect(p.exitCode).toBe(2);
  const err = p.stderr.toString();
  expect(err).toContain("bad_request: compatible needs its endpoint");
  expect(err).toContain("JEV_GATEWAY_URL");
});

test("cli main: a non-numeric numeric flag exits 2 with the plain untyped rendering", () => {
  const p = run(["--rate", "abc", "q"]);
  expect(p.exitCode).toBe(2);
  const err = p.stderr.toString();
  expect(err).toContain("numeric option expected");
  expect(err).not.toContain("bad_request:"); // plain Error keeps today's rendering (no kind prefix)
});

test("cli main: --default must name a category (--tag or a choice question's criteria), else exit 2 (usage error)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tag = run(["--tag", "bug,filler", "--default", "nope", "--estimate", "q", "src/rows.ts"]);
  expect(tag.exitCode).toBe(2);
  expect(tag.stderr.toString()).toContain('--default "nope" is not one of the categories: bug, filler');
  expect(run(["--default", "bug", "--estimate", "q", "src/rows.ts"]).exitCode).toBe(2); // no categories at all
  expect(run(["--tag", "bug,filler", "--default", "filler", "--estimate", "q", "src/rows.ts"]).exitCode).toBe(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-default-"));
  try {
    const csv = path.join(dir, "rows.csv"), qf = path.join(dir, "q.json");
    fs.writeFileSync(csv, "handle\n@a\n");
    fs.writeFileSync(qf, JSON.stringify({ kind: { type: "choice", instructions: "kind?", criteria: { bug: "b", filler: "f" } } }));
    const bad = run(["--rows", csv, "--questions", qf, "--default", "nope", "--estimate"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain('--default "nope" is not one of the categories of question "kind": bug, filler');
    expect(run(["--rows", csv, "--questions", qf, "--default", "bug", "--estimate"]).exitCode).toBe(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- main() end-to-end over a local fake gateway: the --json output shapes -------
// The 0.4 contract: --json stays the v0.3.0 bare array (upstream requires it),
// --json-errors opts into the object. The shapes are proven through the REAL
// entrypoint: a localhost-only Bun.serve fake speaks the Jev System One protocol
// for chunks and rows, so no network and no key files are touched; --no-cache
// keeps ~/.jgrep/cache.json out of it.

const HIT_KEYS = ["end", "file", "p", "start", "text"]; // the exact v0.3.0 hit-object keys

/** Jev System One fake: answers every chunk and every row's `match` question with p=0.9. */
const startFakeGateway = () =>
  Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body: { state: { chunks?: { id: string }[]; rows?: { id: string }[] } } = await req.json();
      const answers: Record<string, unknown> = {};
      for (const c of body.state.chunks ?? []) answers[c.id] = { type: "noul", noul: 0.9 };
      for (const r of body.state.rows ?? []) answers[`${r.id}.match`] = { type: "noul", noul: 0.9 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    },
  });

const gatewayEnv = (port: number) => ({
  ...process.env, JGREP_NO_MAIN: "",
  JEV_GATEWAY_URL: `http://127.0.0.1:${port}/v1/systemone`, JEV_GATEWAY_API_KEY: "test-key",
});

/** Async spawn: Bun.spawnSync BLOCKS this process's event loop, which would
 *  deadlock the in-process fake gateway (the child's requests would sit
 *  unaccepted until its batch deadline). Bun.spawn keeps the loop running. */
const spawn = async (args: string[], env: Record<string, string | undefined>) => {
  const proc = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};

test("cli main code: --json emits the bare v0.3.0 hit array ({file,start,end,p,text}); --json-errors wraps it with errors", async () => {
  const server = startFakeGateway();
  try {
    const p = await spawn(
      ["bun", "src/cli.ts", "--json", "--no-cache", "--provider", "compatible", "swallows errors", "src/cli.ts"],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(0);
    const parsed = JSON.parse(p.stdout);
    expect(Array.isArray(parsed)).toBe(true); // v0.3.0 contract: bare array, NO wrapper, NO errors field
    expect(parsed.length).toBeGreaterThan(0);
    for (const h of parsed) expect(Object.keys(h).sort()).toEqual(HIT_KEYS);

    const p2 = await spawn(
      ["bun", "src/cli.ts", "--json-errors", "--no-cache", "--provider", "compatible", "swallows errors", "src/cli.ts"],
      gatewayEnv(server.port),
    );
    expect(p2.exitCode).toBe(0);
    const obj = JSON.parse(p2.stdout);
    expect(Array.isArray(obj)).toBe(false); // opt-in object
    expect(Object.keys(obj).sort()).toEqual(["errors", "hits"]);
    for (const h of obj.hits) expect(Object.keys(h).sort()).toEqual(HIT_KEYS);
    expect(obj.errors).toEqual([]); // clean run: same hits, empty errors
  } finally {
    server.stop(true);
  }
}, 20_000);

// The mlx entry's unit tests prove loadProviders COMPUTES the endpoint; this proves the request
// actually lands there. Without it, a regression that keeps the config perfect and the wire wrong
// (path dropped, model id not sent, a key demanded on loopback) would pass the whole suite.
test("cli main mlx: MLX_DECISION_URL reaches the wire — POST /v1/systemone with model elephant-1 and no key", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const seen: { path: string; model?: string; auth: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body: { model?: string; state?: { chunks?: { id: string }[] } } = await req.json();
      seen.push({ path: new URL(req.url).pathname, model: body.model, auth: req.headers.get("authorization") });
      const answers: Record<string, unknown> = {};
      for (const c of body.state?.chunks ?? []) answers[c.id] = { type: "noul", noul: 0.9 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-mlx-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--no-cache", "--provider", "mlx", "returns a number", dir],
      { ...process.env, JGREP_NO_MAIN: "", MLX_DECISION_URL: `http://127.0.0.1:${server.port}` }, // the module sets JGREP_NO_MAIN for its own import; the child must really run
    );
    expect(p.exitCode).toBe(0);
    expect(seen).toHaveLength(1); // one small file, one batch: exactly one request
    expect(seen[0].path).toBe("/v1/systemone"); // the built-in's path, appended to the env base URL
    expect(seen[0].model).toBe("elephant-1"); // the id the server answers for
    expect(seen[0].auth).toBeNull(); // loopback is keyless: no empty Bearer is sent
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);


// The feature's whole point — mlx is reached when a hosted provider fails — had only a manual
// run behind it. A unit assertion on BUILTINS proves the ORDER; this proves the run actually
// falls through to the local server and answers from it.
test("cli main mlx: a failing hosted provider falls back to the local server and answers from it", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const reply = (chunks: { id: string }[]) => {
    const a: Record<string, unknown> = {};
    for (const c of chunks) a[c.id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers: a, usage: { input_tokens: 10 } }), { status: 200 });
  };
  let hosted = 0, local = 0;
  const deadHost = Bun.serve({ port: 0, fetch: () => { hosted++; return new Response("down", { status: 500 }); } });
  const localSrv = Bun.serve({ port: 0, fetch: async (req: Request) => {
    local++;
    const body: { state?: { chunks?: { id: string }[] } } = await req.json();
    return reply(body.state?.chunks ?? []);
  } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-fb-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-fb-src-"));
  try {
    // A dead hosted provider first, mlx second: providers.json IS the chain, in its order.
    const pf = path.join(home, "providers.json");
    fs.writeFileSync(pf, JSON.stringify({ version: 1, providers: [
      { name: "compatible", base_url: `http://127.0.0.1:${deadHost.port}`, api_key: "x" },
      { name: "mlx" },
    ] }));
    fs.chmodSync(pf, 0o600); // a literal api_key requires a private file (checkFileMode)
    fs.writeFileSync(path.join(dir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--no-cache", "--retries", "0", "returns a number", dir],
      { ...process.env, JGREP_NO_MAIN: "", JGREP_HOME: home, MLX_DECISION_URL: `http://127.0.0.1:${localSrv.port}` },
    );
    expect(p.exitCode).toBe(0); // the run survived by using the local server
    expect(hosted).toBeGreaterThan(0); // the hosted provider really was tried first
    expect(local).toBeGreaterThan(0); // ...and mlx answered
    expect(p.stderr).toMatch(/fallback: compatible → mlx/);
    expect(p.stderr).toContain("elephant-1"); // the report names the local model
  } finally {
    deadHost.stop(true);
    localSrv.stop(true);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main mlx: a spent budget falls back to the free local server (budget_exhausted on the hosted entry, mlx at $0 answers)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const reply = (chunks: { id: string }[]) => {
    const a: Record<string, unknown> = {};
    for (const c of chunks) a[c.id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers: a, usage: { input_tokens: 10 } }), { status: 200 });
  };
  let hosted = 0, local = 0;
  // The hosted provider answers 200 (so it is NOT dead — it would bill), but the budget is so
  // small that the reservation on the hosted entry's price refuses before the request goes out.
  // mlx (usd_per_mtok 0) reserves nothing, so it is reached and answers.
  const hostedSrv = Bun.serve({ port: 0, fetch: async (req: Request) => { hosted++; const b = await req.json(); return reply(b.state?.chunks ?? []); } });
  const localSrv = Bun.serve({ port: 0, fetch: async (req: Request) => { local++; const b = await req.json(); return reply(b.state?.chunks ?? []); } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-budget-fb-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-budget-fb-src-"));
  try {
    // A file with a hosted provider first and NO mlx entry: the structural append adds mlx last.
    const pf = path.join(home, "providers.json");
    fs.writeFileSync(pf, JSON.stringify({ version: 1, providers: [
      { name: "compatible", base_url: `http://127.0.0.1:${hostedSrv.port}`, api_key: "x", usd_per_mtok: 1000000 }, // $1M/Mtok: one request far exceeds the $0.0001 budget
    ] }));
    fs.chmodSync(pf, 0o600);
    fs.writeFileSync(path.join(dir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
    // --budget 0.0001: the hosted entry (priced at the run default) cannot fit, budget_exhausted
    // falls back to mlx (priced 0), which answers.
    const p = await spawn(
      ["bun", "src/cli.ts", "--no-cache", "--retries", "0", "--budget", "0.0001", "returns a number", dir],
      { ...process.env, JGREP_NO_MAIN: "", JGREP_HOME: home, MLX_DECISION_URL: `http://127.0.0.1:${localSrv.port}` },
    );
    expect(p.exitCode).toBe(0); // the run survived: mlx answered at $0
    expect(hosted).toBe(0); // the hosted provider was never reached — budget_exhausted was unsent
    expect(local).toBeGreaterThan(0); // ...mlx answered
    expect(p.stderr).toMatch(/fallback: compatible → mlx/);
    expect(p.stderr).toContain("elephant-1");
  } finally {
    hostedSrv.stop(true);
    localSrv.stop(true);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main rows: --json emits the position-aligned flattened array; --json-errors wraps it; --out follows the flag", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = startFakeGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-json-"));
  try {
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n");
    const run = (extra: string[]) =>
      spawn(["bun", "src/cli.ts", "--rows", csv, "beauty?", "--provider", "compatible", "--no-cache", ...extra], gatewayEnv(server.port));

    const bare = await run(["--json"]);
    expect(bare.exitCode).toBe(0);
    expect(JSON.parse(bare.stdout)).toEqual([{ match: 0.9 }, { match: 0.9 }]); // bare array, position-aligned

    const obj = JSON.parse((await run(["--json-errors"])).stdout);
    expect(obj).toEqual({ answers: [{ match: 0.9 }, { match: 0.9 }], errors: [] }); // same array under `answers`

    const out = path.join(dir, "out.json");
    expect((await run(["--json", "--out", out])).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([{ match: 0.9 }, { match: 0.9 }]); // the FILE gets the array
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main: errored chunks/rows never enter the --json array (empty array / null entries) and exit 2", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-err-"));
  try {
    // Unroutable loopback port: connection-refused is instant, every chunk/row errors.
    const dead = { ...process.env, JGREP_NO_MAIN: "", JEV_GATEWAY_URL: "http://127.0.0.1:1/v1/systemone", JEV_GATEWAY_API_KEY: "test-key" };
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--json", "--no-cache", "--provider", "compatible", "--retries", "0", "--timeout", "1", "swallows errors", "src/cli.ts"],
      dead,
    );
    expect(p.exitCode).toBe(2); // partial failure surfaced via the exit code, not the payload
    expect(JSON.parse(p.stdout)).toEqual([]); // no hits: the bare array is just empty

    const p2 = await spawn(
      ["bun", "src/cli.ts", "--rows", csv, "beauty?", "--provider", "compatible", "--retries", "0", "--timeout", "1", "--no-cache", "--json"],
      dead,
    );
    expect(p2.exitCode).toBe(2);
    expect(JSON.parse(p2.stdout)).toEqual([null, null]); // errored rows: null entries, position-stable
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main rows single description: --out writes a CSV of the shown hits (no --json needed), stdout keeps the pretty output", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = startFakeGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-rowsout-"));
  try {
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n@c\n");
    const out = path.join(dir, "bots.csv");
    // --all so `shown` covers every scored row (threshold-only would still be a CSV);
    // no --json: this is the branch that used to ignore --out entirely.
    const p = await spawn(
      ["bun", "src/cli.ts", "--rows", csv, "beauty?", "--provider", "compatible", "--no-cache", "--all", "--out", out],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toContain(`wrote ${out}`); // written for real, not just claimed
    // stdout keeps the pretty hits even though the file landed
    expect(p.stdout).toContain("@a");

    const text = fs.readFileSync(out, "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("row,p,match"); // header: source row number, p, flattened answer columns
    expect(lines).toHaveLength(4); // header + 3 data lines (one per scored row)
    const body = lines.slice(1).map((l) => l.split(","));
    expect(body.every((cols) => cols.length === 3)).toBe(true);
    // `row` is the source row number: 1-based + the header line = s.i + 2
    expect(body.map((cols) => Number(cols[0]))).toEqual([2, 3, 4]);
    expect(body.every((cols) => Number(cols[1]) === 0.9 && Number(cols[2]) === 0.9)).toBe(true);
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main: an invalid JEV_PRICE_PER_MTOK is fatal before any request is made (rows mode used to bill first)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-price-"));
  try {
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--rows", csv, "beauty?", "--provider", "compatible", "--no-cache"],
      { ...gatewayEnv(server.port), JEV_PRICE_PER_MTOK: "abc" },
    );
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("JEV_PRICE_PER_MTOK must be a positive number");
    expect(requests).toBe(0); // died at startup: nothing was spent
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);


// ---- providers.json through the real entrypoint (TRDD-3KBUODCE) ----------------------------

/** A temp jgrep home holding `providers` as providers.json (0600), and a clean env: no inherited key. */
const homeEnv = async (providers: unknown[]) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-cli-home-"));
  fs.writeFileSync(path.join(home, "providers.json"), JSON.stringify({ version: 1, providers }), { mode: 0o600 });
  return { home, env: { PATH: process.env.PATH ?? "", HOME: home, JGREP_HOME: home } as Record<string, string> };
};

test("cli status: the chain in file order with each entry's state, never a key; exit 0 only when one is usable", async () => {
  const { env } = await homeEnv([
    { name: "first", base_url: "https://jev.example.com", path: "/v1/systemone", adapter: "system-one", api_key: "first-literal-key-123", model: "m1" },
    { name: "typesafe", enabled: "off" },
    { name: "openrouter" },
  ]);
  const p = await spawn(["bun", "src/cli.ts", "status"], env);
  expect(p.exitCode).toBe(0);
  expect(p.stdout).toMatch(/^1\. first +key present \(not verified\) · key literal in providers\.json$/m); // no free check: never "ready"
  expect(p.stdout).toMatch(/^2\. typesafe +disabled$/m);
  expect(p.stdout).toMatch(/^3\. openrouter +key missing \(\$OPENROUTER_API_KEY\)$/m);
  expect(p.stdout).toMatch(/^4\. mlx +not configured \(no base_url\)$/m); // the structural mlx fallback is appended (TRDD-3KBUODCE)
  expect(p.stdout + p.stderr).not.toContain("first-literal-key-123");
  const none = await spawn(["bun", "src/cli.ts", "status"], (await homeEnv([{ name: "openrouter" }])).env);
  expect(none.exitCode).toBe(2);
}, 20_000);

test("cli fallback: a rejected first provider costs ONE request, the second answers, the summary says so, errors.log masks the key", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  let firstHits = 0;
  const bad = Bun.serve({ port: 0, fetch: () => { firstHits++; return new Response(JSON.stringify({ error: { message: "invalid key first-literal-key-123" } }), { status: 401 }); } });
  const good = startFakeGateway();
  const { home, env } = await homeEnv([
    { name: "first", base_url: `http://127.0.0.1:${bad.port}`, path: "/v1/systemone", adapter: "system-one", api_key: "first-literal-key-123", model: "m1" },
    { name: "second", base_url: `http://127.0.0.1:${good.port}`, path: "/v1/systemone", adapter: "system-one", api_key: "$SECOND_KEY", model: "m2" },
  ]);
  try {
    const p = await spawn(["bun", "src/cli.ts", "--no-cache", "-b", "1", "swallows errors", "src/errors.ts"], { ...env, SECOND_KEY: "second-key-456" });
    expect(p.exitCode).toBe(0);
    expect(firstHits).toBe(1); // the circuit breaker held the parallel requests behind the first
    expect(p.stderr).toContain("fallback: first → second (invalid_api_key, HTTP 401) ×");
    expect(p.stderr).toContain("answered by second (m2)");
    const log = fs.readFileSync(path.join(home, "errors.log"), "utf8");
    expect(log).toContain("provider=first model=m1 kind=invalid_api_key status=401 fallback=second");
    for (const k of ["first-literal-key-123", "second-key-456"]) {
      expect(log).not.toContain(k);
      expect(p.stdout + p.stderr).not.toContain(k);
    }
  } finally {
    bad.stop(true);
    good.stop(true);
  }
}, 20_000);

test("cli: the cache lives in ~/.jgrep; an old ~/.cache/jgrep/cache.json is named once as deletable and never touched", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-cli-cache-"));
  const old = path.join(home, ".cache", "jgrep", "cache.json");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, "{}");
  const env = { PATH: process.env.PATH ?? "", HOME: home };
  const first = await spawn(["bun", "src/cli.ts", "--estimate", "retries", "src/pool.ts"], env);
  expect(first.exitCode).toBe(0);
  expect(first.stderr).toContain(`the old ${old} is no longer used and can be deleted`);
  expect(fs.existsSync(path.join(home, ".jgrep", "cache.json"))).toBe(true);
  expect(fs.readFileSync(old, "utf8")).toBe("{}"); // never migrated, never deleted
  const second = await spawn(["bun", "src/cli.ts", "--estimate", "retries", "src/pool.ts"], env);
  expect(second.stderr).not.toContain("can be deleted"); // said once
}, 20_000);
