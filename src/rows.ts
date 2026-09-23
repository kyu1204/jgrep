// jgrep --rows: every row of a CSV / JSONL file is one state; a question file
// (Jev question objects, passed through verbatim) is asked of every row, many
// rows per request. Output is the table with one answer column per question.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { postSystemOne, RateLimiter, type PostOpts } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";
import {
  DEFAULT_MAX_RETRIES, DEFAULT_REQUEST_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC, KEY_WORKED_EARLIER_HINT,
  MODEL, type Cache, type Fetch,
} from "./jgrep";

export type Row = Record<string, string>;
export type Questions = Record<string, { type: "noul" | "choice" | "score"; instructions: string; [k: string]: unknown }>;
export type Answer = { type: string; noul?: number; choice?: string; score?: number; confidence?: number; probabilities?: Record<string, number> };

// ---- input ------------------------------------------------------------------
export function parseCsv(text: string): { columns: string[]; rows: Row[] } {
  const recs: string[][] = [];
  let rec: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { rec.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rec.push(field); field = ""; recs.push(rec); rec = [];
    } else field += c;
  }
  if (field !== "" || rec.length) { rec.push(field); recs.push(rec); }
  const [columns = [], ...body] = recs.filter((r) => r.some((f) => f !== ""));
  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""])));
  return { columns, rows };
}

export function readRows(file: string): { columns: string[]; rows: Row[] } {
  const text = fs.readFileSync(file, "utf8");
  if (/\.jsonl?$/i.test(file)) {
    const rows: Row[] = file.toLowerCase().endsWith(".json")
      ? JSON.parse(text)
      : text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { columns, rows };
  }
  return parseCsv(text);
}

/** A questions file is a JSON object of Jev questions. A bare string becomes one Noul named `match`. */
export function loadQuestions(fileOrText: string): Questions {
  if (fs.existsSync(fileOrText)) {
    const q = JSON.parse(fs.readFileSync(fileOrText, "utf8")) as Questions;
    for (const [name, spec] of Object.entries(q)) {
      if (!spec || !["noul", "choice", "score"].includes(spec.type) || typeof spec.instructions !== "string")
        throw new Error(`question "${name}" needs {type: noul|choice|score, instructions: "..."}`);
      if (name.includes(".")) throw new Error(`question name "${name}" must not contain "."`);
    }
    return q;
  }
  return { match: { type: "noul", instructions: fileOrText } };
}

// ---- request ----------------------------------------------------------------
export const MAX_QUESTIONS_PER_REQUEST = 64;

export function buildRowsRequest(rows: Row[], questions: Questions) {
  const state = { rows: rows.map((r, i) => ({ id: `r${i}`, ...r })) };
  const qs: Record<string, unknown> = {};
  rows.forEach((_, i) => {
    for (const [name, spec] of Object.entries(questions)) {
      qs[`r${i}.${name}`] = { ...spec, instructions: `Look only at the row with id "r${i}". ${spec.instructions}` };
    }
  });
  return { model: MODEL, state, questions: qs };
}

const key = (qJson: string, r: Row) => createHash("sha1").update(`${MODEL}\0rows\0${qJson}\0${JSON.stringify(r)}`).digest("hex");

export interface RowsOptions {
  batch: number; concurrency: number; apiKey: string;
  timeoutSec?: number;         // per-batch deadline, retries included (defaults shared with jgrep)
  requestTimeoutSec?: number;  // per attempt
  maxRetries?: number;         // failed attempts tolerated before the final error
  ratePerSec?: number;         // token-bucket pacing across all requests; 0/undefined = unlimited
  failFast?: boolean;          // rethrow the first fatal error instead of isolating it
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}

export interface RowError { row: number; kind: JevErrorKind; message: string }
/** answers is position-aligned with the input rows and DENSE: an errored row maps to null,
 *  never a hole (a holey array would desync `map` consumers from the row indices). */
export interface RowsResult { answers: (Record<string, Answer> | null)[]; tokens: number; cached: number; requests: number; errors: RowError[] }

/** One request-pack's outcome; runPool results are completion-ordered, so the pack
 *  index rides along and `answers` is re-associated after the pool settles. */
interface PackOutcome { index: number; rowResults: { row: number; answers: Record<string, Answer> }[] }

export async function scoreRows(rows: Row[], questions: Questions, o: RowsOptions): Promise<RowsResult> {
  const qJson = JSON.stringify(questions);
  const cache = o.cache ?? {};
  const f = o.fetchImpl ?? fetch;
  const answers: (Record<string, Answer> | null)[] = new Array(rows.length).fill(null); // errored rows stay null — dense, never holes
  const todo: number[] = [];
  rows.forEach((r, i) => { const hit = cache[key(qJson, r)]; if (hit) answers[i] = hit; else todo.push(i); });
  // Defensive normalization (same rule as jgrep()): a 0/fractional batch would spin
  // the loop forever (+= 0) or overlap packs. parse() rejects those; library callers
  // get floored and clamped at 1 instead.
  const per = Math.max(1, Math.floor(Math.min(o.batch, Math.floor(MAX_QUESTIONS_PER_REQUEST / Object.keys(questions).length))));
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += per) batches.push(todo.slice(i, i + per));
  // Same defaults and PostOpts wiring as jgrep() — resolved once, read-only in the worker.
  const timeoutMs = (o.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const post: PostOpts = {
    fetchImpl: f,
    requestTimeoutMs: (o.requestTimeoutSec ?? DEFAULT_REQUEST_TIMEOUT_SEC) * 1000,
    maxRetries: o.maxRetries ?? DEFAULT_MAX_RETRIES,
    limiter: o.ratePerSec && o.ratePerSec > 0 ? new RateLimiter(o.ratePerSec, Math.max(1, o.concurrency)) : undefined,
  };
  let tokens = 0;
  // Run-level success flag, same rule as jgrep(): drives the invalid_api_key
  // expired-vs-wrong-key hint. Tracked HERE (not PoolResult) because failFast
  // throws the pool result away.
  let hadSuccess = false;
  const worker = async (b: number[], index: number): Promise<PackOutcome> => {
    const res = await postSystemOne(buildRowsRequest(b.map((i) => rows[i]), questions), o.apiKey, {
      ...post,
      deadlineMs: Date.now() + timeoutMs, // per-batch deadline, retries included
    });
    tokens += res.usage?.input_tokens ?? 0;
    const rowResults = b.map((ri, j) => {
      const a: Record<string, Answer> = {};
      for (const name of Object.keys(questions)) a[name] = res.answers[`r${j}.${name}`] ?? { type: "missing" };
      // Same rule as before: a row with any missing answer is not cached. Complete rows
      // go into the in-memory cache object now — cli.ts persists it in a finally.
      if (Object.values(a).every((x) => x.type !== "missing")) cache[key(qJson, rows[ri])] = a;
      return { row: ri, answers: a };
    });
    hadSuccess = true; // this pack's request succeeded — set before returning
    return { index, rowResults };
  };
  let pool: PoolResult<PackOutcome>;
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
  for (const r of pool.results) for (const rr of r.rowResults) answers[rr.row] = rr.answers;
  // Not failFast: recorded 401/403s get the same expired-vs-wrong-key distinction. One
  // clean place — mutate the JevProviderError's hint in pool.errors BEFORE mapping onto
  // rows (RowError carries only kind+message; the hint stays on the provider error that
  // pool-level consumers see).
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  const errors: RowError[] = pool.errors.flatMap((e) =>
    batches[e.index].map((row) => ({ row, kind: e.error.kind, message: e.error.message })));
  if (pool.aborted) {
    // Packs that were dispatched all reported (success or their own error); whatever was
    // never attempted is reported as a breaker error. No cache entries for those rows.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const row of batches[bi]) errors.push({ row, kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
    }
  }
  // `requests` counts only packs the breaker actually attempted; packs it never
  // dispatched are not requests.
  return { answers, tokens, cached: rows.length - todo.length, requests: batches.length - (pool.aborted ? pool.unprocessed : 0), errors };
}

// ---- output -----------------------------------------------------------------
/** noul -> `q` (probability); choice -> `q` + `q_p`; score -> `q` + `q_conf`. */
export function flatten(a: Record<string, Answer>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, ans] of Object.entries(a)) {
    if (ans.type === "noul") out[name] = round(ans.noul);
    else if (ans.type === "choice") { out[name] = ans.choice ?? ""; out[`${name}_p`] = round(ans.probabilities?.[ans.choice ?? ""]); }
    else if (ans.type === "score") { out[name] = round(ans.score); out[`${name}_conf`] = round(ans.confidence); }
    else out[name] = "";
  }
  return out;
}
const round = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : "");

/** flatten() across a whole RowsResult, position-aligned with the input rows: an errored
 *  row has no answer record and maps to null. The output is DENSE (no holes), so the
 *  rowsMain-style mapping `Number(flat[i]?.match)` can never hit a skipped index. */
export function flattenAnswers(result: RowsResult): (Record<string, string | number> | null)[] {
  return result.answers.map((a) => (a ? flatten(a) : null));
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
