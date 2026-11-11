// jgrep core: split files (or git diff hunks) into chunks, ask Jev one yes/no
// question per chunk with many chunks per request, return probabilities.
// No index, no embeddings, no dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chainFor, DEFAULT_PRICE_PER_MTOK, jgrepHome, RateLimiter, type Backend, type Fetch, type PostOpts, type ProviderChain } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";
import { detectLanguage, signatureChunks } from "./funcs";

// DI seam for fetch (moved to providers.ts; re-exported so existing imports keep working)
export type { Fetch };

export interface Chunk { file: string; start: number; end: number; text: string; context?: string }
/** A hit may carry a --tag (WI-4) verdict: the winning category name and its probability. */
export interface Hit extends Chunk { p: number; tag?: string; tag_p?: number }
export type Kind = "code" | "diff";

// ---- chunking ---------------------------------------------------------------
// Language-agnostic heuristic: a column-0 line starts a new block. Swap in
// tree-sitter per language when this misfires on real code.
/** Chunk size in lines (cli.ts USAGE states both): a column-0 line closes a chunk once it
 *  has CHUNK_MIN_LINES, and no chunk grows past CHUNK_MAX_LINES. */
export const CHUNK_MIN_LINES = 5;
export const CHUNK_MAX_LINES = 60;
export function chunk(file: string, text: string, opts = { minLines: CHUNK_MIN_LINES, maxLines: CHUNK_MAX_LINES }): Chunk[] {
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

const MD_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".mkd", ".mdown"]);

/** True for markdown files, which get heading-aware chunking instead of column-0 splits. */
export function isMarkdownPath(file: string): boolean {
  return MD_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Heading boundary: 1-6 `#`s followed by whitespace or end of line (`#`, `## Topic`). */
const isMdHeading = (line: string) => /^#{1,6}(\s|$)/.test(line);
/** Fence delimiter per the chunker's heuristic: ``` anywhere in leading whitespace. */
const isMdFence = (line: string) => /^\s*```/.test(line);

/**
 * Markdown-aware chunking: a `---`/`---` frontmatter block becomes its own first
 * chunk, then every ATX heading (`#`..`######`) starts a section spanning through
 * the line before the next heading (any level) or EOF. Each section chunk carries
 * `context` — the heading trail joined by " > " (e.g. "jgrep > Help") — so the
 * question can name the sub-section. Sections are semantic units: small ones are
 * kept whole (no minLines merging). Sections longer than maxLines split at blank
 * lines OUTSIDE fenced code blocks; a fence that outgrows maxLines is never broken
 * (that piece exceeds maxLines instead). Ranges are 1-based inclusive, like chunk().
 */
export function chunkMarkdown(file: string, text: string, opts = { minLines: CHUNK_MIN_LINES, maxLines: CHUNK_MAX_LINES }): Chunk[] {
  const lines = text.split("\n");
  const maxLines = opts.maxLines ?? CHUNK_MAX_LINES; // minLines unused: headings are semantic units, never merged away
  const out: Chunk[] = [];
  const push = (start: number, end: number, context?: string) => {
    const t = lines.slice(start, end + 1).join("\n");
    if (!t.trim()) return; // skip completely-whitespace regions only
    out.push(context === undefined ? { file, start: start + 1, end: end + 1, text: t } : { file, start: start + 1, end: end + 1, text: t, context });
  };
  // Oversized region: cut greedily at the last blank line outside fences; a hard
  // cut at the maxLines boundary is the fallback when no blank line is available.
  const splitAndPush = (start: number, end: number, context?: string) => {
    let pieceStart = start;
    let inFence = false; // regions always begin outside a fence (sections start at headings)
    while (pieceStart <= end) {
      if (end - pieceStart + 1 <= maxLines) { push(pieceStart, end, context); break; }
      let cut = -1;
      let lastBlank = -1;
      for (let i = pieceStart; i <= end; i++) {
        const l = lines[i];
        if (!inFence && !l.trim()) lastBlank = i;
        if (isMdFence(l)) inFence = !inFence;
        if (i - pieceStart + 1 >= maxLines && !inFence) { cut = lastBlank >= pieceStart ? lastBlank : i; break; }
      }
      if (cut === -1) { push(pieceStart, end, context); break; } // fence ran past maxLines: exceed rather than break it
      push(pieceStart, cut, context);
      pieceStart = cut + 1;
      inFence = false; // cuts only happen outside fences, so the next piece starts fence-free
    }
  };
  let i = 0;
  // Frontmatter: file opens with exactly `---` and a later line closes it.
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) { push(0, close); i = close + 1; }
  }
  // Sections: one pass, tracking the heading stack for the context trail.
  const stack: { level: number; title: string }[] = [];
  let regionStart = i;       // start of the not-yet-chunked region (preamble or current section)
  let sectionStart = -1;     // heading line of the current section; -1 = still in the preamble
  let context: string | undefined;
  let inFence = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!inFence && isMdHeading(l)) {
      if (sectionStart === -1) push(regionStart, i - 1); // preamble before the first heading
      else splitAndPush(regionStart, i - 1, context);
      const level = /^#{1,6}/.exec(l)![0].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: l.replace(/^#{1,6}\s*/, "").trim() });
      context = stack.map((s) => s.title).join(" > ");
      regionStart = i;
      sectionStart = i;
    } else if (isMdFence(l)) {
      inFence = !inFence;
    }
  }
  if (sectionStart === -1) push(regionStart, lines.length - 1);
  else splitAndPush(regionStart, lines.length - 1, context);
  return out;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Path of a `+++ ` diff header line (without the `b/` prefix). git C-quotes a name with
 *  special characters (`"b/q\"t.ts"`, `\303\274` octal bytes for non-ASCII unless
 *  core.quotePath=false) and appends a TAB after a name that contains a space; taking the
 *  raw text produced wrong file names (audit NIT). */
export function diffHeaderPath(line: string): string {
  let s = line.slice(4);
  if (s.startsWith('"')) {
    const bytes: number[] = [];
    const enc = new TextEncoder();
    for (let i = 1; i < s.length && s[i] !== '"'; i++) {
      if (s[i] !== "\\") { const ch = String.fromCodePoint(s.codePointAt(i)!); bytes.push(...enc.encode(ch)); i += ch.length - 1; continue; } // whole code point (astral chars are 2 UTF-16 units)
      const oct = /^[0-7]{3}/.exec(s.slice(i + 1));
      if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; }
      else { bytes.push(C_ESCAPES[s[i + 1]] ?? s.charCodeAt(i + 1)); i++; }
    }
    s = new TextDecoder().decode(new Uint8Array(bytes));
  } else s = s.replace(/\t$/, "");
  return s.replace(/^b\//, "");
}

/** Hunks of `git diff <args>` as chunks; text keeps the +/- markers. */
export function diffChunks(diff: string): Chunk[] {
  const out: Chunk[] = [];
  let file = "";
  let cur: Chunk | null = null;
  const push = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { push(); file = diffHeaderPath(line); continue; }
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
  // core.quotePath=false: non-ASCII names print verbatim instead of as octal escapes
  // (diffHeaderPath decodes both forms either way).
  return execFileSync("git", ["-c", "core.quotePath=false", "diff", "--no-color", "--unified=3", ...args], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
}

// ---- files ------------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor"]);

/** Names that hold credentials. With --follow-symlinks a link is refused when its own
 *  name OR its target's name matches: a cloned repo must not be able to smuggle
 *  ~/.aws/credentials or a deploy key into the request behind an innocent link name. */
const SECRET_NAME_RE = /^(\.env(\..*)?|.*\.(key|pem|p12|pfx|tfvars)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|credentials(\..*)?|\.git-credentials|\.netrc|\.npmrc|\.pypirc|kubeconfig)$/i;
const looksSecret = (p: string): boolean => SECRET_NAME_RE.test(path.basename(p));

/** Per-file HARD ceiling: no flag raises it. USER 2026-10-02: "remove the input limit, make
 *  it opt-in only if --max-bytes is used. otherwise both tools must read any file size. add
 *  an hard limit of 100MB just to prevent system hungs." (This replaced the old silent 1 MB
 *  per-file skip, and the total-size cap the audit asked for was dropped by the same
 *  decision.) */
export const HARD_MAX_BYTES = 104_857_600;

export interface ListOptions {
  /** --follow-symlinks / JGREP_FOLLOW_SYMLINKS=1. Default false: listed symlinks are
   *  skipped and reported (paths given on the command line are always followed, like
   *  grep -r — naming one is the user's own choice). */
  followSymlinks?: boolean;
  /** --max-bytes / JGREP_MAX_BYTES: opt-in per-file limit below HARD_MAX_BYTES (the CLI
   *  rejects larger values); files over it are skipped and reported. Default: the ceiling. */
  maxBytes?: number;
}

let lsFilesWarned = false; // "report once" for a git ls-files failure other than not-a-repo

/** Files under `paths`: git ls-files (tracked + untracked, .gitignore honoured) per
 *  directory, else a hidden-file-skipping walk. Symlinks found while listing are
 *  skipped and reported on stderr unless opts.followSymlinks; when following, every
 *  file is deduped by realpath, directory cycles are cut by a visited-realpath set,
 *  and secret-looking links (name or target) are still refused. Throws when the
 *  listing exceeds the total-size cap. */
export function listFiles(paths: string[], opts: ListOptions = {}): string[] {
  const follow = opts.followSymlinks ?? false;
  const listed = new Set<string>();   // paths found while listing (subject to the symlink rule)
  const explicit = new Set<string>(); // files named on the command line
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error(`no such path: ${p}`);
    if (fs.statSync(p).isFile()) { explicit.add(p); continue; }
    try {
      // Run git INSIDE p (-C) and join its p-relative output back onto p: git run from the
      // process cwd failed with "outside repository" for any directory in another repo
      // than the cwd's, and the silent walk fallback hid that (.gitignore then ignored).
      execFileSync("git", ["-C", p, "ls-files", "-z", "-co", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .split("\0").filter(Boolean).forEach((f) => { listed.add(path.join(p, f)); });
    } catch (e) {
      // "not a git repository" is the expected non-repo case: walk silently. Anything else
      // (git missing, dubious ownership, a corrupt index) used to fall back silently too,
      // turning a gitignore-aware listing into a gitignore-unaware one — say so, once.
      const why = String((e as { stderr?: unknown }).stderr ?? "") || (e as Error).message;
      if (!/not a git repository/i.test(why) && !lsFilesWarned) {
        lsFilesWarned = true;
        console.error(`warning: git ls-files failed (${why.trim().split("\n")[0]}) — falling back to a directory walk that ignores .gitignore`);
      }
      walk(p, listed);
    }
  }
  const out: string[] = [];
  const seenReal = new Set<string>();
  const seenPath = new Set<string>();
  const skipped: string[] = [];
  const keep = (f: string) => {
    if (seenPath.has(f)) return; // a file named explicitly AND listed under a named directory
    seenPath.add(f);
    if (follow) {
      const real = fs.realpathSync(f);
      if (seenReal.has(real)) return; // the same file reached twice (a link and its target)
      seenReal.add(real);
    }
    out.push(f);
  };
  for (const f of explicit) { try { if (fs.statSync(f).isFile()) keep(f); } catch { /* vanished */ } }
  const visitedDirs = new Set<string>(paths.flatMap((p) => { try { return [fs.realpathSync(p)]; } catch { return []; } }));
  const consider = (f: string): void => {
    let st: ReturnType<typeof fs.lstatSync>;
    try { st = fs.lstatSync(f); } catch { return; } // listed by git but deleted on disk
    if (!st.isSymbolicLink()) { if (st.isFile()) keep(f); return; }
    if (!follow) { skipped.push(f); return; }
    let real: string;
    try { real = fs.realpathSync(f); } catch { skipped.push(f); return; } // dangling link
    if (looksSecret(f) || looksSecret(real)) { skipped.push(f); return; }
    const target = fs.statSync(real);
    if (target.isFile()) { keep(f); return; }
    if (!target.isDirectory() || visitedDirs.has(real)) return; // a cycle (or a dir seen already) ends here
    visitedDirs.add(real);
    const inner = new Set<string>();
    walk(f, inner);
    for (const g of [...inner].sort()) consider(g);
  };
  // Regular files first, then links: when a link and its target are both listed, the
  // dedupe keeps the real path, not the alias.
  const isLink = (f: string) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };
  const sorted = [...listed].sort();
  for (const f of sorted.filter((f) => !isLink(f))) consider(f);
  for (const f of sorted.filter(isLink)) consider(f);
  if (skipped.length) {
    const shown = skipped.slice(0, 3).join(", ") + (skipped.length > 3 ? `, … ${skipped.length - 3} more` : "");
    console.error(follow
      ? `jgrep: skipped ${skipped.length} symlink(s) whose name or target looks like a secret, or that dangle: ${shown}`
      : `jgrep: skipped ${skipped.length} symlink(s) (not followed by default; --follow-symlinks follows them): ${shown}`);
  }
  return out.sort();
}

/** Without git a walk lists at most this many files (cli.ts USAGE states it). */
export const MAX_WALK_FILES = 5000;
/** Recursive listing without git: hidden entries and SKIP_DIRS are skipped. Symlinks are
 *  ADDED as entries (never descended here) — listFiles decides whether to follow them. */
function walk(root: string, out: Set<string>, dir = root) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    if (out.size > MAX_WALK_FILES) {
      const shown = path.resolve(root) === process.cwd() ? "the current directory" : root;
      throw new Error(`${shown} is not a git repo and has more than ${MAX_WALK_FILES} files.\n` +
        `Run jgrep inside a project, or pass its path:  jgrep "..." ~/Documents/<project>`);
    }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, out, p);
    else out.add(p);
  }
}

/** A file's text, or null for a binary (NUL in the first 8000 bytes) or a file over
 *  `maxBytes` (default HARD_MAX_BYTES). The size is checked BEFORE reading, so an
 *  over-limit file is never loaded. */
export function readText(file: string, maxBytes: number = HARD_MAX_BYTES): string | null {
  if (fs.statSync(file).size > Math.min(maxBytes, HARD_MAX_BYTES)) return null;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString("utf8");
}

/** Files within the size limit (ListOptions.maxBytes, never above HARD_MAX_BYTES). The
 *  over-limit ones are reported in ONE stderr line — a size skip is a user-visible choice
 *  now, not the old silent 1 MB drop. */
export function withinSize(files: string[], maxBytes: number = HARD_MAX_BYTES): string[] {
  const limit = Math.min(maxBytes, HARD_MAX_BYTES);
  const over = files.filter((f) => fs.statSync(f).size > limit);
  if (over.length) {
    const why = limit === HARD_MAX_BYTES ? "the 100 MB hard ceiling" : `--max-bytes ${limit} bytes`;
    console.error(`jgrep: skipped ${over.length} file(s) over ${why}: ${over.slice(0, 3).join(", ")}${over.length > 3 ? `, … ${over.length - 3} more` : ""}`);
  }
  return files.filter((f) => !over.includes(f));
}

export function chunkPaths(paths: string[], opts: ListOptions = {}): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of withinSize(listFiles(paths, opts), opts.maxBytes)) {
    const text = readText(file, opts.maxBytes);
    if (text !== null) chunks.push(...(isMarkdownPath(file) ? chunkMarkdown(file, text) : chunk(file, text)));
  }
  return chunks;
}

// ---- context fit --------------------------------------------------------------
// USER 2026-10-02: "content must never be truncated to fit Jev's context; oversized content
// is split into context-sized chunks instead." Jev's context is 32k tokens. Budgets are in
// UTF-8 BYTES of the JSON request at a conservative ~1.5 bytes/token (hex, base64 and CJK
// tokenize far denser than code's ~3.3), so a request at the cap stays under ~27k tokens.
export const MAX_REQUEST_BYTES = 40_000;
/** One chunk's text at most this many bytes (<= ~10.7k tokens even at 1.5 bytes/token): any
 *  chunk always fits a request with its question. Big enough that a semantic unit the
 *  chunkers keep whole on purpose — a Markdown section or fenced block of ~200 lines, such
 *  as SKILL.md's embedded --help — still reaches the judge in one piece. */
export const MAX_CHUNK_BYTES = 16_000;
/** Lines repeated at each cut, so a match spanning the cut is still seen whole by one piece. */
export const SPLIT_OVERLAP_LINES = 3;
const SPLIT_OVERLAP_CHARS = 200; // the same idea when a single line has to be cut
const UTF8 = new TextEncoder();
export const byteLen = (s: string): number => UTF8.encode(s).length;

/** One over-budget line cut into pieces of at most maxBytes (whole code points), each piece
 *  starting SPLIT_OVERLAP_CHARS before the previous one ended. Nothing is dropped. */
export function splitLongLine(line: string, maxBytes: number): string[] {
  const cps = Array.from(line);
  const out: string[] = [];
  for (let i = 0; i < cps.length;) {
    let j = i, b = 0;
    while (j < cps.length && b + byteLen(cps[j]) <= maxBytes) b += byteLen(cps[j++]);
    if (j === i) j = i + 1; // a single code point over the budget (maxBytes < 4): never loop
    out.push(cps.slice(i, j).join(""));
    if (j >= cps.length) break;
    i = Math.max(i + 1, j - SPLIT_OVERLAP_CHARS);
  }
  return out;
}

/** [from, to) line windows of at most maxBytes each (a line's own newline counted), cut at
 *  line boundaries with SPLIT_OVERLAP_LINES lines of overlap. A single line over the budget
 *  gets a window of its own (the caller cuts it with splitLongLine). */
export function lineWindows(lines: string[], maxBytes: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length;) {
    let j = i, b = 0;
    while (j < lines.length && b + byteLen(lines[j]) + 1 <= maxBytes) b += byteLen(lines[j++]) + 1;
    if (j === i) j = i + 1;
    out.push([i, j]);
    if (j >= lines.length) break;
    i = Math.max(i + 1, j - SPLIT_OVERLAP_LINES);
  }
  return out;
}

/** A chunk over MAX_CHUNK_BYTES becomes several chunks at line boundaries (with overlap);
 *  a single giant line is cut by characters. Ranges map back onto the file: code lines
 *  advance one per line; in a diff hunk the removed (`-`) lines do not advance the
 *  new-side line number. Small chunks come back unchanged (same object). */
export function fitChunk(c: Chunk, kind: Kind = "code", maxBytes: number = MAX_CHUNK_BYTES): Chunk[] {
  if (byteLen(c.text) <= maxBytes) return [c];
  const lines = c.text.split("\n");
  const advances = (l: string) => kind !== "diff" || !l.startsWith("-");
  const lineNo: number[] = [];
  let n = c.start;
  for (const l of lines) { lineNo.push(n); if (advances(l)) n++; }
  const out: Chunk[] = [];
  for (const [i, j] of lineWindows(lines, maxBytes)) {
    if (j === i + 1 && byteLen(lines[i]) + 1 > maxBytes) {
      for (const piece of splitLongLine(lines[i], maxBytes)) out.push({ ...c, start: Math.min(lineNo[i], c.end), end: Math.min(lineNo[i], c.end), text: piece });
      continue;
    }
    let end = lineNo[i];
    for (let k = i; k < j; k++) if (advances(lines[k])) end = lineNo[k];
    // never past the chunk's own end (a diff hunk's text can carry a trailing empty line)
    out.push({ ...c, start: Math.min(lineNo[i], c.end), end: Math.min(end, c.end), text: lines.slice(i, j).join("\n") });
  }
  return out;
}

/** Groups items into request batches of at most `maxCount` items whose summed byte cost
 *  stays within `maxBytes` (an item that alone exceeds it goes alone). Order is kept. */
export function packBatches<T>(items: T[], maxCount: number, maxBytes: number, bytesOf: (t: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let b = 0;
  for (const it of items) {
    const n = bytesOf(it);
    if (cur.length && (cur.length >= maxCount || b + n > maxBytes)) { out.push(cur); cur = []; b = 0; }
    cur.push(it); b += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---- Jev --------------------------------------------------------------------
export function buildRequest(question: string, chunks: Chunk[], kind: Kind = "code", model = "jev-latest", votes = 1, envelopes = false) {
  const state = { chunks: chunks.map((c, i) => ({ id: `c${i}`, file: c.file, lines: `${c.start}-${c.end}`, [kind]: envelopes ? c.text + numberEnvelope(c.text) : c.text })) };
  const what = kind === "diff"
    ? "Does that diff hunk (lines starting with + were added, - removed) match this description"
    : "Does that code match this description";
  const n = Math.max(1, Math.floor(votes)); // --votes (WI-2): N questions per chunk
  const questions: Record<string, unknown> = {};
  chunks.forEach((c, i) => {
    // Markdown chunks carry their heading trail so the question can name the sub-section.
    const ctx = c.context ? `[Section context: ${c.context}] ` : "";
    for (let v = 0; v < n; v++) {
      // votes=1 keeps the byte-identical `c{i}` id; N > 1 names each vote `c{i}#v{v}`
      // (the chunk id inside the instruction stays `c{i}` — the state has one chunk entry).
      questions[n > 1 ? `c${i}#v${v}` : `c${i}`] = { type: "noul", instructions: `Look only at the chunk with id "c${i}". ${ctx}${what}: ${question}` };
    }
  });
  return { model, state, questions };
}

// ---- --envelopes (WI-9) --------------------------------------------------------
/** Cap on the numbers spelled out per chunk: the envelope is a hint for the judge,
 *  not a transcript — past ~20 digits it stops helping and starts costing tokens. */
export const ENVELOPE_MAX_NUMBERS = 20;
const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

/**
 * WI-9 numeric envelope: Jev's documented weakness is counting ("at most 3 retry
 * sites?") — the chunk arrives as prose and the digits get miscounted. With
 * --envelopes the first <=20 numbers of the chunk text are spelled out as a
 * machine-readable suffix ("\n[numbers: 42, 7]"). The suffix is appended INSIDE
 * buildRequest — the request carries it, but cache keys hash the whitespace-
 * NORMALIZED chunk text (WI-6), so envelope and non-envelope runs share one cache
 * (a chunk judged once is never paid for twice either way). Off by default; chunks
 * without numbers get no suffix.
 */
export function numberEnvelope(text: string): string {
  const nums = text.match(NUMBER_RE);
  if (!nums || nums.length === 0) return "";
  return `\n[numbers: ${nums.slice(0, ENVELOPE_MAX_NUMBERS).join(", ")}]`;
}

// ---- cache ------------------------------------------------------------------
// One JSON file for now; move to sqlite if it grows past a few MB.
/** `$JGREP_HOME/cache.json`, else `~/.jgrep/cache.json`: jgrep's single home (user decision
 *  "one file per tool", TRDD-3KBUODCE) next to providers.json and errors.log. */
export function cacheFilePath(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  return path.join(jgrepHome(env, home), "cache.json");
}
/** Persistent answers: a chunk key -> p (number), a rows key -> its answer record. Values come
 *  from a JSON file a user can edit, so every read checks the shape (unknown, not any). */
export type Cache = Record<string, unknown>;

/** WI-6 size cap: at most this many entries survive a save; the OLDEST-inserted
 *  keys are evicted first, so the newest judgments always survive. */
export const CACHE_MAX_ENTRIES = 10_000;

/** Pure eviction seam (WI-6): drops entries from the FRONT of the insertion order
 *  until `c` fits `cap`. Object.keys of a JSON-parsed cache IS insertion order (a
 *  40-char sha1 hex key is never an integer-like array index), so the front of that
 *  order is the oldest generation. Mutates and returns `c`. Exported so the cap and
 *  oldest-first rule are testable without driving 10k entries through the disk. */
export function evict(c: Cache, cap: number = CACHE_MAX_ENTRIES): Cache {
  const overflow = Object.keys(c).length - cap;
  if (overflow <= 0) return c;
  for (const k of Object.keys(c).slice(0, overflow)) delete c[k];
  return c;
}

/**
 * Chunk identity for the persistent cache key (WI-6) AND the in-run signature
 * (chunkSignature): trailing whitespace (incl. a CRLF's \r) stripped and blank lines
 * dropped, so trailing-space, blank-line and line-ending churn does not re-bill.
 * LEADING INDENTATION IS KEPT — USER decision 2026-10-02 (B2): "Indent-aware
 * everywhere". Trimming it aliased different code: in Python `return x` under an `if`
 * and after it normalized identically, so one verdict (and its cache entry) was served
 * for both; YAML nesting, Makefile tabs and diff context markers broke the same way.
 * Rows mode normalizes the judged row through this too.
 */
export function normalizeForCache(text: string): string {
  return text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0).join("\n");
}

/** Disk format v1 (WI-6): `{"v":1,"entries":{…},"order":["key",…]}` with `order` =
 *  insertion order (front = oldest). Returns the FLAT entry map either way, so every
 *  consumer keeps treating the cache as Record<key, p>. A legacy flat object (no
 *  envelope) loads unchanged and is re-persisted in the envelope on the next save —
 *  entries kept, order taken as Object.keys. No migration code: entries keyed on the
 *  pre-normalization raw chunk text simply miss once and re-bill (README cache note). */
// The path is resolved per call, never at import: a bad JGREP_HOME must reach the CLI's
// error handler (exit 2, one line), not crash the module load with a stack trace.
export function loadCache(file: string = cacheFilePath()): Cache {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    if (parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries))
      return parsed.entries as Cache;
    return parsed as Cache;
  } catch { return {}; }
}

/** Best-effort persist (WI-6): evict past CACHE_MAX_ENTRIES, then write
 *  `${file}.tmp-<pid>` in the SAME directory and fs.renameSync it over the target —
 *  a same-directory rename is atomic, so concurrent jgrep processes never observe a
 *  half-written cache and the worst case is a lost save, never a corrupted file.
 *  A failure skips the save with ONE stderr warning (audit: a silent EACCES/ENOSPC
 *  made every later run re-bill every chunk with no clue why) and removes the tmp
 *  file best-effort; the run itself still succeeds. The `file` parameter is a test seam; production callers rely on the
 *  default, cacheFilePath(). */
export function saveCache(c: Cache, file: string = cacheFilePath()) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); // jgrep's home also holds providers.json (keys)
    evict(c);
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: c, order: Object.keys(c) }));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`warning: could not save the jgrep cache to ${file} (${(e as Error).message}) — the next run re-bills these answers`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* tmp cleanup is best-effort */ }
  }
}
// In-run signature: the same indent-aware rule as the cache key (B2, see
// normalizeForCache). Chunks sharing a signature are identical code modulo trailing
// whitespace and blank lines — judge one, siblings inherit.
export function chunkSignature(text: string): string {
  return normalizeForCache(text);
}

// Intra-run signature key (WI-3): sha1 over (kind, question, normalized text, context).
// Deliberately NOT the persistent cache key below — the signature only dedups identical
// chunks WITHIN a single run. The markdown context is part of it (B2): the question names
// the section, so identical text under two headings is two different questions.
const sigKey = (kind: Kind, q: string, c: Chunk) =>
  createHash("sha1").update(`${kind}\0${q}\0${chunkSignature(c.text)}\0${c.context ?? ""}`).digest("hex");

// Persistent cache key (WI-6): sha1 over (model, kind, question, NORMALIZED chunk
// text [, context]) — normalizeForCache(c.text), not the raw bytes, so trailing-
// whitespace, blank-line and line-ending churn never re-bills while any content or
// indentation change does (B2). Old
// raw-text keys simply miss and re-bill once (no migration code; README note).
// Markdown chunks fold their context trail into the key; chunks without context
// keep the exact pre-markdown key shape (no trailing \0). The #v{i} (votes) and
// #verify suffixes compose AFTER this normalized base — suffix logic unchanged.
const key = (model: string, kind: Kind, q: string, c: Chunk) =>
  createHash("sha1")
    .update(c.context ? `${model}\0${kind}\0${q}\0${normalizeForCache(c.text)}\0${c.context}` : `${model}\0${kind}\0${q}\0${normalizeForCache(c.text)}`)
    .digest("hex");

// ---- votes & verify (WI-2) ----------------------------------------------------
/** Median of N probabilities; an even count averages the two middle values. */
export function median(ps: number[]): number {
  const s = [...ps].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** --verify: the pass-2 question is this strict prefix + the original instruction. */
export const VERIFY_PREFIX = "Verify strictly — answer only if clearly matching: ";
/** --verify hysteresis (documented): a hit stands when its re-ask p >= threshold * VERIFY_GATE. */
export const VERIFY_GATE = 0.6;

// ---- --tag (WI-4) ---------------------------------------------------------------
/** Cap on hits per --tag request: tagging annotates results that are already paid
 *  for, so even a raised --batch never packs more than a default main-pass batch
 *  into one annotation request. */
export const TAG_BATCH_MAX = 16;

/** --tag (WI-4) categories: split on commas, trimmed, empties dropped. The CLI
 *  rejects lists with fewer than 2 categories (a one-way choice is not a category);
 *  the core tolerates any non-empty list so library callers set their own floor. */
export function parseTagCategories(tag: string): string[] {
  return tag.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * --tag (WI-4) request: the standing hits as state (batch-local ids `h0..hN`, the
 * same convention as the main pass's `c0..cN`) plus ONE `choice` question per hit
 * whose criteria are the user's categories keyed `t0..tN`. The winning criterion's
 * NAME (the category string) becomes `Hit.tag`, its probability `Hit.tag_p`.
 */
export function buildTagRequest(hits: Hit[], tags: string[], kind: Kind = "code", model = "jev-latest") {
  const criteria: Record<string, string> = {};
  tags.forEach((t, i) => { criteria[`t${i}`] = t; });
  const state = { chunks: hits.map((h, j) => ({ id: `h${j}`, file: h.file, lines: `${h.start}-${h.end}`, [kind]: h.text })) };
  const questions: Record<string, unknown> = {};
  hits.forEach((_, j) => {
    questions[`h${j}`] = {
      type: "choice",
      instructions: `Which category best fits the code in chunk h${j}? Choose exactly one.`,
      criteria,
    };
  });
  return { model, state, questions };
}

// ---- core -------------------------------------------------------------------
// Retry/deadline defaults live in ONE place (here); jgrep()/scoreRows() resolve
// them once per run and the pool workers only read the resolved values.
export const DEFAULT_TIMEOUT_SEC = 200;        // per-batch deadline INCLUDING retries (§1.6.1)
export const DEFAULT_REQUEST_TIMEOUT_SEC = 400; // per attempt
export const DEFAULT_MAX_RETRIES = 50;         // => 51 total attempts

/** --estimate dry-run sink (upstream #14): each request that WOULD be sent adds 1 request
 *  and its JSON body length; nothing is sent and no key is resolved. */
export interface Estimate { requests: number; chars: number; files?: Record<string, number> }
// Upstream's fit to 4 live requests (1/3/10/30 chunks, 673-38538 body chars, 2026-09-28): the
// provider bills input_tokens = ~236 + 0.30 * body chars, i.e. a fixed per-request overhead
// plus ~3.3 chars/token, not chars/4. Re-measure if the model changes.
export const EST_TOKENS_PER_REQUEST = 240;
export const EST_TOKENS_PER_CHAR = 0.3;
export const estimateTokens = (e: Estimate): number => Math.ceil(e.requests * EST_TOKENS_PER_REQUEST + e.chars * EST_TOKENS_PER_CHAR);
/** One stderr line; cost at the resolved $/Mtok (JEV_PRICE_PER_MTOK or the default). */
export const estimateLine = (e: Estimate, pricePerMtok: number): string => {
  const tokens = estimateTokens(e);
  return `estimated: ${e.requests} requests, ~${tokens} input tokens, ~$${(tokens * pricePerMtok / 1e6).toFixed(4)} (list price, cached chunks free; nothing was sent)`;
};

/** What ONE answered request cost: the provider-reported cost when present, else its
 *  billed input tokens × $/Mtok. The single rule for the --budget meter AND every run's
 *  reported total — summing only reported costs undercounted runs whose provider reports
 *  cost on some responses and not others (PR #2 open item). */
export const settledCost = (res: { usage?: { input_tokens?: number }; cost?: number }, pricePerMtok: number): number =>
  res.cost ?? ((res.usage?.input_tokens ?? 0) * pricePerMtok) / 1e6;

// ---- --budget: hard cap via reservation (B1) -----------------------------------
/** Run-wide spend meter, created ONLY when a budget is set. USER decision 2026-10-02:
 *  "Hard cap via reservation" and "make the cap opt-in. by default no cap should be
 *  enabled." — a run without a budget has no meter, no reservation and no limit.
 *  Why reservation: the pool starts `concurrency` workers at once, so the old check of
 *  metered spend at each worker's ENTRY let a whole wave through before the first
 *  response was billed (16 requests sent on a budget for 3). Now each request reserves
 *  its estimated cost (the --estimate token model on the exact request body × $/Mtok)
 *  synchronously before it is sent — no await between check and reserve, so concurrent
 *  workers cannot race past it — and a request that does not fit in what is left never
 *  starts. The response replaces the reservation with the real cost of THAT request:
 *  provider-reported when present, else its billed tokens × $/Mtok.
 *  ponytail: the cap is as exact as the estimator (within ~15% on live data); a request
 *  billed above its estimate can overshoot by that margin. Calibrate the estimate from
 *  observed bills if that ever matters. */
export class BudgetMeter {
  spent = 0;
  reserved = 0;
  /** Highest provider-REPORTED $/Mtok seen this run (cost / input_tokens). Reservations are
   *  priced at pricePerMtok (JEV_PRICE_PER_MTOK or the default); when the provider really
   *  bills more, concurrent reservations under-price and a wave can overshoot the cap. */
  seenPerMtok = 0;
  constructor(readonly budget: number, readonly pricePerMtok: number) {}
  /** One stderr line when the observed rate is >10% above the reservation price (smaller
   *  gaps are estimator noise), else undefined. */
  underpricedWarning(): string | undefined {
    if (!(this.seenPerMtok > this.pricePerMtok * 1.1)) return undefined;
    return `warning: the provider billed ~$${this.seenPerMtok.toPrecision(3)}/Mtok this run, above the $${this.pricePerMtok}/Mtok that --budget reserves at; ` +
      `set JEV_PRICE_PER_MTOK=${this.seenPerMtok.toPrecision(3)} so the cap reserves enough`;
  }
  /** Reserve before a request goes out. Throws budget_exhausted — with nothing sent — when
   *  the request does not fit. Priced at `price` (the entry's own usd_per_mtok, 0 for the
   *  free local mlx server): a zero estimate never refuses, so a nearly-spent budget falls
   *  back to the free provider instead of stopping the run. Returns the estimate it reserved,
   *  for settle() to release or convert to spend. */
  reserve(req: unknown, provider: string, price: number): number {
    const est = (estimateTokens({ requests: 1, chars: JSON.stringify(req).length }) * price) / 1e6;
    if (est > 0 && this.spent + this.reserved + est > this.budget)
      throw new JevProviderError(
        "budget_exhausted",
        `budget exhausted: $${this.spent.toFixed(4)} spent${this.reserved > 0 ? ` + $${this.reserved.toFixed(4)} in flight` : ""} of the $${this.budget} --budget; the next request needs ~$${est.toFixed(4)}`,
        { provider, retryable: false, hint: "raise --budget" },
      );
    this.reserved += est;
    return est;
  }
  /** Settle after the request: release the reservation, add the real cost as spend. A failure
   *  the provider may still have billed keeps its estimate as spend (audit: settling those at
   *  $0 let the cap be exceeded). Likely billed: a 200 with a malformed body, a client-side
   *  timeout (the server may have finished the work) and a 5xx (the server reached the
   *  request). Never processed — released: 4xx refusals, 429 and connection failures. */
  settle(res: { usage?: { input_tokens?: number }; cost?: number } | undefined, est: number, price: number, err?: JevProviderError): void {
    this.reserved -= est;
    let real = 0;
    if (res) {
      real = settledCost(res, price);
      const tok = res.usage?.input_tokens;
      if (res.cost !== undefined && tok) this.seenPerMtok = Math.max(this.seenPerMtok, (res.cost / tok) * 1e6);
    } else if (err && (err.kind === "malformed_response" || err.kind === "timeout" || (err.status !== undefined && err.status >= 500))) real = est;
    this.spent += real;
  }
  /** Reserve, send, settle — the single-provider wrapper kept for roadmap.test.ts and library
   *  callers that pass one backend. The chain path (ProviderChain.post) calls reserve/settle
   *  directly so each entry is priced at its own usd_per_mtok. */
  async run<T extends { usage?: { input_tokens?: number }; cost?: number }>(req: unknown, provider: string, send: () => Promise<T>): Promise<T> {
    const est = this.reserve(req, provider, this.pricePerMtok);
    try {
      const res = await send();
      this.settle(res, est, this.pricePerMtok);
      return res;
    } catch (e) {
      this.settle(undefined, est, this.pricePerMtok, e instanceof JevProviderError ? e : undefined);
      throw e;
    }
  }
}

export interface Options {
  threshold: number; batch: number; concurrency: number; apiKey?: string; kind?: Kind;
  backend?: Backend; model?: string;
  chain?: ProviderChain;       // the CLI's providers.json chain (TRDD-3KBUODCE); wins over backend/model/apiKey
  timeoutSec?: number;         // per-batch deadline, retries included
  requestTimeoutSec?: number;  // per attempt
  maxRetries?: number;         // failed attempts tolerated before the final error
  ratePerSec?: number;         // token-bucket pacing across all requests; 0/undefined = unlimited
  failFast?: boolean;          // rethrow the first fatal error instead of isolating it
  estimate?: Estimate;         // dry run: count requests/chars into this sink, never call the provider
  estimateUpper?: Estimate;    // --estimate --funcs: pass 2 priced as if every candidate file were shortlisted
  group?: boolean;             // --group: fill result.groups[] (the intra-run signature dedup is always on)
  votes?: number;              // --votes: judge every chunk N times (1-5); the MEDIAN probability wins
  verify?: boolean;            // --verify: strict re-ask of every hit; the hit stands only at p >= threshold * 0.6
  tag?: string;                // --tag (WI-4): comma-separated categories; one choice question per standing hit, the winner rides on Hit.tag
  funcs?: boolean;             // --funcs (WI-5): two-phase navigation — shortlist files by signature chunks, then search only those
  envelopes?: boolean;         // --envelopes (WI-9): append each chunk's numbers ("[numbers: 42, 7]") to the judged text
  followSymlinks?: boolean;    // --follow-symlinks: jgrepFuncs' own file listing follows symlinks (see ListOptions)
  maxBytes?: number;           // --max-bytes: jgrepFuncs' per-file size limit (see ListOptions)
  budget?: number;             // --budget (WI-7): once metered cost exceeds this many dollars, un-run chunks error budget_exhausted
  pricePerMtok?: number;       // $/Mtok for the --budget meter when the provider reports no cost (default DEFAULT_PRICE_PER_MTOK)
  meter?: BudgetMeter;         // a meter shared across runs (jgrepFuncs' two passes, the CLI's under-pricing check); else built from budget
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}
export interface ChunkError { file: string; start: number; end: number; kind: JevErrorKind; message: string; hint?: string }
/** One signature cluster (WI-3 --group): hits sharing a normalized (indent-aware) signature.
 *  `p` is the group's best probability, `sites` are the hit sites in hit (file) order and
 *  `representative` is the first hit's chunk body. */
export interface Group { sig: string; p: number; count: number; sites: { file: string; start: number; end: number }[]; representative: string }
/** `cost`: the run's spend, every answered request settled by settledCost (undefined when
 *  no request was answered — a fully cached or estimate-only run). */
export interface Result { hits: Hit[]; all: Hit[]; chunks: number; tokens: number; cached: number; errors: ChunkError[]; cost?: number; groups?: Group[] }

/** What one batch worker hands back; runPool results are completion-ordered, so the
 *  batch index rides along and `all` is re-associated after the pool settles. A
 *  partial 200 (the provider answered some chunks but not others) is NOT a hit:
 *  unanswered chunk indices come back in `malformed` and the caller records them as
 *  malformed_response ChunkErrors — otherwise they would surface as p:NaN entries. */
interface BatchOutcome { index: number; entries: { chunkIndex: number; p: number }[]; malformed: number[] }

/** What one --verify batch worker hands back (same shape idea as BatchOutcome). */
interface VerifyOutcome { index: number; got: { hit: Hit; p: number }[]; missing: Hit[] }

/** What one --tag batch worker hands back (same shape idea as VerifyOutcome): the
 *  hits this batch successfully categorized. Unlisted hits of the batch stay untagged. */
interface TagOutcome { index: number; got: { hit: Hit; tag: string; p: number }[] }

/** Appended to an invalid_api_key hint when at least one batch succeeded earlier in the
 *  SAME run (plan §1.5): a 401/403 then means the key expired/was revoked, not that the
 *  user handed over the wrong provider's key. */
export const KEY_WORKED_EARLIER_HINT = "the key worked earlier this run — it may have been expired or revoked";

export async function jgrep(question: string, input: Chunk[], o: Options): Promise<Result> {
  const kind = o.kind ?? "code";
  // Context fit (USER: never truncate, split): every over-budget chunk is split here, the
  // one place every search path (code, --diff, --funcs passes, --estimate) goes through.
  const chunks = input.flatMap((c) => fitChunk(c, kind));
  // The core never picks a provider from env: cli.ts resolves the providers.json chain; a
  // library call gets a chain of its one backend with a lazily resolved key (chainFor).
  const chain = chainFor(o);
  // Requests are built with the first live provider's model. An answer is cached under the
  // model that gave it (res.via.model), and a lookup accepts any model of the chain, the
  // head's first (chain.models()): every provider in the chain is one the user accepts.
  const model = chain.model();
  const models = chain.models();
  const cache = o.cache ?? {};
  const f = o.fetchImpl ?? fetch;
  const all: (Hit | undefined)[] = new Array(chunks.length); // errored chunks stay unset
  // Signature clustering (WI-3): chunks sharing a normalized (indent-aware) signature are
  // near-identical boilerplate — the FIRST cache-missing chunk of a signature (the head)
  // enters the batch todo, siblings inherit the head's verdict once the pool settles.
  // The persistent cache is keyed on the indent-aware normalized chunk text (WI-6, B2);
  // `cached` counts only genuinely cache-served chunks — an inheriting sibling is
  // deduped, not cached.
  const heads = new Map<string, number>();        // signature key -> head chunk index
  const siblingsOf = new Map<string, number[]>(); // signature key -> chunk indices that inherit the verdict
  let cached = 0;
  // --votes (WI-2): parse() validates 1..5; library callers get clamped. N > 1 moves
  // reads/writes to per-vote cache keys `${key}#v{i}` (every vote cached individually, so
  // a re-run replays the same median for free) and the verdict to the MEDIAN of the N
  // answers. votes=1 keeps the byte-exact legacy single-question request and plain keys.
  const votes = Math.max(1, Math.min(5, Math.floor(o.votes ?? 1)));
  const envelopes = o.envelopes ?? false; // --envelopes (WI-9): judged text gains "[numbers: …]"
  const qid = (j: number, v: number): string => (votes > 1 ? `c${j}#v${v}` : `c${j}`);
  chunks.forEach((c, i) => {
    for (const m of models) {
      const k = key(m, kind, question, c);
      if (votes > 1) {
        const ps: number[] = [];
        let complete = true;
        for (let v = 0; v < votes; v++) {
          const p = cache[`${k}#v${v}`];
          if (typeof p === "number" && Number.isFinite(p)) ps.push(p);
          else { complete = false; break; }
        }
        if (complete) { all[i] = { ...c, p: median(ps) }; cached++; return; }
      } else {
        // Same finite-number rule as the votes path: a hand-edited or corrupt cache value
        // (null, a string) would otherwise become `p` and crash `p.toFixed` in the CLI.
        const hit = cache[k];
        if (typeof hit === "number" && Number.isFinite(hit)) { all[i] = { ...c, p: hit }; cached++; return; }
      }
    }
    const sk = sigKey(kind, question, c);
    if (heads.has(sk)) siblingsOf.get(sk)!.push(i);
    else { heads.set(sk, i); siblingsOf.set(sk, []); }
  });
  const todo: number[] = [...heads.values()];
  // Defensive normalization: a 0/fractional batch would spin the loop forever (+= 0)
  // or overlap batches. parse() rejects those; library callers get clamped instead.
  const batch = Math.max(1, Math.floor(o.batch));
  // Batches hold at most `batch` chunks AND at most MAX_REQUEST_BYTES of request: a batch
  // of 16 big chunks would otherwise overflow the context (each chunk priced as its own
  // one-chunk request, which over-counts the shared envelope a little: conservative).
  const batches = packBatches(todo, batch, MAX_REQUEST_BYTES, (ci) => byteLen(JSON.stringify(buildRequest(question, [chunks[ci]], kind, model, votes, envelopes))));
  // One resolution of the retry/deadline options for the whole run (the worker only reads these).
  const timeoutMs = (o.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const post: PostOpts = {
    fetchImpl: f,
    requestTimeoutMs: (o.requestTimeoutSec ?? DEFAULT_REQUEST_TIMEOUT_SEC) * 1000,
    maxRetries: o.maxRetries ?? DEFAULT_MAX_RETRIES,
    limiter: o.ratePerSec && o.ratePerSec > 0 ? new RateLimiter(o.ratePerSec, Math.max(1, o.concurrency)) : undefined,
  };
  let tokens = 0;
  let cost: number | undefined; // undefined until a request is answered; then the settledCost sum
  const price = o.pricePerMtok ?? DEFAULT_PRICE_PER_MTOK;
  // --budget (B1): one meter for the main, verify and tag passes; none without a budget.
  // The meter is passed into post() (TRDD-3KBUODCE): each chain entry reserves at its own
  // usd_per_mtok, so a free local server (mlx, 0) is reached even when the budget is spent.
  const meter = o.meter ?? (o.budget !== undefined ? new BudgetMeter(o.budget, price) : undefined);
  if (meter) post.meter = meter;
  /** Every provider request goes through the chain (per-batch deadline, retries, fallback,
   *  lazy key). --budget reserves per provider inside post() (TRDD-3KBUODCE): each entry at
   *  its own usd_per_mtok, so a free local server (mlx, 0) is reached even when the budget
   *  is nearly spent. */
  const send = (req: { model: string; state: unknown; questions: Record<string, unknown> }) => chain.post(req, post, timeoutMs);
  /** The model that answered each chunk judged this run: its siblings' cache entries use it. */
  const answeredBy = new Map<number, string>();
  // Run-level success flag (plan §1.5): drives the invalid_api_key expired-vs-wrong-key
  // hint. Tracked HERE (not PoolResult) because failFast throws the pool result away.
  let hadSuccess = false;
  const worker = async (b: number[], index: number): Promise<BatchOutcome> => {
    const req = buildRequest(question, b.map((i) => chunks[i]), kind, model, votes, envelopes);
    // --estimate: count before any provider is asked, so a dry run needs no key.
    if (o.estimate) {
      o.estimate.requests++; o.estimate.chars += JSON.stringify(req).length;
      if (o.estimate.files) for (const i of b) o.estimate.files[chunks[i].file] = (o.estimate.files[chunks[i].file] ?? 0) + 1;
      return { index, entries: [], malformed: [] };
    }
    const res = await send(req); // --budget: reserves first; throws budget_exhausted unsent
    const keyAs = (ci: number): string => key(res.via.model, kind, question, chunks[ci]);
    tokens += res.usage?.input_tokens ?? 0;
    cost = (cost ?? 0) + settledCost(res, price);
    // Finite p-values go straight into the in-memory cache object: cli.ts persists it in a
    // finally (Step 7), so answers paid for survive even when other batches fail. A chunk
    // the provider did not answer (missing or non-finite p on a 200) is skipped here and
    // reported as malformed_response — never a p:NaN entry in all/hits.
    const entries: { chunkIndex: number; p: number }[] = [];
    const malformed: number[] = [];
    b.forEach((ci, j) => {
      // --votes: the verdict needs ALL N votes finite (returned ones are still cached as
      // they arrive); an incomplete set is malformed_response — never a partial median.
      const ps: number[] = [];
      let complete = true;
      for (let v = 0; v < votes; v++) {
        const p = res.answers[qid(j, v)]?.noul;
        if (typeof p === "number" && Number.isFinite(p)) {
          ps.push(p);
          if (votes > 1) cache[`${keyAs(ci)}#v${v}`] = p;
        } else complete = false;
      }
      if (!complete) { malformed.push(ci); return; }
      const p = votes > 1 ? median(ps) : ps[0];
      if (votes === 1) cache[keyAs(ci)] = p;
      answeredBy.set(ci, res.via.model);
      entries.push({ chunkIndex: ci, p });
    });
    hadSuccess = true; // this batch's request succeeded — set before returning (plan §1.5)
    return { index, entries, malformed };
  };
  let pool: PoolResult<BatchOutcome>;
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
  for (const r of pool.results) for (const e of r.entries) all[e.chunkIndex] = { ...chunks[e.chunkIndex], p: e.p };
  // Not failFast: recorded 401/403s get the same expired-vs-wrong-key distinction. One
  // clean place — mutate the JevProviderError's hint in pool.errors BEFORE mapping onto
  // chunks, so the amended hint is what ChunkError carries down to the CLI.
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  // Chunk-index -> ChunkError (insertion-ordered exactly like the old flatMap/push
  // chain), so signature siblings below can look up and inherit their head's error.
  const errByChunk = new Map<number, ChunkError>();
  for (const e of pool.errors)
    for (const ci of batches[e.index])
      errByChunk.set(ci, {
        file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end,
        kind: e.error.kind, message: e.error.message,
        // The provider error's actionable hint rides along (cli.ts prints it under the
        // error line and --json-errors includes it) — incl. the KEY_WORKED_EARLIER_HINT
        // amended above.
        ...(e.error.hint !== undefined ? { hint: e.error.hint } : {}),
      });
  // A 200 that answered only some chunks of a batch: the unanswered chunks are
  // recorded per chunk here (the batch itself succeeded, so the pool saw no error).
  for (const r of pool.results)
    for (const ci of r.malformed)
      errByChunk.set(ci, { file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: "malformed_response", message: "provider returned no usable answer for this chunk" });
  if (pool.aborted) {
    // Batches that were dispatched all reported (success or their own error); whatever
    // was never attempted is reported as a breaker error. No cache entries, no hits.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const ci of batches[bi]) {
        errByChunk.set(ci, { file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
      }
    }
  }
  const errors: ChunkError[] = [...errByChunk.values()];
  // Signature siblings (WI-3): inherit the head's verdict — or, when the head ended up
  // with no answer, the head's error mapped onto the sibling's own site (no silent
  // vanish; every batch settles as a result, an error, or a breaker skip, so a verdict-
  // less head always carries an error to inherit). Each inheriting sibling still writes
  // its OWN plain-text cache entry, so a later run serves it without re-judging. (With
  // --votes the sibling's per-vote values are unknown — only the median is — so the
  // entry lands under the legacy key: a votes=1 re-run serves it; a votes>1 re-run
  // re-judges rather than fabricate votes.)
  for (const [sk, sibs] of siblingsOf) {
    if (!sibs.length) continue;
    const headIdx = heads.get(sk)!;
    const verdict = all[headIdx];
    if (verdict !== undefined) {
      for (const si of sibs) {
        cache[key(answeredBy.get(headIdx) ?? model, kind, question, chunks[si])] = verdict.p; // the head's answering model
        all[si] = { ...chunks[si], p: verdict.p };
      }
    } else {
      const headErr = errByChunk.get(headIdx);
      if (headErr !== undefined)
        for (const si of sibs)
          errors.push({ ...headErr, file: chunks[si].file, start: chunks[si].start, end: chunks[si].end });
    }
  }
  let hits: Hit[] = [];
  const ordered: Hit[] = [];
  for (const h of all) if (h) { ordered.push(h); if (h.p >= o.threshold) hits.push(h); }
  // --verify (WI-2): every hit is re-asked ONCE with a strict instruction (the prefix +
  // the original question, one question per chunk — the median already happened); the
  // hit stands only when the re-ask p >= threshold * 0.6 (documented hysteresis: a
  // strict rephrase naturally scores lower, so the gate is deliberately forgiving).
  // Dropped hits leave `hits` but stay in `all` with their main-pass p. Verification
  // verdicts cache under `${chunkKey}#verify`, so a re-run pays nothing for either pass.
  if (o.verify && hits.length > 0) {
    const gate = o.threshold * VERIFY_GATE;
    const verdictOf = new Map<Hit, number>(); // hit -> pass-2 p; an ABSENT verdict failed -> fail open
    const pending: { hit: Hit }[] = [];
    for (const h of hits) {
      const v = models.map((m) => cache[`${key(m, kind, question, h)}#verify`]).find((x) => typeof x === "number" && Number.isFinite(x));
      if (typeof v === "number" && Number.isFinite(v)) verdictOf.set(h, v);
      else pending.push({ hit: h });
    }
    if (pending.length > 0) {
      // Same byte-aware packing as the main pass (the verify request carries the hit's text).
      const vBatches = packBatches(pending, batch, MAX_REQUEST_BYTES, ({ hit }) => byteLen(VERIFY_PREFIX) + byteLen(JSON.stringify(buildRequest(question, [hit], kind, model, 1, envelopes))));
      const vWorker = async (bp: typeof pending, index: number): Promise<VerifyOutcome> => {
        const req = buildRequest(question, bp.map(({ hit }) => hit), kind, model, 1, envelopes);
        for (const id of Object.keys(req.questions))
          req.questions[id] = { type: "noul", instructions: VERIFY_PREFIX + (req.questions[id] as { instructions: string }).instructions };
        const res = await send(req); // --budget meters the verify pass too
        tokens += res.usage?.input_tokens ?? 0;
        cost = (cost ?? 0) + settledCost(res, price);
        const got: { hit: Hit; p: number }[] = [];
        const missing: Hit[] = [];
        bp.forEach(({ hit }, j) => {
          const p = res.answers[`c${j}`]?.noul;
          // cached under the model that answered (a fallback provider's, possibly)
          if (typeof p === "number" && Number.isFinite(p)) { cache[`${key(res.via.model, kind, question, hit)}#verify`] = p; got.push({ hit, p }); }
          else missing.push(hit);
        });
        return { index, got, missing };
      };
      let vPool: PoolResult<VerifyOutcome>;
      try {
        // No onProgress: the main pass already drove the CLI's d/N counter; the verify
        // pass is a short second sweep.
        vPool = await runPool(vBatches, { concurrency: o.concurrency, failFast: o.failFast }, vWorker);
      } catch (e) {
        // failFast: the main pass succeeded (there were hits), so the key worked earlier.
        if (e instanceof JevProviderError && isFatalError(e) && e.kind === "invalid_api_key")
          e.hint = [e.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
        throw e;
      }
      for (const r of vPool.results) for (const g of r.got) verdictOf.set(g.hit, g.p);
      for (const e of vPool.errors) {
        if (e.error.kind === "invalid_api_key")
          e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
        for (const { hit } of vBatches[e.index])
          errors.push({
            file: hit.file, start: hit.start, end: hit.end,
            kind: e.error.kind, message: e.error.message,
            ...(e.error.hint !== undefined ? { hint: e.error.hint } : {}),
          });
      }
      // A 200 with no usable verification answer: FAIL-OPEN (the main-pass hit stands)
      // and reported, so the user can see verification could not finish for that chunk.
      for (const r of vPool.results)
        for (const hit of r.missing)
          errors.push({ file: hit.file, start: hit.start, end: hit.end, kind: "malformed_response", message: "provider returned no usable verification answer — the main-pass hit stands" });
    }
    // The hysteresis gate: a hit with no verify verdict (request failed, fail-open) falls
    // back to its main-pass p — which cleared `threshold`, so it stands.
    hits = hits.filter((h) => (verdictOf.get(h) ?? h.p) >= gate);
  }
  // --tag (WI-4): one `choice` question per STANDING hit, run AFTER --verify filtering
  // so a tag only lands on hits that survived the hysteresis gate. The categories become
  // criteria `t0..tN`; the chosen criterion's name rides on the hit as `tag` with its
  // probability as `tag_p` (the Hit objects are shared with `all`, so --all/--json see
  // them too). Batched <=TAG_BATCH_MAX hits per request through the same pool +
  // postSystemOne machinery as the verify pass (same retries, pacing, deadlines, lazy
  // key resolution); its tokens/cost meter the same way.
  // ERROR POLICY (deliberate, differs from the verify pass): the tag pass NEVER throws
  // and NEVER records errors[] — a failed tag batch (retries exhausted, breaker open,
  // --budget stopped) simply leaves those hits untagged and the search result stands.
  // Tags annotate results that already cleared the threshold; surfacing them as chunk
  // errors would turn an answered search into an exit-2 run, and --fail-fast governs
  // the search, not this annotation pass.
  if (o.tag && hits.length > 0) {
    const tags = parseTagCategories(o.tag);
    if (tags.length > 0) {
      const criteria: Record<string, string> = {};
      tags.forEach((t, i) => { criteria[`t${i}`] = t; });
      // <=16 hits per request even when --batch was raised (TAG_BATCH_MAX above).
      const tagBatch = Math.max(1, Math.min(TAG_BATCH_MAX, batch));
      const tBatches = packBatches(hits, tagBatch, MAX_REQUEST_BYTES, (h) => byteLen(JSON.stringify(buildTagRequest([h], tags, kind, model))));
      const tWorker = async (bh: Hit[], index: number): Promise<TagOutcome> => {
        // --budget: a tag batch that does not fit throws budget_exhausted into tPool.errors,
        // which this pass drops by policy (hits stay untagged, the run is not errored).
        const res = await send(buildTagRequest(bh, tags, kind, model));
        tokens += res.usage?.input_tokens ?? 0;
        cost = (cost ?? 0) + settledCost(res, price);
        const got: { hit: Hit; tag: string; p: number }[] = [];
        bh.forEach((hit, j) => {
          // A choice answer names its criterion by KEY (`t0`) with `probabilities`
          // keyed the same way; a provider that echoes the category NAME instead maps
          // just the same. An unusable answer leaves that hit untagged (policy above).
          const a = res.answers[`h${j}`];
          const choice = typeof a?.choice === "string" && a.choice ? a.choice : undefined;
          const name = choice === undefined ? undefined : criteria[choice] ?? choice;
          const p = a?.probabilities?.[choice ?? ""] ?? a?.probabilities?.[name ?? ""];
          if (name !== undefined && tags.includes(name) && typeof p === "number" && Number.isFinite(p))
            got.push({ hit, tag: name, p });
        });
        return { index, got };
      };
      // failFast is deliberately NOT honored here (error policy above): every failure
      // lands in tPool.errors and is dropped — hits stay untagged, nothing is recorded.
      const tPool = await runPool(tBatches, { concurrency: o.concurrency }, tWorker);
      for (const r of tPool.results) for (const g of r.got) { g.hit.tag = g.tag; g.hit.tag_p = g.p; }
    }
  }
  // --group (WI-3): one Group per signature present in the hits, sorted p desc (stable
  // for ties: first-site order). Sites keep hit (file) order; representative is the
  // first hit's chunk body. Sites judged this run share the head's p; cache-served
  // members can carry an older p, so the group reports the best one.
  let groups: Group[] | undefined;
  if (o.group) {
    const bySig = new Map<string, Group>();
    for (const h of hits) {
      const sk = sigKey(kind, question, h);
      const g = bySig.get(sk);
      if (g) {
        g.count++;
        g.sites.push({ file: h.file, start: h.start, end: h.end });
        if (h.p > g.p) g.p = h.p;
      } else
        bySig.set(sk, { sig: sk, p: h.p, count: 1, sites: [{ file: h.file, start: h.start, end: h.end }], representative: h.text });
    }
    groups = [...bySig.values()].sort((a, b) => b.p - a.p);
  }
  return { hits, all: ordered, chunks: chunks.length, tokens, cached, errors, ...(cost !== undefined ? { cost } : {}), ...(groups !== undefined ? { groups } : {}) };
}

// ---- --funcs (WI-5): two-phase function navigation ----------------------------
/**
 * Two-phase navigation over `paths`. Pass 1 judges ONE SIGNATURE chunk per
 * supported source file (funcs.signatureChunk: regex-extracted function/method/
 * class lines, tree-sitter deferred) exactly like any chunk — a handful of chunks
 * for a whole tree. The files whose signature chunk reaches `threshold` become the
 * shortlist; pass 2 is the NORMAL chunk search run only on those files, so the
 * search cost is proportional to the shortlist instead of the whole tree.
 *
 * Files in unsupported languages (funcs.detectLanguage → null) and supported files
 * with no extractable signatures are SKIPPED entirely — pass 1 cannot shortlist
 * what it never saw (documented). The returned Result carries pass 2's hits
 * (real-code file:line); when nothing is shortlisted, pass 1's Result comes back
 * with 0 hits. Pass-1 errors, tokens, cost, chunks and cached counts are MERGED into
 * the returned Result (B3): a file whose signature batch failed was never searched,
 * so dropping its error made a partial run look clean (exit 0/1, pass-1 spend
 * unreported). A fatal throw (fail-fast, dead key) propagates as usual. With
 * --budget both passes share ONE meter, so pass 2 cannot spend a fresh budget. Both passes
 * share one cache object — a signature chunk and a code chunk never collide (the
 * judged text differs), so a re-run replays either pass for free.
 */
export async function jgrepFuncs(question: string, paths: string[], o: Options): Promise<Result> {
  const sigChunks: Chunk[] = [];
  for (const file of withinSize(listFiles(paths, { followSymlinks: o.followSymlinks }), o.maxBytes)) {
    const lang = detectLanguage(file);
    if (!lang) continue; // unsupported language: excluded from --funcs search (documented)
    const text = readText(file, o.maxBytes);
    if (text === null) continue; // binary (size was filtered and reported above)
    sigChunks.push(...signatureChunks(file, text, lang)); // every signature, split to fit — never cut
  }
  // Pass 1 never tags (--tag stripped): its hits are only a shortlist — never printed
  // — so tagging them would be a wasted request. Pass 2 tags the real hits.
  const meter = o.meter ?? (o.budget !== undefined ? new BudgetMeter(o.budget, o.pricePerMtok ?? DEFAULT_PRICE_PER_MTOK) : undefined);
  const pass1 = await jgrep(question, sigChunks, { ...o, tag: undefined, meter });
  // --estimate (PR #2 open item): pass 1 above is counted exactly, but pass 2 depends on
  // pass-1 answers a dry run never gets. Price its UPPER BOUND instead — every file pass 1
  // could shortlist (the ones with a signature chunk), never unsupported languages — into
  // its own sink, so the CLI can report both numbers honestly.
  if (o.estimate) {
    if (o.estimateUpper) {
      const candidates = [...new Set(sigChunks.map((c) => c.file))];
      await jgrep(question, chunkPaths(candidates, { followSymlinks: o.followSymlinks, maxBytes: o.maxBytes }), { ...o, estimate: o.estimateUpper, meter });
    }
    return pass1;
  }
  const shortlist = [...new Set(pass1.hits.map((h) => h.file))];
  if (shortlist.length === 0) return pass1;
  const pass2 = await jgrep(question, chunkPaths(shortlist, { followSymlinks: o.followSymlinks, maxBytes: o.maxBytes }), { ...o, meter });
  const cost = pass1.cost === undefined && pass2.cost === undefined ? undefined : (pass1.cost ?? 0) + (pass2.cost ?? 0);
  return {
    ...pass2,
    chunks: pass1.chunks + pass2.chunks,
    tokens: pass1.tokens + pass2.tokens,
    cached: pass1.cached + pass2.cached,
    errors: [...pass1.errors, ...pass2.errors],
    ...(cost !== undefined ? { cost } : {}),
  };
}

// ---- config -----------------------------------------------------------------
// Providers, keys and their verification live in providers.ts (~/.jgrep/providers.json,
// TRDD-3KBUODCE); `jgrep init` writes that file.
// Agent-skill installation moved to init.ts: the vercel `skills` universal installer
// (`installToAgentsDir` there is the fallback) replaced the old per-harness copy.
