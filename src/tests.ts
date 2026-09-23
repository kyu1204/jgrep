// jgrep --tests: predictive test selection. Given a diff, ask Jev one Noul per
// test file ("would this change plausibly affect this test?") and print the
// tests worth running first. Tests that map to a changed file by name are
// selected in code without asking.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_RETRIES, DEFAULT_REQUEST_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC, KEY_WORKED_EARLIER_HINT,
  MODEL, listFiles, type Cache, type Fetch,
} from "./jgrep";
import { postSystemOne, RateLimiter, type PostOpts } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";

export interface TestFile { file: string; signature: string }
export interface Selected { file: string; p: number; reason: "direct" | "import" | "jev" | "cached" }

// ponytail: patterns cover js/ts, python, go, ruby, rust, java, elixir; add flags when a stack is missing.
export const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|rb|exs)$|_spec\.rb$|(^|\/)[^/]*Tests?\.(java|kt|swift|cs)$|(^|\/)tests\.rs$/;

export function findTestFiles(files: string[]): string[] {
  return files.filter((f) => TEST_FILE_RE.test(f));
}

/** Imports plus test/describe names: enough for Jev to know what the file exercises, ~5% of its tokens. */
export function signature(file: string, text = fs.readFileSync(file, "utf8")): string {
  const keep = /^\s*(import |from .+ import |const .+ = require\(|require\(|use |using |package |describe\(|it\(|test\(|it\.each|test\.each|def test_|async def test_|func Test|fn test_|#\[test\]|@Test|class .*Test|context\(|scenario\(|feature\()/;
  const lines = text.split("\n").filter((l) => keep.test(l)).map((l) => l.trim().slice(0, 160));
  return lines.slice(0, 60).join("\n");
}

const stem = (f: string) => path.basename(f).replace(/\.(test|spec)\.[cm]?[jt]sx?$|_(test|spec)\.(py|go|rb|exs)$|^test_|\.[^.]+$/g, "").toLowerCase();

/** Tests whose name mirrors a changed source file (foo.ts -> foo.test.ts, foo.py -> test_foo.py). */
export function directMatches(changedFiles: string[], tests: string[]): Set<string> {
  const changedStems = new Set(changedFiles.filter((f) => !TEST_FILE_RE.test(f)).map(stem));
  const changedTests = new Set(changedFiles.filter((f) => TEST_FILE_RE.test(f)));
  return new Set(tests.filter((t) => changedTests.has(t) || changedStems.has(stem(t))));
}

export function changedFilesOf(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
}

const NOISE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$|\.(md|mdx|txt|svg|png|jpe?g|gif|ico|lock|snap)$|(^|\/)(dist|build|node_modules|vendor)\//;

/** Keep only what Jev needs from a diff: source files only, changed lines only, a per-file cap so one
 *  large file cannot starve the others, and the full changed-file list up front. */
export function compactDiff(diff: string, maxChars = 8000, perFile = 2000): string {
  const files: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const l of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(l);
    if (m) { cur = NOISE_RE.test(m[1]) ? null : { name: m[1], lines: [] }; if (cur) files.push(cur); continue; }
    if (cur && /^(@@ |[+-][^+-])/.test(l)) cur.lines.push(l);
  }
  const header = "changed files:\n" + files.map((f) => "  " + f.name).join("\n") + "\n\n";
  const budget = Math.max(1000, maxChars - header.length);
  const per = Math.min(perFile, Math.floor(budget / Math.max(1, files.length)));
  let body = "";
  for (const f of files) {
    let chunk = `+++ ${f.name}\n` + f.lines.join("\n");
    if (chunk.length > per) chunk = chunk.slice(0, per) + "\n... (truncated)";
    body += chunk + "\n";
  }
  return (header + body).trim();
}

/** Tests whose import lines reference a changed source file (by path segment or stem): selected in code, no Jev. */
export function importMatches(changedFiles: string[], tests: TestFile[]): Set<string> {
  const changedStems = new Set(changedFiles.filter((f) => !TEST_FILE_RE.test(f) && !NOISE_RE.test(f)).map(stem));
  const out = new Set<string>();
  for (const t of tests) {
    for (const m of t.signature.matchAll(/(?:from|require\(|import)\s*["']([^"']+)["']/g)) {
      const target = m[1];
      if (target.startsWith(".") || target.startsWith("/") || target.includes("/src/")) {
        const base = target.split("/").pop()?.replace(/\.(js|ts|mjs|cjs|jsx|tsx|py|go|rb|rs)$/, "") ?? "";
        if (base && changedStems.has(base.toLowerCase())) { out.add(t.file); break; }
      }
    }
  }
  return out;
}

export interface TestError { file: string; kind: JevErrorKind; message: string; hint?: string }

export interface SelectOptions {
  threshold: number; batch: number; concurrency: number; apiKey: string;
  timeoutSec?: number;         // per-batch deadline, retries included (defaults shared with jgrep)
  requestTimeoutSec?: number;  // per attempt
  maxRetries?: number;         // failed attempts tolerated before the final error
  ratePerSec?: number;         // token-bucket pacing across all requests; 0/undefined = unlimited
  failFast?: boolean;          // rethrow the first fatal error instead of isolating it
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}

export interface SelectResult { selected: Selected[]; all: Selected[]; tokens: number; requests: number; cached: number; errors: TestError[] }

/** One request-pack's outcome; runPool results are completion-ordered, so the batch
 *  index rides along and `all` is re-associated after the pool settles. A partial 200
 *  (the provider answered some tests but not others) is NOT an answer: unanswered test
 *  indices come back in `malformed` and become malformed_response errors — never a
 *  p:NaN entry in all/selected. */
interface BatchOutcome { index: number; entries: { testIndex: number; p: number }[]; malformed: number[] }

export async function selectTests(diff: string, tests: TestFile[], o: SelectOptions): Promise<SelectResult> {
  const f = o.fetchImpl ?? fetch;
  const cache = o.cache ?? {};
  const compact = compactDiff(diff);
  const changed = changedFilesOf(diff);
  const direct = directMatches(changed, tests.map((t) => t.file));
  const viaImport = importMatches(changed, tests);
  const diffHash = createHash("sha1").update(compact).digest("hex");
  const key = (t: TestFile) => createHash("sha1").update(`${MODEL}\0tests\0${diffHash}\0${t.file}\0${t.signature}`).digest("hex");

  const all: (Selected | undefined)[] = new Array(tests.length); // errored tests stay unset
  const todo: number[] = [];
  tests.forEach((t, i) => {
    if (direct.has(t.file)) all[i] = { file: t.file, p: 1, reason: "direct" };
    else if (viaImport.has(t.file)) all[i] = { file: t.file, p: 1, reason: "import" };
    else if (typeof cache[key(t)] === "number") all[i] = { file: t.file, p: cache[key(t)], reason: "cached" };
    else todo.push(i);
  });
  // Defensive normalization (same rule as jgrep()/scoreRows()): a 0/fractional batch
  // would spin the batching loop forever (+= 0) or overlap batches. parse() rejects
  // those; library callers get floored and clamped at 1 instead.
  const batch = Math.max(1, Math.floor(o.batch));
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += batch) batches.push(todo.slice(i, i + batch));
  // Same defaults and PostOpts wiring as jgrep()/scoreRows() — resolved once, read-only in the worker.
  const timeoutMs = (o.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const post: PostOpts = {
    fetchImpl: f,
    requestTimeoutMs: (o.requestTimeoutSec ?? DEFAULT_REQUEST_TIMEOUT_SEC) * 1000,
    maxRetries: o.maxRetries ?? DEFAULT_MAX_RETRIES,
    limiter: o.ratePerSec && o.ratePerSec > 0 ? new RateLimiter(o.ratePerSec, Math.max(1, o.concurrency)) : undefined,
  };
  let tokens = 0;
  // Run-level success flag, same rule as jgrep()/scoreRows(): drives the
  // invalid_api_key expired-vs-wrong-key hint. Tracked HERE (not PoolResult) because
  // failFast throws the pool result away.
  let hadSuccess = false;
  const worker = async (b: number[], index: number): Promise<BatchOutcome> => {
    const state = { diff: compact, tests: b.map((i, j) => ({ id: `t${j}`, file: tests[i].file, signature: tests[i].signature })) };
    const questions: Record<string, unknown> = {};
    b.forEach((_, j) => {
      questions[`t${j}`] = { type: "noul", instructions: `Look only at the test file with id "t${j}". Given the diff, is this test plausibly affected by the change: it imports or exercises a changed module or function, or asserts behaviour the diff alters? Unrelated tests should be no.` };
    });
    const res = await postSystemOne({ model: MODEL, state, questions }, o.apiKey, {
      ...post,
      deadlineMs: Date.now() + timeoutMs, // per-batch deadline, retries included
    });
    tokens += res.usage?.input_tokens ?? 0;
    // Finite p-values go straight into the in-memory cache object: cli.ts persists it in
    // a finally, so answers paid for survive even when other batches fail.
    const entries: { testIndex: number; p: number }[] = [];
    const malformed: number[] = [];
    b.forEach((ti, j) => {
      const p = res.answers[`t${j}`]?.noul;
      if (Number.isFinite(p)) {
        cache[key(tests[ti])] = p;
        entries.push({ testIndex: ti, p });
      } else malformed.push(ti);
    });
    hadSuccess = true; // this batch's request succeeded — set before returning
    return { index, entries, malformed };
  };
  let pool: PoolResult<BatchOutcome>;
  try {
    pool = await runPool(batches, {
      concurrency: o.concurrency,
      failFast: o.failFast,
      onProgress: o.onProgress,
    }, worker);
  } catch (e) {
    // failFast: runPool rethrows the first fatal error and PoolResult.hadSuccess is lost
    // with it, so the run-level flag above is the only remaining evidence that the key
    // worked earlier this run. Amend the hint; otherwise rethrow untouched.
    if (e instanceof JevProviderError && isFatalError(e) && e.kind === "invalid_api_key" && hadSuccess)
      e.hint = [e.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    throw e;
  }
  for (const r of pool.results) for (const e of r.entries) all[e.testIndex] = { file: tests[e.testIndex].file, p: e.p, reason: "jev" };
  // Not failFast: recorded 401/403s get the same expired-vs-wrong-key distinction. One
  // clean place — mutate the JevProviderError's hint in pool.errors BEFORE mapping onto
  // tests, so the amended hint is what TestError carries down to the CLI.
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  const errors: TestError[] = pool.errors.flatMap((e) =>
    batches[e.index].map((ti) => ({
      file: tests[ti].file, kind: e.error.kind, message: e.error.message,
      // The provider error's actionable hint rides along (cli.ts prints it under the
      // error line) — incl. the KEY_WORKED_EARLIER_HINT amended above.
      ...(e.error.hint !== undefined ? { hint: e.error.hint } : {}),
    })));
  // A 200 that answered only some tests of a batch: the unanswered tests are recorded
  // per test here (the batch itself succeeded, so the pool saw no error).
  for (const r of pool.results)
    for (const ti of r.malformed)
      errors.push({ file: tests[ti].file, kind: "malformed_response", message: "provider returned no usable answer for this test" });
  if (pool.aborted) {
    // Batches that were dispatched all reported (success or their own error); whatever
    // was never attempted is reported as a breaker error. No cache entries, no answers.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const ti of batches[bi]) errors.push({ file: tests[ti].file, kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
    }
  }
  // Errored tests never enter all/selected (same rule as jgrep()'s errored chunks);
  // they surface through the returned errors and the caller's exit code.
  const answered = all.filter((s): s is Selected => s !== undefined);
  const selected = answered.filter((s) => s.p >= o.threshold).sort((a, b) => b.p - a.p);
  const byCode = answered.filter((s) => s.reason === "direct" || s.reason === "import").length;
  return { selected, all: answered, tokens, requests: batches.length - (pool.aborted ? pool.unprocessed : 0), cached: tests.length - byCode - todo.length, errors };
}

export function loadTests(paths: string[] = ["."]): TestFile[] {
  return findTestFiles(listFiles(paths)).map((file) => ({ file, signature: signature(file) }));
}
