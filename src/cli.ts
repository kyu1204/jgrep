#!/usr/bin/env node
import fs from "node:fs";
import { chunkPaths, diffChunks, gitDiff, jgrep, loadCache, saveCache, resolveApiKey, USD_PER_M_INPUT, type Hit, type Kind } from "./jgrep";
import { readRows, loadQuestions, scoreRows, flattenAnswers, toCsv } from "./rows";
import { loadTests, selectTests } from "./tests";
import { JevProviderError } from "./errors";

const VERSION = "0.3.0";
const USAGE = `jgrep ${VERSION} — semantic grep powered by Jev (TypeSafe)

usage: jgrep init                       interactive setup (API key, agent skills)
       jgrep [options] "<description>" [path ...]
       jgrep [options] --diff [ref] "<description>"
       jgrep [options] --rows <file.csv|.jsonl> "<description>"
       jgrep [options] --rows <file> --questions <q.json> [--out scored.csv]
       jgrep [options] --tests [ref] [--staged] [path ...]

  -t, --threshold <p>   print chunks with probability >= p (default 0.7)
  -C, --show            print the matching chunk body under each hit
  -a, --all             print every chunk with its probability, best first
      --json            machine-readable output
      --diff [ref]      grep git diff hunks instead of files
                        (working tree by default, or against <ref>)
      --staged          with --diff / --tests: staged changes only
      --tests [ref]     predictive test selection: print the test files a diff
                        plausibly affects (working tree, or against <ref>);
                        pipe into your runner:  bun test $(jgrep --tests origin/main)
      --rows <file>     grep rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions (noul/choice/score)
                        asked of every row; prints the table with answer columns
      --out <file>      with --questions: write the CSV here instead of stdout
  -b, --batch <n>       chunks per request (default 16)
  -c, --concurrency <n> parallel requests (default 16)
      --timeout <s>     per-batch deadline, retries included (default 15)
      --request-timeout <s>  per-attempt HTTP timeout (default 30)
      --retries <n>     failed attempts tolerated per batch (default 4)
      --rate <req/s>    global request pacing (token bucket); 0 = unlimited
      --fail-fast       abort on the first fatal error instead of isolating it
      --no-cache        ignore and do not write ~/.cache/jgrep
  -v, --version         print version

exit status: 0 when something matched, 1 when nothing did, 2 on error or when any
chunk/row errored (partial failure: hits and the error breakdown are both reported).
CI lint:    ! jgrep --diff origin/main "adds an endpoint without an auth check"

examples:
  jgrep "catches an error and silently ignores it" src/
  jgrep --rows creators.csv "beauty is the main content of this account"
  jgrep --rows creators.csv --questions beauty.json --out scored.csv
  jgrep -C "reads user input without validating it" app/
  jgrep --diff --staged "changes billing logic without touching tests"`;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export function parse(argv: string[]) {
  const o = {
    threshold: 0.7, batch: 16, concurrency: 16, all: false, show: false, json: false, cache: true,
    diff: null as string[] | null, rows: "", questions: "", out: "", tests: false,
    timeout: 15, requestTimeout: 30, retries: 4, rate: 0, failFast: false,
  };
  const rest: string[] = [];
  const positionalsAfter = (i: number) => argv.slice(i + 1).filter((x) => !x.startsWith("-")).length;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-t" || a === "--threshold") o.threshold = Number(argv[++i]);
    else if (a === "-b" || a === "--batch") o.batch = Number(argv[++i]);
    else if (a === "-c" || a === "--concurrency") o.concurrency = Number(argv[++i]);
    else if (a === "-a" || a === "--all") o.all = true;
    else if (a === "-C" || a === "--show") o.show = true;
    else if (a === "--json") o.json = true;
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--request-timeout") o.requestTimeout = Number(argv[++i]);
    else if (a === "--retries") o.retries = Number(argv[++i]);
    else if (a === "--rate") o.rate = Number(argv[++i]);
    else if (a === "--fail-fast") o.failFast = true;
    else if (a === "--no-cache") o.cache = false;
    else if (a === "--staged") (o.diff ??= []).push("--staged");
    else if (a === "--rows") o.rows = argv[++i] ?? "";
    else if (a === "--questions") o.questions = argv[++i] ?? "";
    else if (a === "--out") o.out = argv[++i] ?? "";
    else if (a === "--tests") {
      o.tests = true; o.diff ??= [];
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && !fs.existsSync(next)) o.diff.push(argv[++i]); // a ref, not a path
    }
    else if (a === "--diff") {
      o.diff ??= [];
      // `--diff <ref>` when a ref follows and the question is still available elsewhere
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && (rest.length > 0 || positionalsAfter(i + 1) > 0)) o.diff.push(argv[++i]);
    }
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else if (a === "-V" || a === "-v" || a === "--version") { console.log(VERSION); process.exit(0); }
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a} (try --help)`);
    else rest.push(a);
  }
  // Per-option numeric validation (review): a zero deadline is meaningless, so the
  // two timeouts must be positive; concurrency and retries count requests/attempts,
  // so they must be whole (>= 1 and >= 0); rate 0 = unlimited and the threshold keep
  // the plain finite/non-negative rule. batch keeps its own check below.
  if (![o.threshold, o.rate].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("numeric option expected");
  if (!Number.isFinite(o.timeout) || o.timeout <= 0) throw new Error("timeout must be a positive number");
  if (!Number.isFinite(o.requestTimeout) || o.requestTimeout <= 0) throw new Error("request-timeout must be a positive number");
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (!Number.isInteger(o.retries) || o.retries < 0) throw new Error("retries must be a non-negative integer");
  // batch < 1 spins the batching loop forever (+= 0) and a fraction overlaps batches.
  if (!Number.isInteger(o.batch) || o.batch < 1) throw new Error("batch must be a positive integer");
  return { ...o, question: rest[0], paths: rest.slice(1) };
}

/** Write `text` to `out` when a path is given (returns true — a file landed), or to
 *  stdout when it is not (false). Keeps the `wrote <out>` stderr line honest. */
export function writeOut(out: string, text: string): boolean {
  if (out) { fs.writeFileSync(out, text); return true; }
  console.log(text);
  return false;
}

/** ` · 4 errored (3 timeout, 1 rate_limited)` — kind counts ordered by count desc, then kind asc. */
function erroredSuffix(errors: { kind: string }[]): string {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, n]) => `${n} ${kind}`);
  return ` · ${errors.length} errored (${parts.join(", ")})`;
}

/** Up to 5 example error lines under the summary, then `… and N more` (stderr, red).
 *  A hint rides under its line as a second grey indented line when the error
 *  carries one (so partial-failure runs are as actionable as fatal throws). */
function printExamples(lines: { line: string; hint?: string }[]) {
  for (const { line, hint } of lines.slice(0, 5)) {
    console.error(c("31", line));
    if (hint) console.error(c("90", `    ${hint}`));
  }
  if (lines.length > 5) console.error(c("31", `  … and ${lines.length - 5} more`));
}

async function main() {
  if (process.argv[2] === "init") { const { init } = await import("./init"); return init(); }
  const o = parse(process.argv.slice(2));
  if (o.tests) return testsMain(o);
  if (o.rows) return rowsMain(o);
  if (!o.question) { console.error(USAGE); process.exit(2); }

  const t0 = Date.now();
  const kind: Kind = o.diff ? "diff" : "code";
  const chunks = o.diff ? diffChunks(gitDiff(o.diff)) : chunkPaths(o.paths.length ? o.paths : ["."]);
  if (!chunks.length) { console.error(o.diff ? "empty diff" : "no text files found"); process.exit(1); }
  const cache = o.cache ? loadCache() : {};
  try {
    const r = await jgrep(o.question, chunks, {
      ...o, kind, apiKey: resolveApiKey(), cache,
      timeoutSec: o.timeout, requestTimeoutSec: o.requestTimeout, maxRetries: o.retries,
      ratePerSec: o.rate || undefined, failFast: o.failFast,
      onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); },
    });
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

    const rows: Hit[] = o.all ? [...r.all].sort((a, b) => b.p - a.p) : r.hits;
    if (o.json) {
      // v0.3.0 contract: the bare hit array, byte-for-byte the old shape. Errored
      // chunks never enter it (they never enter all/hits); they surface via the
      // stderr summary and exit 2.
      console.log(JSON.stringify(rows.map((h) => ({ file: h.file, start: h.start, end: h.end, p: h.p, text: h.text })), null, 2));
    } else {
      for (const h of rows) {
        const head = h.text.split("\n").find((l) => l.trim() && !l.startsWith("@@"))?.trim().slice(0, 90) ?? "";
        const pcol = h.p >= o.threshold ? "32" : "90";
        console.log(`${c("35", h.file)}${c("36", ":")}${c("32", `${h.start}-${h.end}`)}  ${c(pcol, `p=${h.p.toFixed(2)}`)}  ${head}`);
        if (o.show) console.log(h.text.split("\n").map((l) => "    " + l).join("\n") + "\n");
      }
    }
    const cost = (r.tokens * USD_PER_M_INPUT) / 1e6;
    const summary = `${r.hits.length} hits / ${r.chunks} chunks (${r.cached} cached) · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    console.error(c("90", r.errors.length ? summary + erroredSuffix(r.errors) : summary));
    printExamples(r.errors.map((e) => ({ line: `  ${e.kind}: ${e.file}:${e.start}-${e.end} ${e.message.slice(0, 120)}` })));
    // grep semantics when clean; 2 when any chunk errored (partial failure).
    process.exitCode = r.errors.length > 0 ? 2 : (r.hits.length > 0 ? 0 : 1);
  } finally {
    // Cache save on success, partial failure, breaker abort AND a --fail-fast throw;
    // --no-cache still skips (o.cache false leaves `cache` a throwaway object).
    if (o.cache) saveCache(cache);
  }
}

async function testsMain(o: ReturnType<typeof parse>) {
  const t0 = Date.now();
  const diff = gitDiff(o.diff ?? []);
  if (!diff.trim()) { console.error("empty diff"); process.exit(1); }
  const paths = [o.question, ...o.paths].filter((p): p is string => !!p);
  const tests = loadTests(paths.length ? paths : ["."]);
  if (!tests.length) { console.error("no test files found"); process.exit(1); }
  const threshold = o.threshold === 0.7 ? 0.5 : o.threshold; // recall matters more here
  const cache = o.cache ? loadCache() : {};
  try {
    const r = await selectTests(diff, tests, {
      ...o, threshold, apiKey: resolveApiKey(), cache,
      timeoutSec: o.timeout, requestTimeoutSec: o.requestTimeout, maxRetries: o.retries,
      ratePerSec: o.rate || undefined, failFast: o.failFast,
      onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); },
    });
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    const rows = o.all ? [...r.all].sort((a, b) => b.p - a.p) : r.selected;
    if (o.json) console.log(JSON.stringify(rows, null, 2));
    else for (const s of rows) console.log(o.all || process.stdout.isTTY ? `${s.file}${c("90", `  p=${s.p.toFixed(2)} ${s.reason}`)}` : s.file);
    const cost = (r.tokens * USD_PER_M_INPUT) / 1e6;
    const summary = `${r.selected.length} of ${tests.length} tests selected (${r.all.filter((s) => s.reason === "direct" || s.reason === "import").length} by name/import, ${r.cached} cached) · ${r.requests} requests · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    console.error(c("90", r.errors.length ? summary + erroredSuffix(r.errors) : summary));
    printExamples(r.errors.map((e) => ({ line: `  ${e.kind}: ${e.file} ${e.message.slice(0, 120)}`, hint: e.hint })));
    // grep semantics when clean; 2 when any batch errored (partial failure) — same rule as code mode.
    process.exitCode = r.errors.length > 0 ? 2 : (r.selected.length ? 0 : 1);
  } finally {
    // Same rule as code mode: save on success, partial failure, breaker abort and
    // --fail-fast throw; --no-cache still skips.
    if (o.cache) saveCache(cache);
  }
}

async function rowsMain(o: ReturnType<typeof parse>) {
  if (!o.questions && !o.question) { console.error(USAGE); process.exit(2); }
  const t0 = Date.now();
  const { columns, rows } = readRows(o.rows);
  if (!rows.length) { console.error("no rows"); process.exit(1); }
  const questions = loadQuestions(o.questions || o.question);
  const cache = o.cache ? loadCache() : {};
  try {
    const r = await scoreRows(rows, questions, {
      ...o, apiKey: resolveApiKey(), cache,
      timeoutSec: o.timeout, requestTimeoutSec: o.requestTimeout, maxRetries: o.retries,
      ratePerSec: o.rate || undefined, failFast: o.failFast,
      onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); },
    });
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

    const flat = flattenAnswers(r); // dense: errored rows are null, never holes
    let hits = rows.length;
    let wrote = false;
    if (o.questions) {
      const qCols = [...new Set(flat.flatMap((f) => (f ? Object.keys(f) : [])))]; // errored rows contribute no answer columns
      const table = rows.map((row, i) => ({ ...row, ...(flat[i] ?? {}) }));
      // v0.3.0 contract: the JSON is the merged table rows (row fields + answer columns).
      if (o.json) wrote = writeOut(o.out, JSON.stringify(table, null, 2));
      else if (o.out) { fs.writeFileSync(o.out, toCsv([...columns, ...qCols], table)); wrote = true; }
      else process.stdout.write(toCsv([...columns, ...qCols], table));
    } else {
      // single description: grep-style hits, like the code mode
      const scored = rows
        .map((row, i) => ({ row, i, p: Number(flat[i]?.match ?? NaN) }))
        .filter((s) => Number.isFinite(s.p)); // errored rows carry no usable match: skipped, never a TypeError
      const shown = o.all ? [...scored].sort((a, b) => b.p - a.p) : scored.filter((s) => s.p >= o.threshold);
      hits = scored.filter((s) => s.p >= o.threshold).length;
      // v0.3.0 contract: the JSON is the SHOWN hits — the source row number (header + 1-based
      // = i + 2), the probability, then the row's own fields. Errored rows never enter
      // `scored`, so they can never appear here.
      if (o.json) wrote = writeOut(o.out, JSON.stringify(shown.map((s) => ({ row: s.i + 2, p: s.p, ...s.row })), null, 2));
      if (!o.json || o.out) for (const s of shown) { // with --json --out the JSON went to the file; stdout keeps the pretty hits
        const preview = Object.values(s.row).filter(Boolean).join(" | ").slice(0, 90);
        const pcol = s.p >= o.threshold ? "32" : "90";
        console.log(`${c("35", o.rows)}${c("36", ":")}${c("32", String(s.i + 2))}  ${c(pcol, `p=${s.p.toFixed(2)}`)}  ${preview}`);
      }
    }
    const cost = (r.tokens * USD_PER_M_INPUT) / 1e6;
    const summary = `${o.questions ? Object.keys(questions).length + " questions x " : hits + " hits / "}${rows.length} rows (${r.cached} cached) · ${r.requests} requests · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    console.error(c("90", r.errors.length ? summary + erroredSuffix(r.errors) : summary));
    printExamples(r.errors.map((e) => ({ line: `  ${e.kind}: row ${e.row} ${e.message.slice(0, 120)}` })));
    if (wrote) console.error(c("90", `wrote ${o.out}`)); // only when a file actually landed
    // grep semantics when clean; 2 when any row errored (partial failure) — same rule as code mode.
    process.exitCode = r.errors.length > 0 ? 2 : (o.questions || hits ? 0 : 1);
  } finally {
    // Same rule as code mode: save on success, partial failure, breaker abort and
    // --fail-fast throw; --no-cache still skips.
    if (o.cache) saveCache(cache);
  }
}

if (!process.env.JGREP_NO_MAIN) main().catch((e) => {
  if (e instanceof JevProviderError) {
    console.error(c("31", `${e.kind}: ${e.message}`));
    if (e.hint) console.error(c("90", `  ${e.hint}`));
  } else {
    console.error(c("31", e.message));
  }
  process.exit(2);
});
