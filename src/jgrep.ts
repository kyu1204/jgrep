// jgrep core: split files (or git diff hunks) into chunks, ask Jev one yes/no
// question per chunk with many chunks per request, return probabilities.
// No index, no embeddings, no dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { abortDelayMs, postSystemOne, RateLimiter, type PostOpts } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";
export const USD_PER_M_INPUT = 0.042;

export interface Chunk { file: string; start: number; end: number; text: string }
export interface Hit extends Chunk { p: number }
export type Kind = "code" | "diff";
export type Fetch = typeof fetch;

// ---- chunking ---------------------------------------------------------------
// ponytail: language-agnostic heuristic (column-0 line starts a new block).
// Swap in tree-sitter per language when this misfires on real code.
export function chunk(file: string, text: string, opts = { minLines: 5, maxLines: 60 }): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let start = 0;
  const flush = (end: number) => {
    const t = lines.slice(start, end).join("\n");
    if (t.trim()) out.push({ file, start: start + 1, end, text: t });
    start = end;
  };
  for (let i = 1; i < lines.length; i++) {
    const len = i - start;
    const boundary = /^[^\s})\]]/.test(lines[i]) && !/^(else|catch|finally|\.)/.test(lines[i]);
    if (len >= opts.maxLines || (boundary && len >= opts.minLines)) flush(i);
  }
  flush(lines.length);
  return out;
}

/** Hunks of `git diff <args>` as chunks; text keeps the +/- markers. */
export function diffChunks(diff: string): Chunk[] {
  const out: Chunk[] = [];
  let file = "";
  let cur: Chunk | null = null;
  const push = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { push(); file = line.slice(4).replace(/^b\//, ""); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      push();
      const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
      if (file === "/dev/null") continue;
      cur = { file, start, end: Math.max(start, start + count - 1), text: "" };
      continue;
    }
    if (line.startsWith("diff --git")) { push(); continue; }
    if (cur) cur.text += (cur.text ? "\n" : "") + line;
  }
  push();
  return out;
}

export function gitDiff(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", ["diff", "--no-color", "--unified=3", ...args], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
}

// ---- files ------------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor"]);

export function listFiles(paths: string[]): string[] {
  const files = new Set<string>();
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error(`no such path: ${p}`);
    if (fs.statSync(p).isFile()) { files.add(p); continue; }
    try {
      execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\0").filter(Boolean).forEach((f) => files.add(f));
    } catch {
      walk(p, files);
    }
  }
  return [...files].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }).sort();
}

const MAX_WALK_FILES = 5000;
function walk(root: string, out: Set<string>, dir = root) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    if (out.size > MAX_WALK_FILES) {
      const shown = path.resolve(root) === process.cwd() ? "the current directory" : root;
      throw new Error(`${shown} is not a git repo and has more than ${MAX_WALK_FILES} files.\n` +
        `Run jgrep inside a project, or pass its path:  jgrep "..." ~/Documents/<project>`);
    }
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(root, out, p) : out.add(p);
  }
}

export function readText(file: string): string | null {
  const st = fs.statSync(file);
  if (st.size > 1_000_000) return null;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString("utf8");
}

export function chunkPaths(paths: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of listFiles(paths)) {
    const text = readText(file);
    if (text !== null) chunks.push(...chunk(file, text));
  }
  return chunks;
}

// ---- Jev --------------------------------------------------------------------
export function buildRequest(question: string, chunks: Chunk[], kind: Kind = "code") {
  const state = { chunks: chunks.map((c, i) => ({ id: `c${i}`, file: c.file, lines: `${c.start}-${c.end}`, [kind]: c.text })) };
  const what = kind === "diff"
    ? "Does that diff hunk (lines starting with + were added, - removed) match this description"
    : "Does that code match this description";
  const questions: Record<string, unknown> = {};
  chunks.forEach((_, i) => {
    questions[`c${i}`] = { type: "noul", instructions: `Look only at the chunk with id "c${i}". ${what}: ${question}` };
  });
  return { model: MODEL, state, questions };
}

// ---- cache ------------------------------------------------------------------
// ponytail: one JSON file; move to sqlite if it passes a few MB.
const CACHE_FILE = path.join(os.homedir(), ".cache", "jgrep", "cache.json");
export type Cache = Record<string, any>;
export function loadCache(): Cache {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
export function saveCache(c: Cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch { /* cache is best-effort */ }
}
const key = (q: string, kind: Kind, c: Chunk) => createHash("sha1").update(`${MODEL}\0${kind}\0${q}\0${c.text}`).digest("hex");

// ---- core -------------------------------------------------------------------
// Retry/deadline defaults live in ONE place (here); jgrep()/scoreRows() resolve
// them once per run and the pool workers only read the resolved values.
export const DEFAULT_TIMEOUT_SEC = 15;         // per-batch deadline INCLUDING retries
export const DEFAULT_REQUEST_TIMEOUT_SEC = 30; // per attempt
export const DEFAULT_MAX_RETRIES = 4;          // => 5 total attempts

export interface Options {
  threshold: number; batch: number; concurrency: number; apiKey: string; kind?: Kind;
  timeoutSec?: number;         // per-batch deadline, retries included
  requestTimeoutSec?: number;  // per attempt
  maxRetries?: number;         // failed attempts tolerated before the final error
  ratePerSec?: number;         // token-bucket pacing across all requests; 0/undefined = unlimited
  failFast?: boolean;          // rethrow the first fatal error instead of isolating it
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}
export interface ChunkError { file: string; start: number; end: number; kind: JevErrorKind; message: string }
export interface Result { hits: Hit[]; all: Hit[]; chunks: number; tokens: number; cached: number; errors: ChunkError[] }

/** What one batch worker hands back; runPool results are completion-ordered, so the
 *  batch index rides along and `all` is re-associated after the pool settles. A
 *  partial 200 (the provider answered some chunks but not others) is NOT a hit:
 *  unanswered chunk indices come back in `malformed` and the caller records them as
 *  malformed_response ChunkErrors — otherwise they would surface as p:NaN entries. */
interface BatchOutcome { index: number; entries: { chunkIndex: number; p: number }[]; malformed: number[] }

/** Appended to an invalid_api_key hint when at least one batch succeeded earlier in the
 *  SAME run: a 401/403 then means the key expired/was revoked, not that the user handed
 *  over the wrong key. */
export const KEY_WORKED_EARLIER_HINT = "the key worked earlier this run — it may have been expired or revoked";

export async function jgrep(question: string, chunks: Chunk[], o: Options): Promise<Result> {
  const kind = o.kind ?? "code";
  const cache = o.cache ?? {};
  const f = o.fetchImpl ?? fetch;
  const all: (Hit | undefined)[] = new Array(chunks.length); // errored chunks stay unset
  const todo: number[] = [];
  chunks.forEach((c, i) => {
    const hit = cache[key(question, kind, c)];
    if (hit !== undefined) all[i] = { ...c, p: hit }; else todo.push(i);
  });
  const cached = chunks.length - todo.length;
  // Defensive normalization: a 0/fractional batch would spin the loop forever (+= 0)
  // or overlap batches. parse() rejects those; library callers get clamped instead.
  const batch = Math.max(1, Math.floor(o.batch));
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += batch) batches.push(todo.slice(i, i + batch));
  // One resolution of the retry/deadline options for the whole run (the worker only reads these).
  const timeoutMs = (o.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const post: PostOpts = {
    fetchImpl: f,
    requestTimeoutMs: (o.requestTimeoutSec ?? DEFAULT_REQUEST_TIMEOUT_SEC) * 1000,
    maxRetries: o.maxRetries ?? DEFAULT_MAX_RETRIES,
    limiter: o.ratePerSec && o.ratePerSec > 0 ? new RateLimiter(o.ratePerSec, Math.max(1, o.concurrency)) : undefined,
  };
  let tokens = 0;
  // Run-level success flag: drives the invalid_api_key expired-vs-wrong-key hint.
  // Tracked HERE (not PoolResult) because failFast throws the pool result away.
  let hadSuccess = false;
  const worker = async (b: number[], index: number): Promise<BatchOutcome> => {
    const res = await postSystemOne(buildRequest(question, b.map((i) => chunks[i]), kind), o.apiKey, {
      ...post,
      deadlineMs: Date.now() + timeoutMs, // per-batch deadline, retries included
    });
    tokens += res.usage?.input_tokens ?? 0;
    // Finite p-values go straight into the in-memory cache object: cli.ts persists it in
    // a finally, so answers paid for survive even when other batches fail. A chunk the
    // provider did not answer (missing or non-finite p on a 200) is skipped here and
    // reported as malformed_response — never a p:NaN entry in all/hits.
    const entries: { chunkIndex: number; p: number }[] = [];
    const malformed: number[] = [];
    b.forEach((ci, j) => {
      const p = res.answers[`c${j}`]?.noul;
      if (Number.isFinite(p)) {
        cache[key(question, kind, chunks[ci])] = p;
        entries.push({ chunkIndex: ci, p });
      } else malformed.push(ci);
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
  for (const r of pool.results) for (const e of r.entries) all[e.chunkIndex] = { ...chunks[e.chunkIndex], p: e.p };
  // Not failFast: recorded 401/403s get the same expired-vs-wrong-key distinction. One
  // clean place — mutate the JevProviderError's hint in pool.errors BEFORE mapping onto
  // chunks (ChunkError carries only kind+message; the hint stays on the provider error
  // that pool-level consumers see).
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  const errors: ChunkError[] = pool.errors.flatMap((e) =>
    batches[e.index].map((ci) => ({ file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: e.error.kind, message: e.error.message })));
  // A 200 that answered only some chunks of a batch: the unanswered chunks are
  // recorded per chunk here (the batch itself succeeded, so the pool saw no error).
  for (const r of pool.results)
    for (const ci of r.malformed)
      errors.push({ file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: "malformed_response", message: "provider returned no usable answer for this chunk" });
  if (pool.aborted) {
    // Batches that were dispatched all reported (success or their own error); whatever
    // was never attempted is reported as a breaker error. No cache entries, no hits.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const ci of batches[bi]) {
        errors.push({ file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
      }
    }
  }
  const hits: Hit[] = [];
  const ordered: Hit[] = [];
  for (const h of all) if (h) { ordered.push(h); if (h.p >= o.threshold) hits.push(h); }
  return { hits, all: ordered, chunks: chunks.length, tokens, cached, errors };
}

// ---- config -----------------------------------------------------------------
export const CONFIG_FILE = path.join(os.homedir(), ".config", "jgrep", "env");

export function resolveApiKey(env = process.env): string {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
  for (const file of [path.join(process.cwd(), ".env"), CONFIG_FILE]) {
    try {
      const m = fs.readFileSync(file, "utf8").match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n#]+)/m);
      if (m) return m[1].trim();
    } catch { /* next */ }
  }
  throw new Error("No TypeSafe API key. Run `jgrep init` (or export TYPESAFE_API_KEY).");
}

/** Cheapest possible request; true when the key is accepted. */
export async function verifyApiKey(apiKey: string, f: typeof fetch = fetch): Promise<{ ok: boolean; status: number; model?: string }> {
  const res = await f(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: "ping", questions: { ok: { type: "noul", instructions: "Is the state the word ping?" } } }),
    signal: AbortSignal.timeout(abortDelayMs(15_000)), // literal int — floored for uniformity (Node integer contract)
  });
  const model = res.ok ? ((await res.json()) as { model?: string }).model : undefined;
  return { ok: res.ok, status: res.status, model };
}

export function saveApiKey(apiKey: string): string {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `TYPESAFE_API_KEY=${apiKey}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}

/** Copy the bundled SKILL.md into each agent's skills dir that exists. Returns the dirs written. */
export function installSkills(skillSrc: string, home = os.homedir(), agents = ["claude", "codex"]): string[] {
  const out: string[] = [];
  for (const a of agents) {
    const base = path.join(home, `.${a}`);
    if (!fs.existsSync(base)) continue;
    const dir = path.join(base, "skills", "jgrep");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(skillSrc, path.join(dir, "SKILL.md"));
    out.push(dir);
  }
  return out;
}
