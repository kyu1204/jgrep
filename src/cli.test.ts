// CLI-surface tests: parse() flag types/defaults/numeric validation for the five
// reliability flags, the exported writeOut() helper, and the --json array-shape
// contract through the real entrypoint. The end-to-end tests are hermetic: the
// child process runs with HOME pointed at a temp dir whose ~/.cache/jgrep is
// pre-seeded, so every chunk/row is a cache hit — zero network, zero key files.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import { createHash } from "node:crypto";
import { MODEL } from "./jgrep";

process.env.JGREP_NO_MAIN = "1";
const { parse, writeOut } = await import("./cli");

declare const Bun: {
  spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined>; cwd?: string }): {
    exitCode: number | null;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
};

// ---- parse(): the five reliability flags ----------------------------------------

test("cli parse: reliability flags parse with correct types and defaults", () => {
  const o = parse(["q"]);
  expect(o).toMatchObject({ timeout: 15, requestTimeout: 30, retries: 4, rate: 0, failFast: false });
  expect(typeof o.timeout).toBe("number");
  expect(typeof o.requestTimeout).toBe("number");
  expect(typeof o.retries).toBe("number");
  expect(typeof o.rate).toBe("number");
  expect(typeof o.failFast).toBe("boolean");

  const o2 = parse(["--timeout", "30", "--request-timeout", "60", "--retries", "2", "--rate", "5", "--fail-fast", "q", "src/"]);
  expect(o2).toMatchObject({ timeout: 30, requestTimeout: 60, retries: 2, rate: 5, failFast: true, question: "q", paths: ["src/"] });
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

test("cli parse: batch must be a positive integer (0 and fractions rejected)", () => {
  // batch < 1 spins the batching loop forever (+= 0); a fraction overlaps batches.
  expect(() => parse(["-b", "0", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["--batch", "1.5", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["-b", "1", "q"])).not.toThrow();
  expect(() => parse(["-b", "16", "q"])).not.toThrow();
  // rate 0 and retries 0 stay legal — only batch and the deadlines reject 0
  expect(() => parse(["--rate", "0", "--retries", "0", "q"])).not.toThrow();
});

test("cli parse: old and new flags coexist (--diff positional heuristic untouched)", () => {
  const o = parse(["--diff", "--json", "--fail-fast", "--staged", "q"]);
  expect(o).toMatchObject({ json: true, failFast: true, diff: ["--staged"], question: "q" });
  const o2 = parse(["--diff", "origin/main", "--rate", "10", "q", "src/"]);
  expect(o2).toMatchObject({ diff: ["origin/main"], rate: 10, question: "q", paths: ["src/"] });
});

// ---- writeOut(): file when a path is given, stdout otherwise ---------------------

test("writeOut: writes the file and reports it landed; no path goes to stdout and reports false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-writeout-"));
  try {
    const out = path.join(dir, "o.json");
    expect(writeOut(out, "[1,2]")).toBe(true); // a file actually landed
    expect(fs.readFileSync(out, "utf8")).toBe("[1,2]");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try { expect(writeOut("", "stdout-payload")).toBe(false); } finally { console.log = orig; }
    expect(logs).toEqual(["stdout-payload"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- main() via the real entrypoint: the --json array-shape contract -------------
// Pre-seeding the child's HOME cache makes the whole run a cache hit: no network,
// no key files, and the v0.3.0 output shape is proven end to end.

const cliPath = path.join(import.meta.dir, "cli.ts");

/** A temp project + temp HOME whose ~/.cache/jgrep holds `entries`. */
const seedHome = (entries: Record<string, unknown>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-json-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".cache", "jgrep"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cache", "jgrep", "cache.json"), JSON.stringify(entries));
  return { dir, home };
};

const runCli = (args: string[], cwd: string, home: string) =>
  Bun.spawnSync(["bun", cliPath, ...args], {
    cwd,
    env: { ...process.env, JGREP_NO_MAIN: "", HOME: home, TYPESAFE_API_KEY: "test-key" },
  });

test("cli main code: --json emits the bare v0.3.0 hit array with exactly {file,start,end,p,text}", () => {
  const q = "json shape contract probe 7f3a";
  // 8 indented lines, no trailing newline: chunk() yields exactly one chunk whose
  // text is the whole file, so the cache key is computable from here.
  const text = Array.from({ length: 8 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  const codeKey = createHash("sha1").update(`${MODEL}\0code\0${q}\0${text}`).digest("hex");
  const { dir, home } = seedHome({ [codeKey]: 0.9 });
  try {
    fs.writeFileSync(path.join(dir, "probe.ts"), text);
    const p = runCli(["--json", q, "probe.ts"], dir, home);
    expect(p.exitCode).toBe(0);
    const parsed = JSON.parse(p.stdout.toString());
    expect(Array.isArray(parsed)).toBe(true); // bare array — no wrapper, no errors field
    expect(parsed).toHaveLength(1);
    for (const h of parsed) expect(Object.keys(h).sort()).toEqual(["end", "file", "p", "start", "text"]);
    expect(parsed[0]).toMatchObject({ file: "probe.ts", start: 1, end: 8, p: 0.9 });
    // and without --json the pretty line still names the file
    const p2 = runCli([q, "probe.ts"], dir, home);
    expect(p2.exitCode).toBe(0);
    expect(p2.stdout.toString()).toContain("probe.ts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- rows --json: the restored v0.3.0 contract -----------------------------------
// questions mode -> the merged table rows (row fields + answer columns);
// single description -> the SHOWN hits [{row, p, ...row fields}] (row = csv line).

const rowsContractProbe = "rows json contract probe be41";
/** The rows cache key for a one-question `match` probe (must match rows.ts `key`). */
const rowKeyOf = (handle: string, qJson: string) =>
  createHash("sha1").update(`${MODEL}\0rows\0${qJson}\0${JSON.stringify({ handle })}`).digest("hex");

test("cli main rows --questions: --json emits the merged table rows (row fields + answer columns)", () => {
  const questions = { match: { type: "noul", instructions: rowsContractProbe } };
  const qJson = JSON.stringify(questions);
  // Both rows cached: the run is a pure cache hit (zero requests, zero network).
  const { dir, home } = seedHome({
    [rowKeyOf("@a", qJson)]: { match: { type: "noul", noul: 0.9 } },
    [rowKeyOf("@b", qJson)]: { match: { type: "noul", noul: 0.9 } },
  });
  try {
    fs.writeFileSync(path.join(dir, "rows.csv"), "handle\n@a\n@b\n");
    fs.writeFileSync(path.join(dir, "q.json"), qJson);
    const p = runCli(["--rows", "rows.csv", "--questions", "q.json", "--json"], dir, home);
    expect(p.exitCode).toBe(0);
    const parsed = JSON.parse(p.stdout.toString());
    expect(Array.isArray(parsed)).toBe(true); // bare array — the scored table, not answers alone
    expect(parsed).toEqual([
      { handle: "@a", match: 0.9 },
      { handle: "@b", match: 0.9 },
    ]);
    // and without --json the scored CSV table still lands on stdout
    const p2 = runCli(["--rows", "rows.csv", "--questions", "q.json"], dir, home);
    expect(p2.exitCode).toBe(0);
    expect(p2.stdout.toString()).toContain("handle,match");
    expect(p2.stdout.toString()).toContain("@a,0.9");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli main rows single: --json emits the SHOWN hits {row, p, ...row fields} like 0.3.0", () => {
  const questions = { match: { type: "noul", instructions: rowsContractProbe } };
  const qJson = JSON.stringify(questions);
  const { dir, home } = seedHome({
    [rowKeyOf("@a", qJson)]: { match: { type: "noul", noul: 0.9 } },
    [rowKeyOf("@b", qJson)]: { match: { type: "noul", noul: 0.1 } },
  });
  try {
    fs.writeFileSync(path.join(dir, "rows.csv"), "handle\n@a\n@b\n");
    const p = runCli(["--rows", "rows.csv", "--json", rowsContractProbe], dir, home);
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toEqual([{ row: 2, p: 0.9, handle: "@a" }]); // @b is below threshold
    // --all shows every scored row, best first, same hit shape
    const p2 = runCli(["--rows", "rows.csv", "--json", "--all", rowsContractProbe], dir, home);
    expect(JSON.parse(p2.stdout.toString())).toEqual([
      { row: 2, p: 0.9, handle: "@a" },
      { row: 3, p: 0.1, handle: "@b" },
    ]);
    // and without --json the pretty line still names row 2
    const p3 = runCli(["--rows", "rows.csv", rowsContractProbe], dir, home);
    expect(p3.exitCode).toBe(0);
    expect(p3.stdout.toString()).toContain("rows.csv:2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli main rows: partial failure keeps the v0.3.0 shapes — errored rows never crash nor appear", () => {
  // @a/@b are cached; @c is not, and its pack runs with a 1ms deadline (--timeout
  // 0.001: the only fetch attempt is aborted within 1ms — no response can arrive —
  // and the pre-attempt deadline check then rejects the retry, so the failure is
  // deterministic and parses no provider response). The run is a partial failure:
  // exit 2, and the errored row is absent from the JSON payloads in both modes.
  const questions = { match: { type: "noul", instructions: rowsContractProbe } };
  const qJson = JSON.stringify(questions);
  const { dir, home } = seedHome({
    [rowKeyOf("@a", qJson)]: { match: { type: "noul", noul: 0.9 } },
    [rowKeyOf("@b", qJson)]: { match: { type: "noul", noul: 0.9 } },
  });
  try {
    fs.writeFileSync(path.join(dir, "rows.csv"), "handle\n@a\n@b\n@c\n");
    // single description: errored @c (row 4) cannot be shown — absent, no TypeError
    const p = runCli(["--rows", "rows.csv", "--json", "--timeout", "0.001", rowsContractProbe], dir, home);
    expect(p.exitCode).toBe(2); // partial failure
    expect(JSON.parse(p.stdout.toString())).toEqual([
      { row: 2, p: 0.9, handle: "@a" },
      { row: 3, p: 0.9, handle: "@b" },
    ]);
    // questions mode: the errored row keeps its row fields but gains no answer columns
    fs.writeFileSync(path.join(dir, "q.json"), qJson);
    const p2 = runCli(["--rows", "rows.csv", "--questions", "q.json", "--json", "--timeout", "0.001"], dir, home);
    expect(p2.exitCode).toBe(2);
    expect(JSON.parse(p2.stdout.toString())).toEqual([
      { handle: "@a", match: 0.9 },
      { handle: "@b", match: 0.9 },
      { handle: "@c" }, // merged non-null fields only: no NaN, no crash, no null entry
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
