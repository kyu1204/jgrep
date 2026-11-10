// Provider registry (TRDD-3KBUODCE): the user's ~/.jgrep/providers.json lists providers in
// priority order (the array order IS the fallback chain), built-ins fill defaults; key
// resolution ($VAR / literal, then the old key stores); the fallback chain with its per-run
// circuit breaker and errors.log; the request adapters; plus the WI-11 HTTP engine
// (RateLimiter, postSystemOne, verifyApiKey). Same file schema as Quicksilver's
// ~/.quicksilver/providers.json. No deps.
import {
  classifyStatus, classifyTransport, isRedirectError, jitteredDelayMs, parseRetryAfter, JevProviderError,
  RETRY_AFTER_MAX_MS, type JevErrorKind,
} from "./errors";
// BudgetMeter is defined in jgrep.ts; importing it here (even type-only) creates a runtime
// circular import under Bun, so PostOpts holds a structural type with the surface post() uses.
// providers.ts must not import jgrep.ts at runtime (Step 4 rewires callers).
export interface BudgetMeterLike {
  budget: number;
  pricePerMtok: number;
  reserve(req: unknown, provider: string, price: number): number;
  settle(res: { usage?: { input_tokens?: number }; cost?: number } | undefined, est: number, price: number, err?: { kind: string; status?: number }): void;
}
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import { spawnSync } from "node:child_process";

// Ambient so the file typechecks without node types; keep all process usage to this shape.
declare const process: { env: Record<string, string | undefined>; cwd(): string; platform: string; pid: number; getuid?: () => number };

/** process.env-shaped map; stand-in for NodeJS.ProcessEnv while the repo ships no node types. */
export type Env = Record<string, string | undefined>;

// ---- price -------------------------------------------------------------------
export const DEFAULT_PRICE_PER_MTOK = 0.042;

/** $/Mtok for cost math: JEV_PRICE_PER_MTOK override; invalid (non-finite, <= 0) is fatal. */
export function resolvePricePerMtok(env: Env = process.env): number {
  const raw = env.JEV_PRICE_PER_MTOK?.trim();
  if (!raw) return DEFAULT_PRICE_PER_MTOK;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new JevProviderError("bad_request", `JEV_PRICE_PER_MTOK must be a positive number (got "${raw}")`, {
      provider: "generic", retryable: false, hint: "JEV_PRICE_PER_MTOK is dollars per million input tokens, e.g. 0.042",
    });
  }
  return n;
}

// ---- the home: ~/.jgrep -------------------------------------------------------
/** A config problem the user fixes in a file or the environment (exit 2 via cli.ts). */
const configError = (message: string, hint?: string): JevProviderError =>
  new JevProviderError("bad_request", message, { provider: "config", retryable: false, hint });

/** jgrep's single home (user decision: "one file per tool"): providers.json, cache.json and
 *  errors.log live in $JGREP_HOME (absolute; the tests use it) or ~/.jgrep. Never a project
 *  directory: a cloned repo must not be able to choose where jgrep reads its keys from. */
export function jgrepHome(env: Env = process.env, homeDir: string = os.homedir()): string {
  const h = env.JGREP_HOME?.trim();
  if (!h) return path.join(homeDir, ".jgrep");
  if (!path.isAbsolute(h)) throw configError(`JGREP_HOME must be an absolute path, got "${h}"`);
  return h;
}
export const providersFile = (env: Env = process.env, homeDir: string = os.homedir()): string => path.join(jgrepHome(env, homeDir), "providers.json");
export const errorsLogFile = (env: Env = process.env, homeDir: string = os.homedir()): string => path.join(jgrepHome(env, homeDir), "errors.log");

/** Write `text` to `file` atomically: a temp file in the same directory (mode 0600) renamed
 *  over the target, so a crash never leaves a half-written file and the result always has
 *  `mode`. The directory is the home, which holds keys: created and kept 0700. */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // mkdir's mode only applies on create; an existing 0755 home is tightened
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode); // the umask can clear bits of `mode` on create
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup is best-effort; the write error below is the news */ }
    throw e;
  }
}

// ---- old key stores (user decision: "Keep them as extra fallbacks") -------------
export function configDir(homeDir: string = os.homedir()): string { return path.join(homeDir, ".config", "jgrep"); }
export function legacyEnvFile(homeDir: string = os.homedir()): string { return path.join(configDir(homeDir), "env"); }
export function keyFilePath(name: string, homeDir: string = os.homedir()): string {
  return path.join(configDir(homeDir), `${name}.key`);
}

/** Same hand-rolled parser as the old jgrep.ts resolver: tolerates an `export ` prefix,
 *  quotes, spacing and trailing # comments; first matching line wins. */
export function parseEnvKeyFile(text: string, keyEnv: string): string | null {
  const m = new RegExp(`^\\s*(?:export\\s+)?${keyEnv}\\s*=\\s*["']?([^"'\\r\\n#]+)`, "m").exec(text);
  return m ? m[1].trim() : null;
}

/** First non-empty trimmed line of the file; null when missing or unreadable. */
export function readKeyFile(p: string): string | null {
  let text: string;
  try { text = fs.readFileSync(p, "utf8"); } catch { return null; }
  for (const line of text.split(/\r?\n/)) { const t = line.trim(); if (t) return t; }
  return null;
}

function readTextOrNull(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/** A .gitignore line that covers ./.env (plain entry or inside a directory). */
const GITIGNORE_ENV_RE = /((^|\/|\.)\.env$)/;

/** Is `<cwd>/.env` gitignored? In a git repo git itself answers (`git check-ignore`), so
 *  patterns such as `*.env`, `/.env` or a parent directory's .gitignore count — the old
 *  exact-line check warned falsely on those (audit NIT). Outside a repo the project's own
 *  ./.gitignore is the declaration; with neither, undefined (nothing declares anything). */
export function envIsGitignored(cwd: string): boolean | undefined {
  const r = spawnSync("git", ["-C", cwd, "check-ignore", "-q", ".env"], { stdio: "ignore" });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  let gitignore: string;
  try { gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"); } catch { return undefined; }
  return gitignore.split(/\r?\n/).some((l: string) => GITIGNORE_ENV_RE.test(l.trimEnd()));
}

/** Key came from cwd .env (`source` names the file and variable): warn when git (or the
 *  .gitignore) says that file is not ignored. */
function warnIfEnvNotGitignored(source: string, cwd: string): void {
  if (envIsGitignored(cwd) !== false) return;
  const msg = `warning: the key in ${source} is not gitignored — your key may leak`;
  console.error(process.env.NO_COLOR ? msg : `\x1b[33m${msg}\x1b[0m`);
}

// ---- providers.json schema (version 1, shared with Quicksilver) ------------------
export type Adapter = "system-one" | "cloudflare-ai-run" | "vercel-evaluation";
export const ADAPTER_NAMES: Adapter[] =["system-one", "cloudflare-ai-run", "vercel-evaluation"];

/** One entry of providers.json, in the file's own (snake_case) schema. */
export interface ProviderEntry {
  name: string; enabled?: unknown; base_url?: string; path?: string; adapter?: string;
  api_key?: string | string[]; account_id?: string | string[]; model?: string; model_pattern?: string;
  cost_field?: string | null; usd_per_mtok?: number | null; verify?: string | null;
  headers?: Record<string, string>; key_url?: string;
}

/** Built-in providers, written in the providers.json entry schema and validated like a user
 *  entry. Their order is the chain when there is no providers.json (user decision: openrouter
 *  first, typesafe second). `compatible` (jgrep's old "gateway") has no base_url until the user
 *  gives one, or exports JEV_GATEWAY_URL. Cost: cost_field is left unset on the System One
 *  providers so jgrep keeps reading `cost`, `usage.cost` or `cost_usd`, and usd_per_mtok is
 *  unset so JEV_PRICE_PER_MTOK prices them; Cloudflare and Vercel report no cost. */
export const BUILTINS: ProviderEntry[] = [
  { name: "openrouter", base_url: "https://openrouter.ai/api", path: "/v1/systemone", adapter: "system-one", api_key: "$OPENROUTER_API_KEY",
    model: "~typesafe/jev-latest", model_pattern: "/", verify: "/v1/key", key_url: "https://openrouter.ai/settings/keys" },
  { name: "typesafe", base_url: "https://api.typesafe.ai", path: "/v1/systemone", adapter: "system-one", api_key: ["$JEV_API_KEY", "$TYPESAFE_API_KEY"],
    model: "jev-latest", model_pattern: "^[^/]+$", verify: "/v1/models", key_url: "https://console.typesafe.ai" },
  { name: "compatible", path: "/v1/systemone", adapter: "system-one", api_key: "$JEV_GATEWAY_API_KEY", model: "jev-latest", verify: null },
  // Workers AI serves Jev only as the unpinned alias typesafe/jev and bills it in its own dashboard.
  { name: "cloudflare", base_url: "https://api.cloudflare.com/client/v4", path: "/accounts/{account_id}/ai/run", adapter: "cloudflare-ai-run",
    api_key: ["$JEV_CLOUDFLARE_API_TOKEN", "$CLOUDFLARE_API_TOKEN"], account_id: "$CLOUDFLARE_ACCOUNT_ID", model: "typesafe/jev", model_pattern: "^typesafe/",
    cost_field: null, verify: "/user/tokens/verify", key_url: "https://dash.cloudflare.com/profile/api-tokens" },
  // The gateway replaces a model outside typesafe-ai/ with typesafe-ai/jev, so the pattern keeps ids honest. No free key check.
  { name: "vercel", base_url: "https://ai-gateway.vercel.sh", path: "/v4/ai/evaluation-model", adapter: "vercel-evaluation", api_key: "$AI_GATEWAY_API_KEY",
    model: "typesafe-ai/jev", model_pattern: "^typesafe-ai/", cost_field: null, verify: null },
  // A local mlx-decision server (github.com/armbues/mlx-decision): its POST /v1/systemone IS the
  // System One API, and elephant-1 is the local model. No key on loopback and no per-call cost;
  // jgrep never starts it (one server per machine holds ~15 GB). LAST in the chain: it answers
  // only after a hosted provider has failed. No base_url: MLX_DECISION_URL gives it, so a machine
  // running nothing is "no-url" and skipped like compatible, never pointing at a port it lacks.
  // model_pattern is the exact id: the server answers an unknown model name with its own
  // default, and caching that under a foreign id would be wrong.
  { name: "mlx", path: "/v1/systemone", adapter: "system-one", api_key: "$MLX_DECISION_API_KEY",
    model: "elephant-1", model_pattern: "^elephant-1$", cost_field: null, usd_per_mtok: 0, verify: "/health",
    key_url: "https://github.com/armbues/mlx-decision" },
];

/** Billing pages for the out-of-credits hint (the hosted System One providers). */
const BILLING: Record<string, string> = { openrouter: "https://openrouter.ai/credits", typesafe: "https://console.typesafe.ai" };

const FIELDS = ["name", "enabled", "base_url", "path", "adapter", "api_key", "account_id", "model", "model_pattern", "cost_field", "usd_per_mtok", "verify", "headers", "key_url"];
const REQUIRED = ["base_url", "path", "adapter", "api_key", "model"] as const; // for a provider that is not built in
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const VAR_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
/** Base rule for a model id; it also keeps an id safe inside the Vercel ai-model-id header. */
export const MODEL_RE = /^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,127}$/;
const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const SECRET_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-api-key)$|-(key|token)$/i;
const ACCOUNT_RE = /^[A-Za-z0-9]{1,64}$/;
// User decision: "enabled" accepts these words, case-insensitive; anything else is an error.
// Exported: cli.ts USAGE and the error below list them from here, so the docs cannot drift.
export const TRUE_WORDS: ReadonlySet<string> = new Set(["true", "enabled", "enable", "1", "yes", "y", "active", "on"]);
export const FALSE_WORDS: ReadonlySet<string> = new Set(["false", "disabled", "disable", "0", "no", "n", "inactive", "off"]);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Plain http:// to localhost / 127.0.0.1 / [::1] — a local server, not a cleartext hop. */
export function isLoopbackHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && LOOPBACK.includes(u.hostname);
  } catch { return false; }
}

/** A key rides in the Authorization header, so plain http is allowed only to this machine,
 *  and nothing in the URL may carry a credential or a query. */
function checkUrl(v: string, where: string): void {
  let u: URL;
  try { u = new URL(v); } catch { throw configError(`${where} is not a valid URL: "${v}"`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.includes(u.hostname))) {
    throw configError(`${where} must use https (plain http only for localhost, 127.0.0.1 or [::1]), got ${u.origin}`, "use an https:// endpoint, or http://localhost for a local server");
  }
  if (u.username || u.password || u.search || u.hash) throw configError(`${where} must not hold a user name, password, query or fragment`);
}

// User decision: a credential is "$NAME" / "${NAME}" (read from the process environment) or the
// literal value; an array lists fallbacks and the first one that is set wins. An unset variable
// is not an error: the provider is just not ready (skipped without a word unless it is pinned).
const credList = (v: unknown): unknown[] => [].concat((v ?? []) as never);
function checkCred(v: unknown, where: string): void {
  const list = credList(v);
  if (!list.length || list.some((s) => typeof s !== "string")) throw configError(`${where} must be a string or a non-empty array of strings`);
  for (const s of list as string[]) if (s.startsWith("$") && !VAR_RE.test(s)) throw configError(`${where}: a value starting with $ must be $NAME or \${NAME} (letters, digits, _)`);
}
const varName = (s: string): string | undefined => { const m = VAR_RE.exec(s); return m ? m[1] || m[2] : undefined; };
const isLiteral = (s: unknown): boolean => typeof s === "string" && s !== "" && !s.startsWith("$");

function parseEnabled(v: unknown, where: string): boolean {
  if (v === undefined || v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const w = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (TRUE_WORDS.has(w)) return true;
  if (FALSE_WORDS.has(w)) return false;
  // Listed from the sets (the old hand-written list omitted enable/disable and y/n).
  throw configError(`${where}: "enabled" must be one of ${[...TRUE_WORDS].join(", ")} or ${[...FALSE_WORDS].join(", ")} (any case), got ${JSON.stringify(v)}`);
}

/** A validated entry: the merged fields plus the parsed `enabled` and the compiled pattern. */
interface Entry extends ProviderEntry { enabled: boolean; path: string; adapter: Adapter; api_key: string | string[]; model: string; modelRe?: RegExp; headers: Record<string, string> }

/** One merged entry (built-in fields overridden by the file's) -> the validated entry. Every
 *  problem throws naming the entry and the field: a malformed file never falls back to defaults. */
function checkEntry(e: ProviderEntry, where: string): Entry {
  for (const k of Object.keys(e)) if (!FIELDS.includes(k)) throw configError(`${where}: unknown field "${k}"`);
  const bad = (k: string, want: string) => configError(`${where}: "${k}" must ${want}`);
  const r = e as unknown as Record<string, unknown>;
  for (const k of ["base_url", "path", "adapter", "model", "model_pattern", "key_url"]) if (r[k] !== undefined && typeof r[k] !== "string") throw bad(k, "be a string");
  for (const k of ["verify", "cost_field"]) if (r[k] != null && typeof r[k] !== "string") throw bad(k, "be a string or null");
  if (e.base_url !== undefined) checkUrl(e.base_url, `${where}: "base_url"`);
  if (e.key_url !== undefined) checkUrl(e.key_url, `${where}: "key_url"`);
  const p = e.path ?? "";
  if (!p.startsWith("/") || /[?#]/.test(p)) throw bad("path", "start with / and hold no ? or #");
  if (/\{(?!account_id\})/.test(p)) throw bad("path", "hold no placeholder other than {account_id}");
  if (e.verify != null && (!e.verify.startsWith("/") || /[?#{]/.test(e.verify))) throw bad("verify", "be a path starting with / (no ?, # or {), or null");
  if (!ADAPTER_NAMES.includes(e.adapter as Adapter)) throw bad("adapter", `be one of ${ADAPTER_NAMES.join(", ")}`);
  checkCred(e.api_key, `${where}: "api_key"`);
  if (p.includes("{account_id}")) checkCred(e.account_id, `${where}: "account_id"`);
  else if (e.account_id !== undefined) throw bad("account_id", "be used only with a path holding {account_id}");
  let modelRe: RegExp | undefined;
  if (e.model_pattern !== undefined) { try { modelRe = new RegExp(e.model_pattern); } catch { throw bad("model_pattern", "be a valid regular expression"); } }
  if (typeof e.model !== "string" || !MODEL_RE.test(e.model)) throw bad("model", `be a model id (${MODEL_RE.source})`);
  if (modelRe && !modelRe.test(e.model)) throw configError(`${where}: "model" "${e.model}" does not match its "model_pattern" ${e.model_pattern}`);
  if (e.cost_field != null && !FIELD_PATH_RE.test(e.cost_field)) throw bad("cost_field", "be a dotted field path like usage.cost, or null");
  if (e.usd_per_mtok != null && !(typeof e.usd_per_mtok === "number" && Number.isFinite(e.usd_per_mtok) && e.usd_per_mtok >= 0)) throw bad("usd_per_mtok", "be a number >= 0, or null");
  const headers = e.headers ?? {};
  if (!isObj(headers)) throw bad("headers", "be an object of name: value strings");
  for (const [h, v] of Object.entries(headers)) {
    if (!HEADER_RE.test(h) || typeof v !== "string" || /[\r\n]/.test(v)) throw bad("headers", "be an object of name: value strings");
    if (SECRET_HEADER_RE.test(h)) throw configError(`${where}: header "${h}" looks like a credential; credentials go in "api_key" only`);
  }
  return { ...e, enabled: parseEnabled(e.enabled, where), path: p, adapter: e.adapter as Adapter, api_key: e.api_key as string | string[], model: e.model, modelRe, headers: headers as Record<string, string> };
}

/** Never echo the parser's message: V8 quotes the input around the error, and the file may
 *  hold a literal key. Only the position is reported, as line and column, when the engine
 *  gives one (V8 does; Bun's message carries none, so there is nothing to report). */
function parseConfigJson(raw: string, file: string): unknown {
  try { return JSON.parse(raw); } catch (e) {
    const msg = String((e as { message?: unknown }).message ?? "");
    const lc = /line (\d+) column (\d+)/.exec(msg), pos = /position (\d+)/.exec(msg);
    let at = "";
    if (lc) at = ` at line ${lc[1]}, column ${lc[2]}`;
    else if (pos) { const before = raw.slice(0, Number(pos[1])); at = ` at line ${before.split("\n").length}, column ${before.length - before.lastIndexOf("\n")}`; }
    throw configError(`${file} is not valid JSON${at}`);
  }
}

/** The parsed providers.json, or null when there is none. Only the location rules and the
 *  JSON are checked here, not the schema. */
export function readProvidersDoc(env: Env = process.env, homeDir: string = os.homedir()): unknown {
  const file = providersFile(env, homeDir);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
  return parseConfigJson(raw, file);
}

/** The document every built-in by name, in built-in order: the chain when there is no file,
 *  and what `jgrep init` writes first so the whole chain is visible and editable. */
export const builtinDoc = (): { version: 1; providers: ProviderEntry[] } => ({ version: 1, providers: BUILTINS.map((b) => ({ name: b.name })) });

/** doc -> the validated entries: EXACTLY the file's entries, in file order. User decision: the
 *  array order "is the exact order of priority and fallback ... any change or addition to the
 *  providers will reflect the fallback", so a built-in the file does not name is never appended
 *  (removing vercel from the file must stop every request to vercel). A built-in named in the
 *  file only supplies defaults, overridden field by field; any other name is a new provider and
 *  must be complete. */
export function buildEntries(doc: unknown, where: string): Entry[] {
  if (!isObj(doc)) throw configError(`${where} must hold a JSON object`);
  for (const k of Object.keys(doc)) if (!["version", "providers"].includes(k)) throw configError(`${where}: unknown field "${k}"`);
  if (doc.version !== 1) throw configError(`${where}: "version" must be 1`);
  if (!Array.isArray(doc.providers)) throw configError(`${where}: "providers" must be an array`);
  const builtin = new Map(BUILTINS.map((b) => [b.name, b]));
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const [i, e] of (doc.providers as unknown[]).entries()) {
    const at = `${where} providers[${i}]`;
    if (!isObj(e)) throw configError(`${at} must be an object`);
    if (typeof e.name !== "string" || !NAME_RE.test(e.name)) throw configError(`${at}: "name" must be ${NAME_RE.source}`);
    if (seen.has(e.name)) throw configError(`${at}: duplicate name "${e.name}"`);
    seen.add(e.name);
    const base = builtin.get(e.name);
    if (!base) for (const f of REQUIRED) if (e[f] === undefined) throw configError(`${at} ("${e.name}"): "${f}" is required for a provider that is not built in`);
    out.push(checkEntry({ ...base, ...e } as ProviderEntry, `${at} ("${e.name}")`));
  }
  // A custom entry on a known provider's host (a built-in's default host, or the host the file
  // gives a built-in) inherits that provider's free key check, so status can verify it. An
  // explicit "verify": null is kept.
  const host = (u?: string) => (u ? new URL(u).host : null);
  const checks = [...out.filter((p) => builtin.has(p.name)), ...BUILTINS].filter((p) => p.verify);
  for (const p of out) if (!builtin.has(p.name) && p.verify === undefined) p.verify = checks.find((k) => host(k.base_url) === host(p.base_url))?.verify ?? null;
  // One $VAR, one provider: otherwise a key exported for one service would be sent to another one's URL.
  const owner = new Map<string, string>();
  for (const p of out.filter((x) => x.enabled)) {
    for (const s of [...credList(p.api_key), ...credList(p.account_id)] as string[]) {
      const n = varName(s);
      if (!n) continue;
      if (owner.has(n) && owner.get(n) !== p.name) throw configError(`${where}: $${n} is used by both "${owner.get(n)}" and "${p.name}"; a key may belong to one provider only (rename one, or disable one)`);
      owner.set(n, p.name);
    }
  }
  return out;
}

/** A literal key in a file others can read is refused (not silently chmod-ed: the file is the user's). */
function checkFileMode(doc: unknown, file: string): void {
  const literal = isObj(doc) && Array.isArray(doc.providers) && doc.providers.some((e) => isObj(e) && credList(e.api_key).some(isLiteral));
  if (!literal || process.platform === "win32") return;
  const st = fs.statSync(file);
  if ((st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) {
    throw configError(`${file} holds a literal api_key but other users can read it (or it is not yours)`, `run: chmod 600 ${file}`);
  }
}

// ---- resolved providers ---------------------------------------------------------
/** A provider ready to be called: endpoint, adapter, model rules and pricing. `url` is the full
 *  POST URL ("" when not configured); `verify` the full URL of a free GET key check, or null. */
export interface Backend {
  name: string;
  url: string;
  adapter: Adapter;
  model: string;
  modelPattern?: RegExp;
  apiKey: string[];          // credential references from api_key: $VAR names or a literal
  headers: Record<string, string>;
  verify: string | null;
  costField?: string | null; // undefined: jgrep's reported-cost lookup (cost, usage.cost, cost_usd)
  usdPerMtok?: number | null;
  keyUrl?: string;
}

/** Entry -> Backend. `account` is the resolved account id (Cloudflare); without one a path
 *  that needs it leaves the provider without a URL. */
function toBackend(e: Entry, account?: string): Backend {
  const base = (e.base_url ?? "").replace(/\/$/, "");
  const needsAccount = e.path.includes("{account_id}");
  const url = !base || (needsAccount && !account) ? "" : base + e.path.replace("{account_id}", account ?? "");
  return {
    name: e.name, url, adapter: e.adapter, model: e.model, modelPattern: e.modelRe,
    apiKey: credList(e.api_key) as string[], headers: e.headers,
    verify: base && e.verify ? base + e.verify : null,
    costField: e.cost_field, usdPerMtok: e.usd_per_mtok, keyUrl: e.key_url,
  };
}

/** The built-ins as Backends, environment-free (Cloudflare has no URL until its account id is
 *  known). Library callers and tests pick one explicitly; the CLI resolves the chain instead. */
export const BACKENDS: Record<string, Backend> = Object.fromEntries(BUILTINS.map((b) => [b.name, toBackend(checkEntry({ ...b }, `built-in provider "${b.name}"`))]));

export type ProviderState = "ready" | "disabled" | "no-url" | "no-key" | "no-account";
/** A provider with its key resolved: where the key came from (never the key itself in output),
 *  what was tried, and whether it can take requests. */
export interface Provider extends Backend { enabled: boolean; key: string; keySource: string; tried: string[]; acctTried?: string[]; state: ProviderState }

/** Key for `b`, first hit wins: api_key from providers.json ($VAR from the process environment,
 *  or the literal), then the old stores the user chose to keep as fallbacks: ~/.config/jgrep/
 *  <name>.key (gateway.key for compatible, its old name), then each $VAR name of api_key in the
 *  legacy ~/.config/jgrep/env, then in ./.env of the project. `tried` lists the variables. */
function findKey(b: Backend, env: Env, homeDir: string, cwd: string): { key: string; source: string; tried: string[] } {
  const tried: string[] = [];
  for (const s of b.apiKey) {
    const n = varName(s);
    if (!n) { if (s) return { key: s, source: "literal in providers.json", tried }; continue; }
    tried.push(`$${n}`);
    const v = env[n]?.trim();
    if (v) return { key: v, source: `$${n}`, tried };
  }
  const kf = keyFilePath(b.name === "compatible" ? "gateway" : b.name, homeDir);
  const fromFile = readKeyFile(kf);
  if (fromFile) return { key: fromFile, source: kf, tried };
  const names = b.apiKey.map(varName).filter((n): n is string => !!n);
  for (const [file, label] of [[legacyEnvFile(homeDir), legacyEnvFile(homeDir)], [path.join(cwd, ".env"), "./.env"]]) {
    const text = readTextOrNull(file);
    if (text == null) continue;
    for (const n of names) { const k = parseEnvKeyFile(text, n); if (k) return { key: k, source: `${label} (${n})`, tried }; }
  }
  return { key: "", source: "", tried };
}

/** Where a missing key was looked for, for the error message. */
const lookedIn = (b: Backend, homeDir: string, tried: string[]): string =>
  [...tried, keyFilePath(b.name === "compatible" ? "gateway" : b.name, homeDir), `${legacyEnvFile(homeDir)} (legacy env file)`, "./.env (this project)"].join(", ");

function missingKeyError(b: Backend, homeDir: string, tried: string[]): JevProviderError {
  return new JevProviderError("invalid_api_key", `No ${b.name} API key found. Looked in: ${lookedIn(b, homeDir, tried)}`, {
    provider: b.name, retryable: false,
    hint: `export ${tried[0]?.slice(1) ?? "the key"}, set "api_key" on the ${b.name} entry of ${providersFile(process.env, homeDir)}, or run \`jgrep init\``,
  });
}

/** API key for one explicit backend (library callers and the single-provider chain); warns
 *  when the key came from a ./.env that git does not ignore. A loopback http server needs no
 *  key (upstream #19). Throws invalid_api_key naming every place it looked. */
export function resolveApiKey(backend: Backend, env: Env = process.env, homeDir: string = os.homedir(), cwd: string = process.cwd()): string {
  const found = findKey(backend, env, homeDir, cwd);
  if (found.source.startsWith("./.env")) warnIfEnvNotGitignored(found.source, cwd);
  if (found.key) return found.key;
  if (isLoopbackHttp(backend.url)) return "";
  throw missingKeyError(backend, homeDir, found.tried);
}

/** The full System One endpoint of `compatible` when the file gives it no base_url:
 *  JEV_GATEWAY_URL (or upstream's JGREP_ENDPOINT), else the URL an old `jgrep init` saved in
 *  the user's own ~/.config/jgrep/env. Read from the PROCESS env and the user's config only,
 *  never from a project's ./.env: a cloned repo must not be able to redirect requests (and the
 *  Authorization header with them) to its own server. */
function gatewayUrlOf(env: Env, homeDir: string): string | undefined {
  const legacy = readTextOrNull(legacyEnvFile(homeDir));
  return env.JEV_GATEWAY_URL?.trim() || env.JGREP_ENDPOINT?.trim() || (legacy == null ? undefined : parseEnvKeyFile(legacy, "JEV_GATEWAY_URL") ?? undefined);
}

/** The files Bun auto-loads into process.env from the working directory (Node loads none). */
const BUN_DOTENV_FILES = [".env", ".env.local", ".env.development", ".env.production", ".env.test", ".env.development.local", ".env.production.local", ".env.test.local"];

/** Under Bun, refuse routing variables whose process value equals an entry of a ./.env* file
 *  Bun auto-loaded (audit, probe-verified): these are read from the PROCESS env only so a
 *  cloned repo cannot point requests (code and the Authorization header), or jgrep's home with
 *  its keys, at its own choice — but Bun fills the process env from ./.env first, which
 *  reopened exactly that. The shipped bin runs under node and never hits this. */
function refuseBunDotenv(names: string[], env: Env, cwd: string): void {
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return;
  for (const file of BUN_DOTENV_FILES) {
    const text = readTextOrNull(path.join(cwd, file));
    if (text == null) continue;
    for (const n of names) {
      const v = env[n]?.trim();
      if (v && parseEnvKeyFile(text, n) === v) {
        throw new JevProviderError("bad_request", `${n} comes from ./${file}, which Bun loads automatically — jgrep never takes ${n} from a project's env file (a cloned repo could redirect your code and key)`, {
          provider: "generic", retryable: false, hint: `run jgrep under node (the installed bin does), or export ${n} in your shell and remove it from ./${file}`,
        });
      }
    }
  }
}

/** Every provider of the chain with its state: the file's entries (or the built-ins when there
 *  is no file), keys and account ids resolved. Throws on any config problem. `draft` is a
 *  document not written yet (`jgrep init` checks the entry it is about to save). */
export function loadProviders(env: Env = process.env, homeDir: string = os.homedir(), cwd: string = process.cwd(), draft?: unknown): { providers: Provider[]; file: string; exists: boolean } {
  refuseBunDotenv(["JGREP_HOME", "JEV_API", "JEV_GATEWAY_URL", "JGREP_ENDPOINT", "MLX_DECISION_URL"], env, cwd);
  const file = providersFile(env, homeDir);
  const doc = draft ?? readProvidersDoc(env, homeDir);
  const entries = buildEntries(doc ?? builtinDoc(), doc ? file : "built-in providers");
  // Structural free-local fallback (TRDD-3KBUODCE): a file that names no "mlx" entry gets the
  // built-in mlx entry appended LAST, so every chain ends in a free local server that answers
  // when the hosted providers fail or the budget is spent. A file that names mlx keeps its own
  // (its position, its enabled flag — enabled:false removes it from the chain, by design).
  // The built-in chain (no file) already ends in mlx; only a file that omits it is amended.
  if (doc && !entries.some((e) => e.name === "mlx")) {
    const mlx = checkEntry({ ...BUILTINS.find((b) => b.name === "mlx")! }, `${file} (appended mlx fallback)`);
    // The one-key-one-provider check ran inside buildEntries before this append, so a custom
    // enabled provider that uses $MLX_DECISION_API_KEY would collide with the appended mlx
    // undetected. Check it here: the appended mlx is keyless on loopback, but an https
    // MLX_DECISION_URL would send the same key to two servers (TRDD-3KBUODCE review finding).
    if (mlx.enabled) for (const s of credList(mlx.api_key) as string[]) {
      const n = varName(s);
      if (!n) continue;
      const clash = entries.find((e) => e.enabled && [...credList(e.api_key), ...credList(e.account_id)].some((x) => varName(x) === n)); // no e.name check: the append runs only when no file entry is mlx
      if (clash) throw configError(`${file}: $${n} is used by both "${clash.name}" and the appended mlx fallback; a key may belong to one provider only (name mlx in the file and disable it, or rename one)`);
    }
    entries.push(mlx);
  }
  if (doc && draft === undefined) checkFileMode(doc, file);
  const providers = entries.map((e): Provider => {
    let acct: { value: string; tried: string[] } | undefined;
    if (e.path.includes("{account_id}")) {
      acct = { value: "", tried: [] };
      for (const s of credList(e.account_id) as string[]) {
        const n = varName(s);
        if (!n) { if (s) { acct.value = s; break; } continue; }
        acct.tried.push(`$${n}`);
        const v = env[n]?.trim();
        if (v) { acct.value = v; break; }
      }
      // Checked only for an enabled provider: a disabled entry must never stop a run.
      if (e.enabled && acct.value && !ACCOUNT_RE.test(acct.value)) throw configError(`provider "${e.name}": the account id must be 1-64 letters or digits`);
    }
    let b = toBackend(e, acct?.value);
    if (e.name === "compatible" && e.base_url === undefined && e.enabled) {
      const gw = gatewayUrlOf(env, homeDir);
      if (gw) { checkUrl(gw, "JEV_GATEWAY_URL"); b = { ...b, url: gw }; }
    }
    // A local mlx-decision server (github.com/armbues/mlx-decision). MLX_DECISION_URL is the
    // server's base URL; a full System One endpoint is accepted too (the adjacent
    // JEV_GATEWAY_URL habit), so the path is appended only when it is not already there.
    // Process env only, never a project's ./.env (refuseBunDotenv below): a cloned repo
    // must not point local requests at its own server. An explicit base_url in providers.json
    // wins, exactly as it does for compatible: the env var is the fallback, not an override.
    if (e.name === "mlx" && e.enabled && e.base_url === undefined && env.MLX_DECISION_URL?.trim()) {
      const raw = (env.MLX_DECISION_URL as string).trim().replace(/\/$/, "");
      checkUrl(raw, "MLX_DECISION_URL");
      const base = raw.endsWith(e.path) ? raw.slice(0, -e.path.length) : raw;
      b = { ...b, url: base + e.path, verify: e.verify ? base + e.verify : null };
    }
    const k = findKey(b, env, homeDir, cwd);
    // A local System One server (loopback http) needs no key: nothing is sent in the clear.
    const keyless = !k.key && isLoopbackHttp(b.url);
    // Same order as Quicksilver: a missing key is named before a missing account id.
    const needsAccount = acct !== undefined && !acct.value;
    const state: ProviderState = !e.enabled ? "disabled" : !b.url && !needsAccount ? "no-url" : !k.key && !keyless ? "no-key" : needsAccount ? "no-account" : "ready";
    return { ...b, enabled: e.enabled, key: k.key, keySource: keyless ? "none needed (local server)" : k.source, tried: k.tried, acctTried: acct?.tried, state };
  });
  return { providers, file, exists: doc !== null };
}

/** The model a provider gets: --model, then JEV_MODEL, then JGREP_MODEL, each used only when it
 *  fits the provider's model_pattern (OpenRouter ids are vendor/model, TypeSafe ids have no
 *  slash); otherwise the provider's own model, with a warning naming what was ignored. */
export function pickModel(b: Backend, flag: string | undefined, env: Env): { model: string; warning?: string } {
  let warning: string | undefined;
  for (const [src, m] of [["--model", flag], ["JEV_MODEL", env.JEV_MODEL], ["JGREP_MODEL", env.JGREP_MODEL]] as const) {
    if (!m) continue;
    if (!b.modelPattern || b.modelPattern.test(m)) return { model: m, warning };
    warning ??= `warning: ignoring ${src}=${m} for ${b.name} — not a ${b.name} model id; using ${b.model}`;
  }
  return { model: b.model, warning };
}

/** The run's chain: `--provider` / JEV_API pins one provider (no fallback), else every ready
 *  provider in file order. A pinned provider that is not ready, or an empty chain, is reported
 *  at the first request (so --estimate and fully cached runs need no key). */
export function resolveChain(o: { pin?: string; model?: string; version: string; env?: Env; homeDir?: string; cwd?: string; warn?: (msg: string) => void }): { chain: ProviderChain; providers: Provider[]; file: string; exists: boolean } {
  const env = o.env ?? process.env, homeDir = o.homeDir ?? os.homedir(), cwd = o.cwd ?? process.cwd();
  for (const [src, m] of [["--model", o.model], ["JEV_MODEL", env.JEV_MODEL], ["JGREP_MODEL", env.JGREP_MODEL]] as const) {
    if (m && !MODEL_RE.test(m)) throw configError(`${src} must be a model id (${MODEL_RE.source}), got "${m}"`);
  }
  const { providers, file, exists } = loadProviders(env, homeDir, cwd);
  const pin = o.pin?.trim() || env.JEV_API?.trim();
  let ready = providers.filter((p) => p.state === "ready");
  // A missing key is reported as invalid_api_key, a fatal kind: the pool's breaker stops the
  // run after a few batches instead of printing the same message for every one.
  const keyError = (provider: string, message: string, hint: string) => new JevProviderError("invalid_api_key", message, { provider, retryable: false, hint });
  let missing = (): JevProviderError => keyError("none",
    `no provider is ready: export a key for one of ${providers.filter((p) => p.enabled && p.state !== "no-url").map((p) => `${p.name} (${(p.state === "no-account" ? p.acctTried ?? [] : p.tried).join(" or ") || "api_key"})`).join(", ") || "the providers"}`,
    `or run \`jgrep init\`; the chain is ${exists ? file : "the built-in one (no providers.json yet)"}`,
  );
  if (pin) {
    const p = providers.find((x) => x.name === pin);
    if (!p) throw configError(`unknown provider "${pin}" (configured: ${providers.map((x) => x.name).join(", ")})`, `use one of: ${providers.map((x) => x.name).join(", ")}`);
    if (!p.enabled) throw configError(`provider "${pin}" is disabled ("enabled" in ${file}); enable it or pick another provider`);
    // A pinned provider without an endpoint is a config error, raised now (no key is involved).
    if (p.state === "no-url") throw configError(p.name === "compatible" ? `compatible needs its endpoint: set "base_url" on its entry in ${file}, or export JEV_GATEWAY_URL (the full System One endpoint, e.g. https://gw.example.com/v1/systemone)` : `provider "${p.name}" has no "base_url"; set it in ${file}`);
    ready = p.state === "ready" ? [p] : [];
    if (p.state === "no-key") missing = () => missingKeyError(p, homeDir, p.tried);
    else if (p.state === "no-account") missing = () => keyError(p.name, `no ${p.name} account id: ${(p.acctTried ?? []).join(", ")} unset or empty`, `export ${(p.acctTried ?? [])[0]?.slice(1) ?? "the account id"} or set "account_id" on the ${p.name} entry of ${file}`);
  }
  for (const p of ready) if (p.keySource.startsWith("./.env")) warnIfEnvNotGitignored(p.keySource, cwd);
  const entries = ready.map((p): ChainEntry => {
    const m = pickModel(p, o.model, env);
    return { backend: p, model: m.model, warning: m.warning, key: () => p.key };
  });
  const log = errorLogger(errorsLogFile(env, homeDir), o.version, o.warn);
  return { chain: new ProviderChain(entries, { log, warn: o.warn, missing }), providers, file, exists };
}

// ---- errors.log (user decision: "truncated at 72 hours") ---------------------------
/** ISO 8601 local time with its offset, e.g. 2026-10-02T08:30:00+02:00 (Date.parse reads it back). */
export function isoNow(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset(), pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${new Date(d.getTime() + off * 60000).toISOString().slice(0, 19)}${off < 0 ? "-" : "+"}${pad(off / 60)}:${pad(off % 60)}`;
}

/** Upstream text echoed in a message never carries the key that was sent. A "key" shorter than
 *  8 characters is no real credential (test stubs use "k"): masking it would mangle every word
 *  holding that letter, so it is left alone. */
export const redact = (s: string, key: string): string => (key.length >= 8 ? s.split(key).join("***") : s);

export const ERROR_LOG_MAX_AGE_MS = 72 * 3600_000;

/** Append one line to errors.log, dropping entries older than 72 hours, and rewrite the file
 *  whole (temp + rename, 0600). ponytail: two jgrep processes logging at the same instant can
 *  drop one line (the last rename wins); a lock file is the upgrade if that ever matters. */
export function appendErrorLog(file: string, line: string, now: number = Date.now()): void {
  let old = "";
  try { old = fs.readFileSync(file, "utf8"); } catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
  const kept = old.split("\n").filter((l: string) => Date.parse(l.slice(0, l.indexOf(" "))) >= now - ERROR_LOG_MAX_AGE_MS);
  writeFileAtomic(file, kept.map((l: string) => `${l}\n`).join("") + line);
}

/** A ChainLog writing one line per provider error event to `file`: timestamp, version,
 *  provider, model, kind, HTTP status, where the request went next, message and hint, with the
 *  key redacted. A provider skipped for an unset variable never reaches here (not an error).
 *  A failed write must not end the run: it is reported once on stderr. */
export function errorLogger(file: string, version: string, warn: (msg: string) => void = (m) => console.error(m)): ChainLog {
  let warned = false;
  return (e, entry, fallback) => {
    const key = entry.key();
    const line = `${isoNow()} jgrep/${version} provider=${entry.backend.name} model=${entry.model} kind=${e.kind} status=${e.status ?? "-"} fallback=${fallback} msg=${JSON.stringify(redact(e.message, key))}${e.hint ? ` hint=${JSON.stringify(redact(e.hint, key))}` : ""}\n`;
    try { appendErrorLog(file, line); } catch (err) {
      if (!warned) warn(`warning: could not write ${file}: ${(err as Error).message}`);
      warned = true;
    }
  };
}

// ---- the chain -----------------------------------------------------------------------
/** One provider of the run's chain: its backend, the model it is asked with (a --model that
 *  does not fit it is replaced by its own, `warning` says so on first use) and its key. */
export interface ChainEntry { backend: Backend; model: string; key: () => string; warning?: string }
/** Which provider and model answered a request (the cache key uses the model). */
export interface Via { provider: string; model: string }
export type ChainLog = (e: JevProviderError, entry: ChainEntry, fallback: string) => void;

/** Failures that hand the request to the next provider (user decision: fall back "in case of
 *  errors, exhausted credits, or missing env var"). bad_request is a request-shape problem that
 *  would fail on every provider, so it never falls back. */
export const FALLBACK_KINDS: ReadonlySet<JevErrorKind> = new Set<JevErrorKind>([
  "invalid_api_key", "insufficient_credits", "model_unavailable", "rate_limited", "server_unreachable",
  "timeout", "tls_error", "malformed_response", "forbidden", "budget_exhausted",
]);
const KEY_KINDS: ReadonlySet<JevErrorKind> = new Set<JevErrorKind>(["invalid_api_key", "insufficient_credits"]);

/** The providers a run may call, in priority order, and what happened to them this run. */
export class ProviderChain {
  /** Providers that failed this run: skipped by every later request (circuit breaker). */
  readonly dead = new Set<string>();
  /** "provider (model)" -> requests it answered. */
  readonly used = new Map<string, number>();
  /** "a → b (kind, HTTP n)" -> requests that fell back that way. */
  readonly fallbacks = new Map<string, number>();
  private readonly lastError = new Map<string, JevProviderError>();
  private readonly first = new Map<string, Promise<void>>();
  private readonly warned = new Set<string>();

  constructor(readonly entries: ChainEntry[], private readonly opts: { log?: ChainLog; warn?: (msg: string) => void; missing?: () => JevProviderError } = {}) {}

  /** The model of the first provider still in the race: new requests are built with it. */
  model(): string { return (this.entries.find((e) => !this.dead.has(e.backend.name)) ?? this.entries[0])?.model ?? "jev-latest"; }
  /** The models whose cached verdicts a run may use, the head's first. With a dead first
   *  provider every answer comes from a fallback; reading only the head's entries would make
   *  every re-run pay for all of them again. */
  models(): string[] { return [...new Set([this.model(), ...this.entries.filter((e) => !this.dead.has(e.backend.name)).map((e) => e.model)])]; }
  /** The provider named in errors raised outside a request (budget meter). */
  name(): string { return this.entries[0]?.backend.name ?? "none"; }
  /** The first provider, or the "not ready" error: for a caller that measures exactly one
   *  provider (the benchmarks), never falling back. */
  head(): ChainEntry {
    if (this.entries.length === 0) throw (this.opts.missing ?? (() => configError("no provider is configured")))();
    return this.entries[0];
  }

  /** One request through the chain: the first live provider answers, or the request moves to
   *  the next one on a FALLBACK_KINDS failure and the failed provider is out for the rest of the
   *  run. OpenRouter's per-request 403 (moderation of this text) falls back for this request
   *  only. A chain of one (pinned, or a library call) never falls back and keeps today's errors. */
  async post(body: SystemOneBody, opts: PostOpts, timeoutMs: number): Promise<PostResult & { via: Via }> {
    this.head(); // an empty chain throws its "not ready" error here, at the first request
    const multi = this.entries.length > 1;
    for (const [i, e] of this.entries.entries()) {
      const name = e.backend.name;
      if (this.dead.has(name)) continue;
      // Circuit breaker: until a provider has answered once, the run's other requests wait for
      // that first request instead of all going out in parallel; if it fails they skip the
      // provider, so a dead key or an empty wallet costs one request and one log line, not one
      // per batch. ponytail: the first request to each provider is serialized (one round trip).
      let open: (() => void) | undefined;
      if (multi) {
        const gate = this.first.get(name);
        if (gate) { await gate; if (this.dead.has(name)) continue; }
        else this.first.set(name, new Promise<void>((resolve) => { open = resolve; }));
      }
if (e.warning && !this.warned.has(name)) { this.warned.add(name); this.opts.warn?.(e.warning); }
      // --budget per provider (TRDD-3KBUODCE): each attempt reserves at THIS entry's own
      // usd_per_mtok (0 for the free local mlx server), not the run price, so a nearly-spent
      // budget still allows the free provider — budget_exhausted on a pricier entry falls back
      // to the next one instead of stopping the run. ponytail: a retried batch is charged ONE
      // estimate per attempt that reserves (an entry whose reserve throws never sends).
      const meter = opts.meter;
      const entryPrice = typeof e.backend.usdPerMtok === "number" ? e.backend.usdPerMtok : undefined;
      const pricedAt = entryPrice ?? meter?.pricePerMtok ?? 0;
      let est = 0;
      try {
        if (meter) est = meter.reserve(body, name, pricedAt);
        const res = await postSystemOne({ ...body, model: e.model }, e.backend, e.key(), { ...opts, deadlineMs: Date.now() + timeoutMs });
        if (meter) meter.settle(res, est, pricedAt);
        const used = `${name} (${e.model})`;
        this.used.set(used, (this.used.get(used) ?? 0) + 1);
        return { ...res, via: { provider: name, model: e.model } };
      } catch (err) {
        if (meter) meter.settle(undefined, est, pricedAt, err instanceof JevProviderError ? err : undefined);
        if (!(err instanceof JevProviderError)) throw err;
        const falls = multi && FALLBACK_KINDS.has(err.kind);
        const next = falls ? this.entries.slice(i + 1).find((x) => !this.dead.has(x.backend.name)) : undefined;
        this.opts.log?.(err, e, !falls ? "no" : next?.backend.name ?? "none-left");
        if (!falls) throw err;
        if (err.kind !== "forbidden") this.dead.add(name);
        this.lastError.set(name, err);
        if (next) {
          const k = `${name} → ${next.backend.name} (${err.kind}${err.status ? `, HTTP ${err.status}` : ""})`;
          this.fallbacks.set(k, (this.fallbacks.get(k) ?? 0) + 1);
        }
      } finally {
        open?.(); // after the catch marked a failed provider dead, so the waiters see it
      }
    }
    throw this.allFailed();
  }

  /** Every provider failed: one error listing each provider's failure. A key or credit failure
   *  among them is the one reported (it is the one the user can fix); else the last one. */
  private allFailed(): JevProviderError {
    const fails = this.entries.map((e) => this.lastError.get(e.backend.name)).filter((x): x is JevProviderError => !!x);
    const pick = fails.find((f) => KEY_KINDS.has(f.kind)) ?? fails[fails.length - 1];
    const list = fails.map((f) => `${f.provider}: ${f.kind}${f.status ? ` ${f.status}` : ""}`).join("; ");
    return new JevProviderError(pick.kind, `every provider failed (${list}) — ${pick.message}`, {
      provider: pick.provider, status: pick.status, retryable: false, cause: pick,
      hint: [pick.hint, "each failure is in errors.log in jgrep's home"].filter(Boolean).join("; "),
    });
  }
}

/** The chain a core call uses: the CLI's resolved chain, else a chain of one explicit backend
 *  (library callers and tests: `backend` defaults to typesafe, `model` to its own) whose key is
 *  resolved lazily at the first request, so a fully cached or dry run never touches a key store. */
export function chainFor(o: { chain?: ProviderChain; backend?: Backend; model?: string; apiKey?: string }): ProviderChain {
  if (o.chain) return o.chain;
  const backend = o.backend ?? BACKENDS.typesafe;
  let key = o.apiKey;
  return new ProviderChain([{ backend, model: o.model ?? backend.model, key: () => (key ??= resolveApiKey(backend)) }]);
}

// ---- HTTP engine (WI-11) ------------------------------------------------------
// Replaces jgrep.ts's postSystemOne/verifyApiKey: per-attempt abort timeouts, a
// batch deadline that includes retries, Retry-After-aware full-jitter backoff,
// token-bucket pacing and typed errors from errors.ts. `Fetch` is re-declared
// here — providers.ts must not import jgrep.ts (circular); Step 4 rewires callers.

/** Ambient monotonic clock — the token bucket must not jump when the wall clock is adjusted. */
declare const performance: { now(): number };
const monotonicMs = (): number => performance.now();

// Node's AbortSignal.timeout throws `RangeError: The value of "delay" is out of range.
// It must be an integer.` on fractional delays; Bun silently accepts them (WI-11 bug: the
// monotonic deadline conversion produced e.g. 14999.918084 and every batch failed as
// bad_request). Every computed ms value crossing into an abort signal is therefore
// floored to a positive integer here; timer sleeps are floored at their call sites.
const abortDelayMs = (ms: number): number => Math.max(1, Math.floor(ms));

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));

/** DI seam for fetch — same shape as the export that still lives in jgrep.ts (until Step 4). */
export type Fetch = typeof fetch;

/** Rejection for a waiter whose batch deadline lapsed before or while it waited for a
 *  pacing token: the request never started, so no token is spent. kind "timeout" stays
 *  transient-class (no breaker trip) but retryable false — a retry cannot beat the clock.
 *  The limiter is provider-agnostic; the caller names its backend via acquire opts. */
const limiterTimeoutError = (provider?: string): JevProviderError =>
  new JevProviderError(
    "timeout",
    "the provider deadline exceeded while waiting for a rate-limit token (the batch deadline includes retries)",
    { provider: provider ?? "the provider", retryable: false, hint: "lower --batch or --concurrency — the deadline includes all retries" },
  );

/** A queued acquirer: resolved with a token, or rejected once its deadline lapses. */
interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  deadlineMono?: number; // absolute monotonic ms — undefined waits forever
  provider?: string;     // backend name for the timeout rejection, when the caller knows it
}

/** Classic token bucket: `burst` tokens up front, refilled lazily at `ratePerSec`/s from a
 *  monotonic clock (no intervals). `acquire()` resolves immediately while a token is free;
 *  otherwise the waiter joins a FIFO queue and a single setTimeout is armed for the queue
 *  head's wait time. A waiter may carry a monotonic `deadlineMono`: one that has already
 *  passed rejects before waiting, and one that lapses while queued is evicted at the next
 *  refill or acquire — rejected WITHOUT consuming a token, so capacity goes to the next
 *  live waiter. ratePerSec <= 0 or non-finite means unlimited. The read-then-write
 *  sections below are await-free — on a single-threaded loop that IS the lock (§1.7). */
export class RateLimiter {
  private readonly rate: number;
  private readonly capacity: number;
  private tokens: number;
  private lastMs: number;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ratePerSec: number, burst: number) {
    this.rate = ratePerSec;
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.lastMs = monotonicMs();
  }

  private refill(): void {
    const t = monotonicMs();
    if (this.rate > 0 && Number.isFinite(this.rate)) {
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.lastMs) / 1000) * this.rate);
    }
    this.lastMs = t;
  }

  /** Integer ms until the queue head can be granted a token (0 when one is free now) —
   *  the refill math is fractional and timers take integers. */
  private headWaitMs(): number {
    return Math.max(0, Math.floor(((1 - this.tokens) / this.rate) * 1000));
  }

  /** True when the waiter carries a deadline the monotonic clock has already passed. */
  private expired(w: Waiter): boolean {
    return w.deadlineMono !== undefined && w.deadlineMono - monotonicMs() <= 0;
  }

  /** Reject and drop every queued waiter whose deadline has lapsed — no token is
   *  consumed, so the next refill goes to a live waiter (queue hygiene on arrival). */
  private evictExpired(): void {
    if (this.queue.length === 0) return;
    const live: Waiter[] = [];
    for (const w of this.queue) {
      if (this.expired(w)) w.reject(limiterTimeoutError(w.provider));
      else live.push(w);
    }
    this.queue = live;
  }

  private pump(): void {
    this.timer = null;
    this.refill();
    this.evictExpired(); // deadline hygiene for the whole queue, independent of tokens
    while (this.queue.length > 0 && this.tokens >= 1) {
      const w = this.queue.shift()!;
      if (this.expired(w)) { w.reject(limiterTimeoutError(w.provider)); continue; } // sub-ms race guard: a corpse never takes a token
      this.tokens -= 1;
      w.resolve();
    }
    if (this.queue.length > 0) this.timer = setTimeout(() => this.pump(), this.headWaitMs());
  }

  /** One pacing token. `opts.deadlineMono` (absolute monotonic ms) bounds the WAIT: an
   *  already-passed deadline rejects immediately, and a waiter whose deadline lapses
   *  while queued is evicted at the next refill or acquire — both without consuming
   *  a token. `opts.provider` names the backend for the timeout rejection. The caller
   *  keeps its own pre-attempt deadline check as the backstop. */
  acquire(opts?: { deadlineMono?: number; provider?: string }): Promise<void> {
    if (!(this.rate > 0) || !Number.isFinite(this.rate)) return Promise.resolve(); // unlimited
    this.refill();
    this.evictExpired(); // corpses leave here too, not only at refill time
    if (opts?.deadlineMono !== undefined && opts.deadlineMono - monotonicMs() <= 0) {
      return Promise.reject(limiterTimeoutError(opts?.provider)); // pre-wait: dead on arrival, no token
    }
    if (this.queue.length === 0 && this.tokens >= 1) { // never leapfrog queued waiters
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, deadlineMono: opts?.deadlineMono, provider: opts?.provider });
      if (this.timer === null) this.timer = setTimeout(() => this.pump(), this.headWaitMs());
    });
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Default deadline of a free key check (`jgrep init` and `jgrep status` use it too; USAGE states it). */
export const VERIFY_TIMEOUT_MS = 15_000;
const SNIPPET_MAX = 300;

export interface PostOpts {
  fetchImpl?: Fetch;                     // DI seam (same as the old jgrep.ts option)
  requestTimeoutMs?: number;             // per attempt, default 30_000
  deadlineMs?: number;                   // absolute epoch ms — batch deadline INCLUDING all retries (compared on the monotonic clock internally)
  maxRetries?: number;                   // default 4 (=> 5 total attempts)
  sleep?: (ms: number) => Promise<void>; // DI for tests
  limiter?: RateLimiter;                 // shared token bucket
  /** The run's --budget meter (TRDD-3KBUODCE): each chain attempt reserves and settles
   *  through it at THIS entry's own price before its request goes out. Priced per
   *  provider, not per run: a free local server (usd_per_mtok 0) reserves nothing, so a
   *  nearly-spent budget falls back to it instead of stopping the run. */
  meter?: BudgetMeterLike;
}

const isOpenRouterHost = (url: string): boolean => {
  let host = "";
  try { host = new URL(url).hostname; } catch { /* not a URL */ }
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
};

/** Auth headers; OpenRouter hosts also get app-attribution headers (upstream #17,
 *  openrouter.ai/docs/app-attribution) — never sent to TypeSafe or a self-hosted gateway.
 *  An empty key (keyless local server) sends no Authorization header at all. */
export const headersFor = (apiKey: string, url: string): Record<string, string> => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (isOpenRouterHost(url)) {
    h["HTTP-Referer"] = "https://github.com/Emasoft/jgrep";
    h["X-OpenRouter-Title"] = "jgrep";
    h["X-Title"] = "jgrep";
    h["X-OpenRouter-Categories"] = "cli-agent";
  }
  return h;
};

/** Every header of one request: the entry's static (non-secret, validated) headers first, so
 *  auth and attribution can never be overridden by them, then the adapter's own. */
const requestHeaders = (backend: Backend, apiKey: string, extra?: Record<string, string>): Record<string, string> =>
  ({ ...backend.headers, ...headersFor(apiKey, backend.url), ...extra });

const detailOf = (err: unknown): string => {
  if (err != null && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; name?: unknown };
    if (typeof e.message === "string" && e.message) return e.message;
    if (typeof e.code === "string" && e.code) return e.code;
    if (typeof e.name === "string" && e.name) return e.name;
  }
  return String(err);
};

/** First finite number among the provider cost fields, if any. */
const firstNumeric = (...vals: unknown[]): number | undefined => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
};

/** The variables (or "the api_key in providers.json") a provider reads its key from, for messages. */
const keyNames = (b: Backend): string => [...new Set(b.apiKey.map((s) => { const n = varName(s); return n ? `$${n}` : "the api_key in providers.json"; }))].join(" / ") || "its api_key";

/** Actionable hint per error kind (plan §1.5); bad_request's depends on the snippet. */
function hintFor(kind: JevErrorKind, backend: Backend, snippet: string): string | undefined {
  switch (kind) {
    case "insufficient_credits": {
      // A self-hosted gateway has no billing page to point at — say so plainly. The switch
      // suggestion names the OTHER hosted provider, never the one already in use.
      const billing = BILLING[backend.name];
      const other = backend.name === "typesafe" ? "openrouter" : "typesafe";
      return billing
        ? `top up credits at ${billing} or switch with --provider ${other} if you have a ${other} key`
        : `insufficient credits on the ${backend.name} provider`;
    }
    case "forbidden":
      return "OpenRouter refused this request (403): usually its moderation flagged this chunk's text, or the key has no access to the model — the other chunks are unaffected";
    case "invalid_api_key": {
      // A literal key is fixed in the file; a variable in the shell. Only a built-in ever had
      // an old key file (~/.config/jgrep/<name>.key, still read as a fallback).
      if (!backend.apiKey.some((s) => varName(s))) return `fix "api_key" on the ${backend.name} entry of ${providersFile()} (or run \`jgrep init\`)`;
      const keyFile = BUILTINS.some((b) => b.name === backend.name) ? `, ${keyFilePath(backend.name === "compatible" ? "gateway" : backend.name)}` : "";
      return `use a ${backend.name} key — check ${keyNames(backend)} (or the api_key in ${providersFile()}${keyFile}), or run \`jgrep init\``;
    }
    case "model_unavailable":
      return "pin an explicit version with --model (e.g. typesafe/jev-1.13) or switch with --provider typesafe";
    case "bad_request":
      return snippet ? "request-shape problem — the snippet above is the provider's response body" : undefined;
    case "rate_limited":
      return "the provider is throttling — pace requests with --rate REQ/SEC";
    case "timeout":
      return "the provider did not answer within the request timeout — raise --request-timeout or --timeout";
    case "server_unreachable":
      return "check the network or the provider's status page";
    case "malformed_response":
      return "the API surface may have changed — pin the version with --model or report this";
    default:
      return undefined; // tls_error carries the certificate message verbatim; circuit_breaker_open never starts here
  }
}

/** Hints for transport failures: TLS carries the certificate message verbatim, timeouts name the flag. */
function transportHint(kind: JevErrorKind, err: unknown): string {
  if (isRedirectError(err)) return "the endpoint answered with a redirect, which jgrep never follows (the request carries your key) — use the final URL";
  if (kind === "tls_error") {
    const m = err != null && typeof err === "object" ? (err as { message?: unknown }).message : undefined;
    return typeof m === "string" && m ? m : "TLS/certificate problem — inspect the certificate chain";
  }
  if (kind === "timeout") return "the provider did not answer within the request timeout";
  return "check the network or the provider's status page";
}

function statusMessage(kind: JevErrorKind, backend: Backend, status: number, snippet: string): string {
  const base = snippet ? `${backend.name} ${status}: ${snippet}` : `${backend.name} ${status}`;
  // Where the key comes from belongs in the message itself — the first thing to check on 401/403.
  return kind === "invalid_api_key" ? `${base} — is ${keyNames(backend)} a ${backend.name} key?` : base;
}

function malformedResponseError(backend: Backend, snippet: string): JevProviderError {
  return new JevProviderError(
    "malformed_response",
    `${backend.name} 200 with unexpected body: ${snippet || "(empty body)"}`,
    { provider: backend.name, status: 200, retryable: false, hint: hintFor("malformed_response", backend, "") },
  );
}

/** The human part of an error body: OpenRouter-style `{"error":{"message":…}}` (or a top-level
 *  `message`) is reduced to that message, so fields such as the account's `user_id` never
 *  reach error output, logs or --json-errors (review m4). Non-JSON bodies pass through. */
export function errorTextOf(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j?.error === "object" ? j.error?.message : typeof j?.error === "string" ? j.error : j?.message;
    if (typeof m === "string" && m) return m;
  } catch { /* not JSON: the raw text is the message */ }
  return body;
}

/** One answer as Jev returns it — noul (probability), choice (label + probabilities) or
 *  score (value + confidence); the fields of the other types are absent. */
export interface JevAnswer { type: string; noul?: number; choice?: string; probabilities?: Record<string, number>; score?: number; confidence?: number | null }

/** A System One request as the core builds it: the chain sets `model` per provider. */
export interface SystemOneBody { model?: string; state?: unknown; questions?: Record<string, unknown> }
export interface PostResult { answers: Record<string, JevAnswer>; usage?: { input_tokens: number }; cost?: number; model?: string }

// ---- adapters ----------------------------------------------------------------------
/** The request and response shape of each adapter kind (jev-agent-tools transports/*.ts).
 *  Only these exist: a JSON file cannot describe an envelope rewrite safely, so providers.json
 *  can name an adapter but never define one. `encode` must not mutate the caller's body. */
const ADAPTERS: Record<Adapter, { encode: (b: SystemOneBody) => { body: unknown; headers?: Record<string, string> }; decode: (j: unknown) => unknown }> = {
  "system-one": { encode: (b) => ({ body: b }), decode: (j) => j },
  // Cloudflare Workers AI: the System One request goes inside "input", and the reply is the v4
  // envelope, nested twice (result.result). success:false, or a run state other than Completed,
  // is an unusable reply even with HTTP 200.
  "cloudflare-ai-run": {
    encode: (b) => ({ body: { model: b.model, input: { state: b.state, questions: b.questions } } }),
    decode: (j) => {
      if (!isObj(j) || j.success === false) throw new Error("Cloudflare reported success: false");
      const outer = j.result as { state?: unknown; result?: unknown } | undefined;
      if (typeof outer?.state === "string" && outer.state !== "Completed") throw new Error(`Cloudflare run state is ${JSON.stringify(outer.state.slice(0, 40))}, not "Completed"`);
      return outer?.result ?? outer;
    },
  },
  // Vercel AI Gateway evaluation model: the model rides in the ai-model-id header, not the body;
  // noul questions are called "boolean" and only type, instructions and criteria are sent. A
  // boolean answer comes back as a probability; a choice or score confidence lives in
  // providerMetadata and may be missing (null); usage is camelCase.
  "vercel-evaluation": {
    encode: (b) => ({
      body: {
        state: b.state,
        questions: Object.fromEntries(Object.entries(b.questions ?? {}).map(([id, q]) => {
          const x = (q ?? {}) as { type?: string; instructions?: unknown; criteria?: unknown };
          return [id, { type: x.type === "noul" ? "boolean" : x.type, instructions: x.instructions, criteria: x.criteria }];
        })),
      },
      headers: { "ai-model-id": b.model ?? "", "ai-gateway-protocol-version": "0.0.1", "ai-gateway-auth-method": "api-key", "ai-evaluation-model-specification-version": "4" },
    }),
    decode: (j) => {
      const r = (isObj(j) ? j : {}) as { answers?: unknown; usage?: { inputTokens?: unknown }; providerMetadata?: { typesafe?: { confidence?: Record<string, unknown> } } };
      const conf = r.providerMetadata?.typesafe?.confidence ?? {};
      const adapt = (id: string, a: unknown): unknown => {
        const x = a as { type?: string; probability?: unknown } | undefined;
        if (x?.type === "boolean") return { type: "noul", noul: x.probability };
        if (x?.type === "choice" || x?.type === "score") return { ...x, confidence: typeof conf[id] === "number" ? conf[id] : null };
        return a;
      };
      const answers = isObj(r.answers) ? Object.fromEntries(Object.entries(r.answers).map(([id, a]) => [id, adapt(id, a)])) : r.answers;
      return { ...r, answers, usage: { input_tokens: r.usage?.inputTokens } };
    },
  },
};

/** POST one System One request with per-attempt timeouts, a batch deadline that
 *  includes retries, Retry-After-aware backoff and typed errors (WI-11), shaped by the
 *  backend's adapter. The caller owns `body` (including `body.model`) — it is never
 *  mutated here. */
export async function postSystemOne(
  body: SystemOneBody,
  backend: Backend,
  apiKey: string,
  opts: PostOpts = {},
): Promise<PostResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const adapter = ADAPTERS[backend.adapter];
  const wire = adapter.encode(body);
  const json = JSON.stringify(wire.body);
  const headers = requestHeaders(backend, apiKey, wire.headers);
  // Upstream text echoed in an error never carries the key that was sent.
  const clean = (s: string): string => redact(s, apiKey);
  // The epoch deadline is converted to a MONOTONIC deadline once, at entry: the wall
  // clock can jump (NTP, manual adjust) but performance.now() cannot — same clock the
  // token bucket runs on. Identical behavior on a normal clock.
  const deadline = opts.deadlineMs === undefined ? undefined : monotonicMs() + (opts.deadlineMs - Date.now());

  for (let attempt = 0; ; attempt++) {
    // Pacing before EVERY attempt, retries included (§1.7). The monotonic deadline rides
    // along: the limiter rejects a waiter whose deadline lapses while queued — without
    // consuming a token — and the pre-attempt check below stays as the backstop.
    await opts.limiter?.acquire(deadline !== undefined ? { deadlineMono: deadline, provider: backend.name } : undefined);

    if (deadline !== undefined && deadline - monotonicMs() <= 0) {
      throw new JevProviderError(
        "timeout",
        `${backend.name} deadline exceeded before attempt ${attempt + 1} (the batch deadline includes retries)`,
        { provider: backend.name, retryable: false, hint: "raise --timeout or --request-timeout (seconds)" },
      );
    }

    const perAttemptMs = deadline === undefined
      ? requestTimeoutMs
      : Math.min(requestTimeoutMs, deadline - monotonicMs());
    // The deadline branch is fractional (monotonic math) and Node throws RangeError on a
    // fractional abort delay — floor to a positive integer (see abortDelayMs).
    const signal = AbortSignal.timeout(abortDelayMs(perAttemptMs));

    // What failed THIS attempt (a retryable status or a retryable transport error).
    let retryStatus: number | undefined;
    let retryKind: JevErrorKind; // both are set on every path that reaches the retry code below
    let retryDetail: string;
    let retryCause: unknown;
    let retryAfterRaw: string | null = null;

    try {
      const res = await fetchImpl(backend.url, {
        method: "POST",
        headers,
        body: json,
        signal,
        redirect: "error", // never follow: a redirect would carry the Authorization header to another server
      });
      if (!res.ok) {
        // Read the body BEFORE classifying so a retry never needs it a second time.
        const snippet = clean(errorTextOf(await res.text())).slice(0, SNIPPET_MAX);
        let cls = classifyStatus(res.status, snippet);
        // OpenRouter's 403 is a moderation flag or a model permission on THIS request, not a
        // bad key (its bad key is 401): non-fatal, so one flagged chunk cannot trip the breaker.
        if (res.status === 403 && isOpenRouterHost(backend.url)) cls = { kind: "forbidden", retryable: false };
        if (!cls.retryable) {
          throw new JevProviderError(cls.kind, statusMessage(cls.kind, backend, res.status, snippet), {
            provider: backend.name, status: res.status, retryable: false, hint: hintFor(cls.kind, backend, snippet),
          });
        }
        retryStatus = res.status;
        retryKind = cls.kind;
        retryDetail = snippet;
        retryAfterRaw = res.headers.get("retry-after");
      } else {
        // Success path: body read + JSON parse INSIDE the abort window (the old code left
        // res.json() outside it). text+parse rather than res.json() so a non-JSON 200 is
        // malformed_response instead of a misclassified transport error.
        const text = await res.text();
        let parsed: unknown;
        try { parsed = adapter.decode(JSON.parse(text)); } catch (e) {
          // An adapter's own refusal (Cloudflare success:false) names itself; a parse error shows the body.
          throw malformedResponseError(backend, e instanceof SyntaxError ? clean(text.slice(0, SNIPPET_MAX)) : clean(detailOf(e)));
        }
        if (parsed === null || typeof parsed !== "object"
          || (parsed as Record<string, unknown>).answers === null
          || typeof (parsed as Record<string, unknown>).answers !== "object") {
          throw malformedResponseError(backend, clean(text.slice(0, SNIPPET_MAX)));
        }
        const p = parsed as { answers: Record<string, JevAnswer>; usage?: unknown; cost?: unknown; cost_usd?: unknown; model?: unknown };
        const usage = p.usage !== null && typeof p.usage === "object" ? (p.usage as { input_tokens: number; cost?: unknown }) : undefined;
        // cost_field: where this provider reports dollars (null: never); unset keeps the old
        // lookup. With no reported cost, the entry's usd_per_mtok prices the request when set.
        const reported = backend.costField === undefined ? firstNumeric(p.cost, usage?.cost, p.cost_usd)
          : backend.costField === null ? undefined : firstNumeric(backend.costField.split(".").reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), p));
        const tokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
        return {
          answers: p.answers,
          usage,
          cost: reported ?? (typeof backend.usdPerMtok === "number" ? (tokens * backend.usdPerMtok) / 1e6 : undefined),
          model: typeof p.model === "string" ? p.model : undefined,
        };
      }
    } catch (err) {
      if (err instanceof JevProviderError) throw err; // fatal status / malformed body: pass through untouched
      const cls = classifyTransport(err);
      if (!cls.retryable) {
        throw new JevProviderError(cls.kind, `${backend.name} ${cls.kind}: ${clean(detailOf(err))}`, {
          provider: backend.name, retryable: false, cause: err, hint: transportHint(cls.kind, err),
        });
      }
      retryKind = cls.kind;
      retryDetail = clean(detailOf(err));
      retryCause = err;
    }

    if (attempt >= maxRetries) { // retries exhausted: final classification, still transient-class
      const label = retryStatus !== undefined ? String(retryStatus) : retryKind;
      throw new JevProviderError(
        retryKind,
        `${backend.name} ${label} after ${attempt + 1} attempts: ${retryDetail}`.trimEnd(),
        {
          provider: backend.name, status: retryStatus, retryable: true, cause: retryCause,
          hint: hintFor(retryKind, backend, retryDetail),
        },
      );
    }

    const delay = jitteredDelayMs(attempt); // full jitter, base 500ms, cap 30s (float — floored below)
    const retryAfterMs = parseRetryAfter(retryAfterRaw); // transport errors have no header -> null
    // A Retry-After the batch deadline cannot outlast: sleeping until the deadline only to
    // report "timeout" hid the real cause (throttling) and its fix (--rate). Say so now.
    if (deadline !== undefined && retryAfterMs !== null && retryAfterMs > deadline - monotonicMs()) {
      throw new JevProviderError(
        retryKind,
        `${backend.name} ${retryStatus ?? retryKind}: the provider asked to wait ${Math.ceil(retryAfterMs / 1000)}s (Retry-After), longer than the batch deadline allows`,
        { provider: backend.name, status: retryStatus, retryable: true, hint: `${hintFor(retryKind, backend, retryDetail) ?? ""} (or raise --timeout)`.trim() },
      );
    }
    let wait = Math.min(Math.max(delay, retryAfterMs ?? 0), RETRY_AFTER_MAX_MS);
    if (deadline !== undefined) wait = Math.min(wait, deadline - monotonicMs());
    // Integer ms only: jitter and the deadline remainder are floats (see abortDelayMs).
    await sleep(Math.max(0, Math.floor(wait)));
  }
}

/** Outcome of a key check (review m2): a valid key on an empty account ("no_credits") is
 *  still a key worth saving, and a check that could not reach the provider ("unverified")
 *  says nothing about the key — only "rejected" means a bad key. */
export interface KeyCheck { status: "ok" | "no_credits" | "rejected" | "unverified"; http: number; model?: string; detail?: string }

/** Key check for `jgrep init` and `jgrep status`. A provider with a free check (`verify`:
 *  OpenRouter /api/v1/key, TypeSafe /v1/models, Cloudflare /user/tokens/verify) gets a GET;
 *  one without is pinged with a one-question request through its adapter (billed — `jgrep
 *  status` never pings). No retries; never throws. `timeoutMs` follows --request-timeout. */
export async function verifyApiKey(
  backend: Backend,
  apiKey: string,
  opts: { fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<KeyCheck> {
  const f = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(abortDelayMs(opts.timeoutMs ?? VERIFY_TIMEOUT_MS)); // integer, like every abort delay
  let res: Response;
  try {
    if (backend.verify) {
      res = await f(backend.verify, { method: "GET", headers: requestHeaders(backend, apiKey), signal, redirect: "error" });
    } else {
      const wire = ADAPTERS[backend.adapter].encode({
        model: backend.model,
        state: "ping",
        questions: { ok: { type: "noul", instructions: "Is the state the word ping?" } },
      });
      // same rule as postSystemOne: the key never follows a redirect
      res = await f(backend.url, { method: "POST", headers: requestHeaders(backend, apiKey, wire.headers), body: JSON.stringify(wire.body), signal, redirect: "error" });
    }
  } catch (e) {
    return { status: "unverified", http: 0, detail: redact(detailOf(e), apiKey) };
  }
  if (res.ok) {
    let model: string | undefined;
    try {
      const parsed = (await res.json()) as { model?: unknown };
      if (parsed !== null && typeof parsed === "object" && typeof parsed.model === "string") model = parsed.model;
    } catch { /* 200 with a non-JSON body: the key check still succeeded */ }
    return { status: "ok", http: res.status, model };
  }
  const detail = redact(errorTextOf(await res.text().catch(() => "")), apiKey).slice(0, SNIPPET_MAX);
  if (res.status === 402) return { status: "no_credits", http: 402, detail };
  if (res.status === 429 || res.status >= 500) return { status: "unverified", http: res.status, detail };
  return { status: "rejected", http: res.status, detail };
}
