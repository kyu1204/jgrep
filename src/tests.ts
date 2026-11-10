// jgrep --tests: predictive test selection. Given a diff, ask Jev one Noul per
// test file ("would this change plausibly affect this test?") and print the
// tests worth running first. Tests that map to a changed file by name are
// selected in code without asking.
//
// Fork adaptation: requests go through the providers.ts chain (providers.json, with
// fallback). The chain, the lazy API-key lookup and the PostOpts wiring follow scoreRows()
// in rows.ts; the cache key is scoped by the model that answered, the rule every mode uses.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_RETRIES, DEFAULT_REQUEST_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC, KEY_WORKED_EARLIER_HINT,
  BudgetMeter, MAX_REQUEST_BYTES, byteLen, diffHeaderPath, fitChunk, lineWindows, listFiles, packBatches, settledCost, splitLongLine, withinSize, type Cache, type Estimate, type ListOptions,
} from "./jgrep";
import { chainFor, DEFAULT_PRICE_PER_MTOK, RateLimiter, type Backend, type Fetch, type PostOpts, type ProviderChain } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";

export interface TestFile { file: string; signature: string }
export interface Selected { file: string; p: number; reason: "direct" | "import" | "package" | "jev" | "cached" }

// ponytail: patterns cover js/ts, python, go, ruby, rust, java, elixir; add flags when a stack is missing.
// A file under a tests/ or spec/ directory counts only when it is SOURCE code: the old
// bare-directory rule also selected README.md, results/*.jsonl and fixture data (e.g. this
// repo's bench/tests/), which `--tests | xargs <runner>` then handed to the test runner.
export const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec|specs)\/(.*\/)?[^/]+\.([cm]?[jt]sx?|py|go|rb|rs|java|kt|kts|swift|cs|exs?|php|scala|dart|c|cc|cpp|m)$|(\.|_)(test|spec|tst|test-d)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|rb|exs)$|_spec\.rb$|(^|\/)[^/]*Tests?\.(java|kt|swift|cs)$|(^|\/)tests\.rs$/;

export function findTestFiles(files: string[]): string[] {
  return files.filter((f) => TEST_FILE_RE.test(f));
}

/** Imports plus test/describe names: enough for Jev to know what the file exercises, ~5% of its tokens. */
export function signature(file: string, text = fs.readFileSync(file, "utf8")): string {
  const keep = /^\s*(}\s*from\s+["']|export .+ from |.*\bimport\(\s*["']|import |from .+ import |const .+ = require\(|require\(|use |using |package |describe\(|it\(|test\(|it\.each|test\.each|def test_|async def test_|func Test|fn test_|#\[test\]|@Test|class .*Test|context\(|scenario\(|feature\()/;
  // Every matching line, whole (USER 2026-10-02: never truncate to fit the context — the
  // old 60-line / 160-char clip dropped the test names of big suites). selectTests splits
  // an oversized signature into parts and takes the best part's verdict.
  return text.split("\n").filter((l) => keep.test(l)).map((l) => l.trim()).join("\n");
}

const stem = (f: string) => path.basename(f).replace(/[._](test|spec|tst|test-d)\.[cm]?[jt]sx?$|_(test|spec)\.(py|go|rb|exs)$|^test_|\.[^.]+$/g, "").toLowerCase();

/** Tests whose name mirrors a changed source file (foo.ts -> foo.test.ts, foo.py -> test_foo.py). */
export function directMatches(changedFiles: string[], tests: string[]): Set<string> {
  const changedStems = new Set(changedFiles.filter((f) => !TEST_FILE_RE.test(f)).map(stem));
  const changedTests = new Set(changedFiles.filter((f) => TEST_FILE_RE.test(f)));
  return new Set(tests.filter((t) => changedTests.has(t) || changedStems.has(stem(t))));
}

/** New-side paths of every file in the diff (deletions, `+++ /dev/null`, excluded);
 *  diffHeaderPath decodes git's quoted / TAB-terminated header forms. */
export function changedFilesOf(diff: string): string[] {
  return diff.split("\n").filter((l) => l.startsWith("+++ b/") || l.startsWith('+++ "b/')).map(diffHeaderPath);
}

const NOISE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$|\.(md|mdx|txt|svg|png|jpe?g|gif|ico|lock|snap)$|(^|\/)(dist|build|node_modules|vendor)\//;

/** Keep only what Jev needs from a diff: source files only, changed lines only, a per-file cap so one
 *  large file cannot starve the others, and the full changed-file list up front. */
/** Changed source files and their changed lines (hunk headers, `+` and `-` lines), lockfiles
 *  and docs dropped (NOISE_RE). A `+`/`-` content line is never mistaken for a `+++`/`---`
 *  file header (the old `[+-][^+-]` filter dropped real lines such as `+--flag` and `+`). */
function diffFilesOf(diff: string): { name: string; lines: string[] }[] {
  const files: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ b/") || l.startsWith('+++ "b/')) {
      const name = diffHeaderPath(l);
      cur = NOISE_RE.test(name) ? null : { name, lines: [] };
      if (cur) files.push(cur);
      continue;
    }
    if (cur && (l.startsWith("@@ ") || (l.startsWith("+") && !l.startsWith("+++ ")) || (l.startsWith("-") && !l.startsWith("--- ")))) cur.lines.push(l);
  }
  return files;
}

/** The whole compact diff: the changed-file list, then every changed line per file. Never
 *  truncated (USER 2026-10-02) — compactDiffParts splits it to fit the context. */
export function compactDiff(diff: string): string {
  const files = diffFilesOf(diff);
  const header = "changed files:\n" + files.map((f) => "  " + f.name).join("\n") + "\n\n";
  return (header + files.map((f) => `+++ ${f.name}\n` + f.lines.join("\n")).join("\n")).trim();
}

/** Bytes of compact diff per request part, leaving room for a pack of test signatures. */
export const DIFF_PART_BYTES = 16_000;

/** The compact diff in context-sized PARTS (USER: split, never truncate): every part repeats
 *  the changed-file list; the per-file bodies are cut at line boundaries with a small
 *  overlap, a part that starts inside a file re-states its `+++ name (continued)` line,
 *  and a giant single line is cut by characters. A small diff is ONE part, equal to
 *  compactDiff(). ponytail: a changed-file list alone over the budget is not split. */
export function compactDiffParts(diff: string, maxBytes: number = DIFF_PART_BYTES): string[] {
  const files = diffFilesOf(diff);
  const header = "changed files:\n" + files.map((f) => "  " + f.name).join("\n") + "\n\n";
  const body: { file: string; text: string }[] = files.flatMap((f) => [{ file: f.name, text: `+++ ${f.name}` }, ...f.lines.map((text) => ({ file: f.name, text }))]);
  const whole = (header + body.map((b) => b.text).join("\n")).trim();
  if (byteLen(whole) <= maxBytes) return [whole];
  const budget = Math.max(1000, maxBytes - byteLen(header) - 300); // 300: room for a "(continued)" line
  const parts: string[] = [];
  for (const [i, j] of lineWindows(body.map((b) => b.text), budget)) {
    const lead = body[i].text.startsWith("+++ ") ? [] : [`+++ ${body[i].file} (continued)`];
    if (j === i + 1 && byteLen(body[i].text) + 1 > budget) {
      for (const piece of splitLongLine(body[i].text, budget)) parts.push((header + [...lead, piece].join("\n")).trim());
      continue;
    }
    parts.push((header + [...lead, ...body.slice(i, j).map((b) => b.text)].join("\n")).trim());
  }
  return parts;
}

/** Tests whose import lines reference a changed source file (by path segment or stem): selected in code, no Jev. */
export function importMatches(changedFiles: string[], tests: TestFile[]): Set<string> {
  const changedStems = new Set(changedFiles.filter((f) => !TEST_FILE_RE.test(f) && !NOISE_RE.test(f)).map(stem));
  const out = new Set<string>();
  for (const t of tests) {
    for (const m of t.signature.matchAll(/(?:from|require\(|import\(?)\s*["']([^"']+)["']/g)) {
      const target = m[1];
      if (target.startsWith(".") || target.startsWith("/") || target.includes("/src/")) {
        const base = target.split("/").pop()?.replace(/\.(js|ts|mjs|cjs|jsx|tsx|py|go|rb|rs)$/, "") ?? "";
        if (base && changedStems.has(base.toLowerCase())) { out.add(t.file); break; }
      }
    }
  }
  return out;
}

let top: { root: string; prefix: string } | undefined;
/** Repo root (changed paths are relative to it) and cwd's offset inside it (test paths are relative to cwd). */
function repoTop() {
  if (!top) {
    try {
      const g = (a: string) => execFileSync("git", ["rev-parse", a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      top = { root: g("--show-toplevel"), prefix: g("--show-prefix") };
    } catch { top = { root: process.cwd(), prefix: "" }; }
  }
  return top;
}
const rd = (f: string) => { try { return fs.readFileSync(path.join(repoTop().root, f), "utf8"); } catch { return ""; } };
const exists = (f: string) => { try { return fs.statSync(path.join(repoTop().root, f)).isFile(); } catch { return false; } };

/** Root-importing tests ("import zod", "../src", "import flask") selected in code when a changed file is part of
 *  that package's public surface: its entry file (src/index.*, index.*, __init__.py; package.json main/exports are ignored).
 *  Package name and entry come from package.json / the __init__.py tree, no network. Paths are repo-root relative;
 *  `prefix` is where the test paths' cwd sits inside the repo. */
export function packageMatches(changedFiles: string[], tests: TestFile[], read = rd, has = exists, prefix = repoTop().prefix): Set<string> {
  const out = new Set<string>();
  const roots: ((t: TestFile) => boolean)[] = [];
  for (const f of changedFiles) {
    if (TEST_FILE_RE.test(f) || NOISE_RE.test(f)) continue;
    const dirs = f.split("/").slice(0, -1);
    let name = "", entry = "";
    if (/\.py$/.test(f)) { // the consecutive __init__.py chain above f's dir gives the dotted name (pkg.sub)
      let i = dirs.length;
      while (i > 0 && has([...dirs.slice(0, i), "__init__.py"].join("/"))) i--;
      if (i < dirs.length) { name = dirs.slice(i).join("."); entry = [...dirs, "__init__.py"].join("/"); }
    } else {
      for (let i = dirs.length; i >= 0 && !name; i--) {
        const pj = [...dirs.slice(0, i), "package.json"].join("/");
        if (!has(pj)) continue;
        try { name = JSON.parse(read(pj)).name ?? ""; } catch { /* unreadable package.json: no package rule */ }
        const base = dirs.slice(0, i).join("/");
        entry = ["src/index", "index"].flatMap((e) => ["ts", "js", "mts", "mjs", "tsx"].map((x) => [base, `${e}.${x}`].filter(Boolean).join("/"))).find(has) ?? "";
      }
    }
    if (!name || !entry) continue;
    if (f !== entry) continue; // ponytail: entry file only; counting its re-exports selects ~every test in small libs (flask 0.11 -> 0.39 ratio)
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (entry.endsWith(".py")) {
      const re = new RegExp(`^\\s*(import\\s+([\\w.]+\\s*,\\s*)*${n}\\b|from\\s+${n}(\\.\\w+)*\\s+import)`, "m");
      roots.push((t) => re.test(t.signature));
    } else {
      // A relative spec counts only if, resolved from the test's own directory, it lands on the entry file or its directory.
      const entryNoExt = entry.replace(/\.\w+$/, ""), entryDir = path.posix.dirname(entry);
      const named = new RegExp(`^${n}(/.*)?$`); // subpaths too: "zod" and "zod/v4" export the same v4/classic API
      roots.push((t) => [...t.signature.matchAll(/(?:from|require\(|import\(?)\s*["']([^"']+)["']/g)].some(([, spec]) => {
        if (named.test(spec)) return true;
        if (!spec.startsWith(".")) return false;
        const r = path.posix.join(path.posix.dirname(path.posix.join(prefix, t.file.replace(/\\/g, "/"))), spec).replace(/\.\w+$/, "");
        return r === entryNoExt || r === entryDir || (r === "." && entryDir === ".");
      }));
    }
  }
  if (roots.length) for (const t of tests) if (roots.some((r) => r(t))) out.add(t.file);
  return out;
}

export interface TestError { file: string; kind: JevErrorKind; message: string; hint?: string }

export interface SelectOptions {
  threshold: number; batch: number; concurrency: number;
  apiKey?: string;             // explicit key wins; else resolved lazily at the first request (scoreRows pattern)
  backend?: Backend; model?: string;
  chain?: ProviderChain;       // the CLI's providers.json chain (TRDD-3KBUODCE); wins over backend/model/apiKey
  timeoutSec?: number;         // per-batch deadline, retries included (defaults shared with jgrep)
  requestTimeoutSec?: number;  // per attempt
  maxRetries?: number;         // failed attempts tolerated before the final error
  ratePerSec?: number;         // token-bucket pacing across all requests; 0/undefined = unlimited
  failFast?: boolean;          // rethrow the first fatal error instead of isolating it
  estimate?: Estimate;         // dry run: count requests/chars into this sink, never call the provider
  meter?: BudgetMeter;         // a caller-owned meter (the CLI reads its under-pricing check); else built from budget
  budget?: number;             // --budget: hard cap via reservation, same as jgrep()/scoreRows(); undefined = no cap
  pricePerMtok?: number;       // $/Mtok for the budget reservation and token-priced spend (default DEFAULT_PRICE_PER_MTOK)
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}

export interface SelectResult { selected: Selected[]; all: Selected[]; tokens: number; cost?: number; requests: number; cached: number; errors: TestError[] }

/** One request-pack's outcome; runPool results are completion-ordered, so the batch
 *  index rides along. Entries and malformed refer to UNIT indices (see selectTests). A
 *  partial 200 (some units unanswered) is NOT an answer: those units come back in
 *  `malformed` and their tests become malformed_response errors — never p:NaN. */
interface BatchOutcome { index: number; entries: { unit: number; p: number }[]; malformed: number[] }

/** A test signature over this many bytes is judged in parts (best part wins). */
export const SIG_PART_BYTES = 8_000;

export async function selectTests(diff: string, tests: TestFile[], o: SelectOptions): Promise<SelectResult> {
  // Same chain rule as jgrep()/scoreRows(): the CLI's providers.json chain, else one backend with a lazy key.
  const chain = chainFor(o);
  const model = chain.model();
  const models = chain.models(); // a cached verdict from any model of the chain is served, the head's first
  const f = o.fetchImpl ?? fetch;
  const cache = o.cache ?? {};
  const changed = changedFilesOf(diff);
  const direct = directMatches(changed, tests.map((t) => t.file));
  const viaImport = importMatches(changed, tests);
  const viaPackage = packageMatches(changed, tests);
  // USER 2026-10-02: never truncate to fit the context — split, and a per-FILE verdict is
  // the best part's ("consider the highest scored chunk"). The compact diff is cut into
  // context-sized parts and an oversized signature into parts; every (diff part, signature
  // part) pair of a test is one UNIT, judged on its own; the test's p is the max over its
  // units. A small diff and signature are one unit: the old one-question-per-test shape.
  const parts = compactDiffParts(diff);
  const partHash = parts.map((d) => createHash("sha1").update(d).digest("hex"));
  const sigParts = (t: TestFile) => (t.signature ? fitChunk({ file: t.file, start: 1, end: 1, text: t.signature }, "code", SIG_PART_BYTES).map((c) => c.text) : [""]);
  // Model-scoped keys (same rule as jgrep()/rows): a different model re-judges. Lookups use
  // the first live provider's model; an answer is stored under the model that gave it.
  const key = (file: string, part: number, sig: string, m: string = model) => createHash("sha1").update(`${m}\0tests\0${partHash[part]}\0${file}\0${sig}`).digest("hex");

  const all: (Selected | undefined)[] = new Array(tests.length); // errored tests stay unset
  const units: { test: number; part: number; sig: string }[] = [];
  const best = new Map<number, number>();      // test -> best p so far (cached + answered units)
  const pending = new Map<number, number>();   // test -> units still to be judged
  let fromCache = 0;
  tests.forEach((t, i) => {
    if (direct.has(t.file)) { all[i] = { file: t.file, p: 1, reason: "direct" }; return; }
    if (viaImport.has(t.file)) { all[i] = { file: t.file, p: 1, reason: "import" }; return; }
    if (viaPackage.has(t.file)) { all[i] = { file: t.file, p: 1, reason: "package" }; return; }
    let open = 0;
    for (let k = 0; k < parts.length; k++) for (const sig of sigParts(t)) {
      const p = models.map((m) => cache[key(t.file, k, sig, m)]).find((x) => typeof x === "number" && Number.isFinite(x));
      if (typeof p === "number" && Number.isFinite(p)) best.set(i, Math.max(best.get(i) ?? -Infinity, p));
      else { units.push({ test: i, part: k, sig }); open++; }
    }
    if (open === 0) { all[i] = { file: t.file, p: best.get(i)!, reason: "cached" }; fromCache++; }
    else pending.set(i, open);
  });
  // Defensive normalization (same rule as jgrep()/scoreRows()): a 0/fractional batch
  // would spin the batching loop forever (+= 0) or overlap batches. parse() rejects
  // those; library callers get floored and clamped at 1 instead.
  const batch = Math.max(1, Math.floor(o.batch));
  // One request carries ONE diff part: group the units by part, then pack each group by
  // count AND bytes (diff part + signatures within MAX_REQUEST_BYTES).
  const QUESTION_BYTES = 320; // the per-test instruction text, generously
  const batches: number[][] = [];
  for (let k = 0; k < parts.length; k++) {
    const ofPart = units.map((u, ui) => (u.part === k ? ui : -1)).filter((ui) => ui >= 0);
    batches.push(...packBatches(ofPart, batch, MAX_REQUEST_BYTES - byteLen(parts[k]) - 200, (ui) => byteLen(JSON.stringify({ id: "t00", file: tests[units[ui].test].file, signature: units[ui].sig })) + QUESTION_BYTES));
  }
  // Same defaults and PostOpts wiring as jgrep()/scoreRows() — resolved once, read-only in the worker.
  const timeoutMs = (o.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const post: PostOpts = {
    fetchImpl: f,
    requestTimeoutMs: (o.requestTimeoutSec ?? DEFAULT_REQUEST_TIMEOUT_SEC) * 1000,
    maxRetries: o.maxRetries ?? DEFAULT_MAX_RETRIES,
    limiter: o.ratePerSec && o.ratePerSec > 0 ? new RateLimiter(o.ratePerSec, Math.max(1, o.concurrency)) : undefined,
  };
  let tokens = 0;
  let cost: number | undefined; // undefined until a pack is answered; then the settledCost sum (same rule as the meter)
  const price = o.pricePerMtok ?? DEFAULT_PRICE_PER_MTOK;
  // Run-level success flag, same rule as jgrep()/scoreRows(): drives the
  // invalid_api_key expired-vs-wrong-key hint. Tracked HERE (not PoolResult) because
  // failFast throws the pool result away.
  let hadSuccess = false;
  // --budget (audit MAJOR): --tests used to have no meter, so --budget / $JEV_BUDGET were
  // silently ignored here while every other mode honoured them. Same opt-in reservation
  // meter as jgrep()/scoreRows(); no budget = no meter. The meter is passed into post()
  // (TRDD-3KBUODCE): each chain entry reserves at its own usd_per_mtok.
  const meter = o.meter ?? (o.budget !== undefined ? new BudgetMeter(o.budget, price) : undefined);
  if (meter) post.meter = meter;
  const worker = async (b: number[], index: number): Promise<BatchOutcome> => {
    const state = { diff: parts[units[b[0]].part], tests: b.map((ui, j) => ({ id: `t${j}`, file: tests[units[ui].test].file, signature: units[ui].sig })) };
    const questions: Record<string, unknown> = {};
    b.forEach((_, j) => {
      questions[`t${j}`] = { type: "noul", instructions: `Look only at the test file with id "t${j}". Given the diff, is this test plausibly affected by the change: it imports or exercises a changed module or function, or asserts behaviour the diff alters? Unrelated tests should be no.` };
    });
    const req = { model, state, questions };
    // --estimate: count before any provider is asked, so a dry run needs no key.
    if (o.estimate) { o.estimate.requests++; o.estimate.chars += JSON.stringify(req).length; return { index, entries: [], malformed: [] }; }
    // per-batch deadline per provider, retries included; --budget reserves per provider
    // inside post() (TRDD-3KBUODCE): a free local server (mlx, 0) is reached even when the
    // budget is nearly spent.
    const res = await chain.post(req, post, timeoutMs);
    tokens += res.usage?.input_tokens ?? 0;
    cost = (cost ?? 0) + settledCost(res, price);
    // Finite p-values go straight into the in-memory cache object: cli.ts persists it in
    // a finally, so answers paid for survive even when other batches fail.
    const entries: { unit: number; p: number }[] = [];
    const malformed: number[] = [];
    b.forEach((ui, j) => {
      const p = res.answers[`t${j}`]?.noul;
      if (typeof p === "number" && Number.isFinite(p)) {
        const u = units[ui];
        cache[key(tests[u.test].file, u.part, u.sig, res.via.model)] = p; // the model that answered
        entries.push({ unit: ui, p });
      } else malformed.push(ui);
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
  // A test's verdict needs ALL its units: then p = the best unit's (max over parts).
  for (const r of pool.results) for (const e of r.entries) {
    const t = units[e.unit].test;
    best.set(t, Math.max(best.get(t) ?? -Infinity, e.p));
    pending.set(t, pending.get(t)! - 1);
  }
  for (const [t, open] of pending) if (open === 0) all[t] = { file: tests[t].file, p: best.get(t)!, reason: "jev" };
  // Not failFast: recorded 401/403s get the same expired-vs-wrong-key distinction. One
  // clean place — mutate the JevProviderError's hint in pool.errors BEFORE mapping onto
  // tests, so the amended hint is what TestError carries down to the CLI.
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  // One error per test (a test judged in several units may fail in several packs).
  const errors: TestError[] = [];
  const failed = new Set<number>();
  const fail = (t: number, err: Omit<TestError, "file">) => { if (failed.has(t)) return; failed.add(t); errors.push({ file: tests[t].file, ...err }); };
  for (const e of pool.errors)
    for (const ui of batches[e.index])
      // The provider error's actionable hint rides along (cli.ts prints it under the
      // error line) — incl. the KEY_WORKED_EARLIER_HINT amended above.
      fail(units[ui].test, { kind: e.error.kind, message: e.error.message, ...(e.error.hint !== undefined ? { hint: e.error.hint } : {}) });
  // A 200 that answered only some tests of a batch: the unanswered tests are recorded
  // per test here (the batch itself succeeded, so the pool saw no error).
  for (const r of pool.results)
    for (const ui of r.malformed) fail(units[ui].test, { kind: "malformed_response", message: "provider returned no usable answer for this test" });
  if (pool.aborted) {
    // Batches that were dispatched all reported (success or their own error); whatever
    // was never attempted is reported as a breaker error. No cache entries, no answers.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const ui of batches[bi]) fail(units[ui].test, { kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
    }
  }
  // Errored tests never enter all/selected (same rule as jgrep()'s errored chunks);
  // they surface through the returned errors and the caller's exit code.
  const answered = all.filter((s): s is Selected => s !== undefined);
  const selected = answered.filter((s) => s.p >= o.threshold).sort((a, b) => b.p - a.p);
  // `requests` counts only packs actually sent (same rule as scoreRows): packs the breaker
  // never dispatched and packs --budget refused before sending are not requests.
  const budgetRefused = pool.errors.filter((e) => e.error.kind === "budget_exhausted").length;
  return { selected, all: answered, tokens, ...(cost !== undefined ? { cost } : {}), requests: batches.length - (pool.aborted ? pool.unprocessed : 0) - budgetRefused, cached: fromCache, errors };
}

export function loadTests(paths: string[] = ["."], opts: ListOptions = {}): TestFile[] {
  // Same size rule as the code search: the 100 MB ceiling, or the opt-in --max-bytes.
  return withinSize(findTestFiles(listFiles(paths, opts)), opts.maxBytes).map((file) => ({ file, signature: signature(file) }));
}
