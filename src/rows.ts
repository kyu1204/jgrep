// jgrep --rows: every row of a CSV / JSONL file is one state; a question file
// (Jev question objects, passed through verbatim) is asked of every row, many
// rows per request. Output is the table with one answer column per question.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { chainFor, DEFAULT_PRICE_PER_MTOK, RateLimiter, type Backend, type Fetch, type JevAnswer, type PostOpts, type ProviderChain } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";
import {
  DEFAULT_MAX_RETRIES, DEFAULT_REQUEST_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC, HARD_MAX_BYTES, KEY_WORKED_EARLIER_HINT, MAX_REQUEST_BYTES,
  BudgetMeter, byteLen, fitChunk, normalizeForCache, packBatches, settledCost, type Cache, type Estimate,
} from "./jgrep";

export type Row = Record<string, string>;
export type Questions = Record<string, { type: "noul" | "choice" | "score"; instructions: string; [k: string]: unknown }>;
export type Answer = JevAnswer;

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
  // The same 100 MB hard ceiling as code search (USER: "just to prevent system hangs"): the
  // whole file is parsed in memory, so a bigger one is refused instead of read.
  if (fs.statSync(file).size > HARD_MAX_BYTES) throw new Error(`${file} is over the 100 MB hard ceiling — split it`);
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

export function buildRowsRequest(rows: Row[], questions: Questions, model = "jev-latest") {
  const state = { rows: rows.map((r, i) => ({ id: `r${i}`, ...r })) };
  const qs: Record<string, unknown> = {};
  rows.forEach((_, i) => {
    for (const [name, spec] of Object.entries(questions)) {
      qs[`r${i}.${name}`] = { ...spec, instructions: `Look only at the row with id "r${i}". ${spec.instructions}` };
    }
  });
  return { model, state, questions: qs };
}

// Cache key (WI-6): the row — the judged content of rows mode — is normalized before
// hashing: every string value goes through normalizeForCache (trailing whitespace
// stripped, blank lines dropped, leading indentation KEPT — B2), so trailing-space,
// blank-line and line-ending churn in a CSV/JSONL value does not re-bill; any content
// or indentation change does.
// Model and question JSON stay verbatim. Vote/verify-style suffixes (none here yet)
// would compose after this normalized base.
const normalizeRow = (r: Row) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, normalizeForCache(v)]));
const key = (model: string, qJson: string, r: Row) =>
  createHash("sha1").update(`${model}\0rows\0${qJson}\0${JSON.stringify(normalizeRow(r))}`).digest("hex");

export interface RowsOptions {
  batch: number; concurrency: number; apiKey?: string;
  backend?: Backend; model?: string;
  chain?: ProviderChain;       // the CLI's providers.json chain (TRDD-3KBUODCE); wins over backend/model/apiKey
  timeoutSec?: number;         // per-batch deadline, retries included (defaults shared with jgrep)
  requestTimeoutSec?: number;  // per attempt
  maxRetries?: number;         // failed attempts tolerated before the final error
  ratePerSec?: number;         // token-bucket pacing across all requests; 0/undefined = unlimited
  failFast?: boolean;          // rethrow the first fatal error instead of isolating it
  estimate?: Estimate;         // dry run: count requests/chars into this sink, never call the provider
  meter?: BudgetMeter;         // a caller-owned meter (the CLI reads its under-pricing check); else built from budget
  budget?: number;             // --budget: hard cap via reservation, same as jgrep(); undefined = no cap
  pricePerMtok?: number;       // $/Mtok for the budget reservation and token-priced spend (default DEFAULT_PRICE_PER_MTOK)
  defaultLabel?: string;       // --default: the catch-all choice label (else each choice question's last criterion)
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}

export interface RowError { row: number; kind: JevErrorKind; message: string; hint?: string }
/** answers is position-aligned with the input rows and DENSE: an errored row maps to null,
 *  never a hole (a holey array would desync `map` consumers from the row indices). */
export interface RowsResult { answers: (Record<string, Answer> | null)[]; tokens: number; cached: number; requests: number; errors: RowError[]; cost?: number }

/** One request-pack's outcome; runPool results are completion-ordered, so the pack
 *  index rides along and `answers` is re-associated after the pool settles. */
interface PackOutcome { index: number; unitResults: { unit: number; answers: Record<string, Answer>; model: string }[] }

/** A row's JSON over this many bytes is judged in parts (half a request: room for the
 *  questions and the other rows of a pack). */
export const ROW_PART_BYTES = MAX_REQUEST_BYTES / 2;

/** USER 2026-10-02: never truncate to fit the context — split. A row over ROW_PART_BYTES
 *  becomes several part-rows: its small fields repeated in every part, each big field cut
 *  into context-sized pieces (line boundaries with overlap, giant lines by characters) and
 *  part k carrying piece k of every big field. A row that fits is returned as-is. */
export function rowParts(row: Row, maxBytes: number = ROW_PART_BYTES): Row[] {
  if (byteLen(JSON.stringify(row)) <= maxBytes) return [row];
  const entries = Object.entries(row);
  const share = Math.floor(maxBytes / entries.length);
  const big = entries.filter(([, v]) => byteLen(v) > share);
  const small = Object.fromEntries(entries.filter(([, v]) => byteLen(v) <= share));
  const room = Math.max(1, Math.floor((maxBytes - byteLen(JSON.stringify(small))) / big.length));
  const pieces = big.map(([k, v]) => [k, fitChunk({ file: k, start: 1, end: v.split("\n").length, text: v }, "code", room).map((c) => c.text)] as const);
  const n = Math.max(...pieces.map(([, ps]) => ps.length));
  return Array.from({ length: n }, (_, i) => ({ ...row, ...small, ...Object.fromEntries(pieces.map(([k, ps]) => [k, ps[i] ?? ""])) }));
}

/** A choice answer's most probable label and its probability (its own `choice` and any
 *  `confidence` field are not consulted). */
const topLabel = (a: Answer): [string, number] | undefined => {
  if (a.type !== "choice" || !a.probabilities) return undefined;
  let top: [string, number] | undefined;
  for (const [label, p] of Object.entries(a.probabilities)) if (Number.isFinite(p) && (!top || p > top[1])) top = [label, p];
  return top;
};

/** A choice question's labels: the keys of its `criteria` record (an array's items). */
export const choiceLabels = (spec: Questions[string] | undefined): string[] => {
  const c = spec?.criteria;
  return Array.isArray(c) ? c.map(String) : c && typeof c === "object" ? Object.keys(c) : [];
};

/** USER 2026-10-02: a per-ROW verdict judged in parts takes the best part: noul -> the
 *  highest probability, score -> the highest score. Choice — USER 2026-10-02, "Best real
 *  evidence wins" (replacing the per-label maximum, which let many confident filler parts
 *  outvote the one part that held the evidence): the default/catch-all label is the LAST
 *  criterion unless `defaultLabel` (--default) names another. A part votes only if its top
 *  label is NOT the default; among voting parts the highest top probability wins and that
 *  part is reported. If no part votes, the row gets the default label at its best score.
 *  Missing answers lose to any real one. A single part is returned unchanged. */
export function combineParts(parts: Record<string, Answer>[], questions: Questions = {}, defaultLabel?: string): Record<string, Answer> {
  if (parts.length === 1) return parts[0];
  const strength = (a: Answer): number =>
    a.type === "noul" ? (a.noul ?? -Infinity)
      : a.type === "score" ? (a.score ?? -Infinity)
      : -Infinity; // "missing"
  const max = (as: Answer[], f: (a: Answer) => number) => as.reduce((b, a) => (f(a) > f(b) ? a : b));
  const out: Record<string, Answer> = {};
  for (const name of Object.keys(parts[0])) {
    const as = parts.map((p) => p[name]);
    if (!as.some((a) => topLabel(a))) { out[name] = max(as, strength); continue; }
    const dflt = defaultLabel ?? choiceLabels(questions[name]).at(-1);
    const votes = as.filter((a) => { const t = topLabel(a); return t !== undefined && t[0] !== dflt; });
    if (votes.length) {
      const best = max(votes, (a) => topLabel(a)![1]);
      out[name] = { ...best, choice: topLabel(best)![0] };
    } else {
      const p = (a: Answer) => (a.type === "choice" ? (a.probabilities?.[dflt ?? ""] ?? -Infinity) : -Infinity);
      out[name] = { ...max(as, p), choice: dflt };
    }
  }
  return out;
}

export async function scoreRows(rows: Row[], questions: Questions, o: RowsOptions): Promise<RowsResult> {
  // Same chain rule as jgrep(): the CLI's providers.json chain, else one backend with a lazy key.
  const chain = chainFor(o);
  const model = chain.model();
  const models = chain.models(); // a cached row from any model of the chain is served, the head's first
  // --default changes a split row's choice verdict (combineParts), so it is part of the cache
  // key — only when given, so caches written without it stay valid.
  const qJson = JSON.stringify(questions) + (o.defaultLabel !== undefined ? `\0default=${o.defaultLabel}` : "");
  const cache = o.cache ?? {};
  const f = o.fetchImpl ?? fetch;
  const answers: (Record<string, Answer> | null)[] = new Array(rows.length).fill(null); // errored rows stay null — dense, never holes
  const todo: number[] = [];
  rows.forEach((r, i) => {
    const hit = models.map((m) => cache[key(m, qJson, r)]).find((x) => x !== null && typeof x === "object");
    if (hit !== null && typeof hit === "object") answers[i] = hit as Record<string, Answer>; else todo.push(i);
  });
  // Defensive normalization (same rule as jgrep()): a 0/fractional batch would spin
  // the loop forever (+= 0) or overlap packs. parse() rejects those; library callers
  // get floored and clamped at 1 instead.
  const per = Math.max(1, Math.floor(Math.min(o.batch, Math.floor(MAX_QUESTIONS_PER_REQUEST / Object.keys(questions).length))));
  // Units = (row, part): an oversized row is judged in parts (rowParts) and its verdict is
  // the best part's (combineParts). Packs hold at most `per` units AND MAX_REQUEST_BYTES of
  // request, so a pack of big rows is split into smaller packs instead of overflowing.
  const units = todo.flatMap((row) => rowParts(rows[row]).map((data) => ({ row, data })));
  const partsOf = new Map<number, number>();
  for (const u of units) partsOf.set(u.row, (partsOf.get(u.row) ?? 0) + 1);
  const unitIdx = units.map((_, i) => i);
  const batches = packBatches(unitIdx, per, MAX_REQUEST_BYTES, (ui) => byteLen(JSON.stringify(buildRowsRequest([units[ui].data], questions, model))));
  // Same defaults and PostOpts wiring as jgrep() — resolved once, read-only in the worker.
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
  // Run-level success flag (plan §1.5), same rule as jgrep(): drives the invalid_api_key
  // expired-vs-wrong-key hint. Tracked HERE (not PoolResult) because failFast throws the
  // pool result away.
  let hadSuccess = false;
  // --budget (B4): rows used to ignore the budget entirely (cli.ts passed it, RowsOptions
  // dropped it). Same opt-in reservation meter as jgrep(); no budget = no meter.
  // --budget (B4): rows used to ignore the budget entirely (cli.ts passed it, RowsOptions
  // dropped it). Same opt-in reservation meter as jgrep(); no budget = no meter. The meter
  // is passed into post() (TRDD-3KBUODCE): each chain entry reserves at its own usd_per_mtok.
  const meter = o.meter ?? (o.budget !== undefined ? new BudgetMeter(o.budget, price) : undefined);
  if (meter) post.meter = meter;
  const worker = async (b: number[], index: number): Promise<PackOutcome> => {
    const req = buildRowsRequest(b.map((ui) => units[ui].data), questions, model);
    // --estimate: count before any provider is asked, so a dry run needs no key.
    if (o.estimate) { o.estimate.requests++; o.estimate.chars += JSON.stringify(req).length; return { index, unitResults: [] }; }
    // per-batch deadline per provider, retries included (§1.6.1); --budget reserves per
    // provider inside post() (TRDD-3KBUODCE): a free local server (mlx, 0) is reached even
    // when the budget is nearly spent.
    const res = await chain.post(req, post, timeoutMs);
    tokens += res.usage?.input_tokens ?? 0;
    cost = (cost ?? 0) + settledCost(res, price);
    const unitResults = b.map((ui, j) => {
      const a: Record<string, Answer> = {};
      for (const name of Object.keys(questions)) a[name] = res.answers[`r${j}.${name}`] ?? { type: "missing" };
      return { unit: ui, answers: a, model: res.via.model };
    });
    hadSuccess = true; // this pack's request succeeded — set before returning (plan §1.5)
    return { index, unitResults };
  };
  let pool: PoolResult<PackOutcome>;
  try {
    pool = await runPool(batches, {
      concurrency: o.concurrency,
      failFast: o.failFast,
      onProgress: o.onProgress ? (done, total) => o.onProgress!(done, total) : undefined,
    }, worker);
  } catch (e) {
    // failFast: runPool rethrows the first fatal error and PoolResult.hadSuccess is lost
    // with it, so the run-level flag above is the only remaining evidence that the key
    // worked earlier this run. Amend the hint; otherwise rethrow untouched.
    if (e instanceof JevProviderError && isFatalError(e) && e.kind === "invalid_api_key" && hadSuccess)
      e.hint = [e.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    throw e;
  }
  // A row's verdict needs ALL its parts answered; then the best part wins (combineParts).
  // Same caching rule as before: a row with any missing answer is not cached; complete
  // rows go into the in-memory cache object — cli.ts persists it in a finally (Step 7).
  const got = new Map<number, { answers: Record<string, Answer>; model: string }[]>();
  for (const r of pool.results) for (const ur of r.unitResults) {
    const row = units[ur.unit].row;
    got.set(row, [...(got.get(row) ?? []), ur]);
  }
  for (const [row, parts] of got) {
    if (parts.length !== partsOf.get(row)) continue; // a part errored: the row is reported below, never half-judged
    const a = combineParts(parts.map((p) => p.answers), questions, o.defaultLabel);
    answers[row] = a;
    // Cached under the model that answered (a fallback provider's, possibly). ponytail: a row
    // judged in parts by two different providers is not cached at all; it is re-judged next run.
    const models = new Set(parts.map((p) => p.model));
    if (models.size === 1 && Object.values(a).every((x) => x.type !== "missing")) cache[key([...models][0], qJson, rows[row])] = a;
  }
  // Not failFast: recorded 401/403s get the same expired-vs-wrong-key distinction. One
  // clean place — mutate the JevProviderError's hint in pool.errors BEFORE mapping onto
  // rows, so the amended hint is what RowError carries down to the CLI.
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  // One error per row (a row judged in several parts may fail in several packs).
  const erroredRows = new Set<number>();
  const errors: RowError[] = pool.errors.flatMap((e) =>
    [...new Set(batches[e.index].map((ui) => units[ui].row))].filter((row) => !erroredRows.has(row) && erroredRows.add(row)).map((row) => ({
      row, kind: e.error.kind, message: e.error.message,
      // The provider error's actionable hint rides along (same rule as jgrep()'s
      // ChunkError) — incl. the KEY_WORKED_EARLIER_HINT amended above.
      ...(e.error.hint !== undefined ? { hint: e.error.hint } : {}),
    })));
  if (pool.aborted) {
    // Packs that were dispatched all reported (success or their own error); whatever was
    // never attempted is reported as a breaker error. No cache entries for those rows.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const ui of batches[bi]) {
        const row = units[ui].row;
        if (erroredRows.has(row)) continue;
        erroredRows.add(row);
        errors.push({ row, kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
      }
    }
  }
  // `requests` counts only packs actually sent: packs the breaker never dispatched and
  // packs --budget refused before sending (B4) are not requests.
  const budgetRefused = pool.errors.filter((e) => e.error.kind === "budget_exhausted").length;
  return { answers, tokens, cached: rows.length - todo.length, requests: batches.length - (pool.aborted ? pool.unprocessed : 0) - budgetRefused, errors, ...(cost !== undefined ? { cost } : {}) };
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

/** A text cell a spreadsheet would run as a formula (=, +, -, @, TAB, CR first) gets a
 *  leading `'` (OWASP CSV-injection guidance, audit NIT); plain numbers such as -5 or +1.5
 *  are left alone so numeric columns stay numeric. */
const FORMULA_RE = /^[=+\-@\t\r]/;
const NUMBER_TEXT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (typeof v === "string" && FORMULA_RE.test(s) && !NUMBER_TEXT_RE.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
