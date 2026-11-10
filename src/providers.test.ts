// providers.json (TRDD-3KBUODCE): the file's array is the fallback chain, $VAR / literal keys,
// "enabled" synonyms, strict validation, the old key stores as fallbacks, the chain's per-run
// circuit breaker and errors.log, and the Cloudflare / Vercel adapters. Every test uses its own
// temp home and cwd; nothing touches the user's ~/.jgrep or ~/.config/jgrep.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect, spyOn } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
declare const process: { env: Record<string, string | undefined>; platform: string };

import {
  BACKENDS, BUILTINS, DEFAULT_PRICE_PER_MTOK, ERROR_LOG_MAX_AGE_MS, ProviderChain, appendErrorLog, buildEntries, configDir,
  errorLogger, errorsLogFile, isoNow, jgrepHome, keyFilePath, legacyEnvFile, loadProviders, parseEnvKeyFile, pickModel,
  postSystemOne, providersFile, readKeyFile, resolveApiKey, resolveChain, resolvePricePerMtok, type Fetch,
} from "./providers";
import { JevProviderError } from "./errors";
import { jgrep, type Chunk } from "./jgrep";

const typesafe = BACKENDS.typesafe, openrouter = BACKENDS.openrouter;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-p-"));
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const errOf = (fn: () => unknown): JevProviderError => {
  try { fn(); } catch (e) { return e as JevProviderError; }
  throw new Error("expected fn to throw");
};
const rejectionOf = async (p: Promise<unknown>): Promise<JevProviderError> => {
  try { await p; } catch (e) { return e as JevProviderError; }
  throw new Error("expected the promise to reject");
};
/** A temp jgrep home holding `providers` as providers.json (mode 0600). */
const homeWith = (providers: unknown[], mode = 0o600): { env: Record<string, string>; home: string; file: string } => {
  const home = tmp();
  const file = path.join(home, "providers.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, providers }), { mode });
  fs.chmodSync(file, mode);
  return { env: { JGREP_HOME: home }, home, file };
};
const names = (env: Record<string, string>, cwd = tmp()) => loadProviders(env, tmp(), cwd).providers.map((p) => `${p.name}:${p.state}`);

interface Call { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }
/** Fake fetch answering by the Authorization header (one script per key). */
const fakeFetch = (byAuth: Record<string, (body: Record<string, unknown>) => Response>) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: Call["init"]) => {
    calls.push({ url: String(url), init });
    const auth = init.headers?.Authorization ?? "";
    const script = byAuth[auth];
    if (!script) throw new Error(`no script for ${auth}`);
    return script(JSON.parse(init.body ?? "{}"));
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** System One answer: every question of the request answered noul p. */
const answerAll = (p: number) => (b: Record<string, unknown>) =>
  json(200, { answers: Object.fromEntries(Object.keys((b.questions ?? {}) as object).map((k) => [k, { type: "noul", noul: p }])), usage: { input_tokens: 10 } });
const chunks = (n: number): Chunk[] => Array.from({ length: n }, (_, i) => ({ file: `f${i}.ts`, start: 1, end: 5, text: `const v${i} = ${i};\n`.repeat(5) }));

// ---- the home and the built-ins --------------------------------------------------------

test("jgrepHome: $JGREP_HOME (absolute) or ~/.jgrep; a relative JGREP_HOME is a config error", () => {
  expect(jgrepHome({}, "/home/u")).toBe(path.join("/home/u", ".jgrep"));
  expect(jgrepHome({ JGREP_HOME: "/tmp/jh" }, "/home/u")).toBe("/tmp/jh");
  expect(providersFile({ JGREP_HOME: "/tmp/jh" })).toBe("/tmp/jh/providers.json");
  expect(errorsLogFile({ JGREP_HOME: "/tmp/jh" })).toBe("/tmp/jh/errors.log");
  const e = errOf(() => jgrepHome({ JGREP_HOME: "rel/dir" }, "/home/u"));
  expect(e.kind).toBe("bad_request");
  expect(e.message).toContain("absolute");
});

test("built-ins: openrouter, typesafe, compatible, cloudflare, vercel, mlx, in that order, with their endpoints and free checks", () => {
  expect(BUILTINS.map((b) => b.name)).toEqual(["openrouter", "typesafe", "compatible", "cloudflare", "vercel", "mlx"]);
  expect(openrouter).toMatchObject({ url: "https://openrouter.ai/api/v1/systemone", model: "~typesafe/jev-latest", verify: "https://openrouter.ai/api/v1/key", apiKey: ["$OPENROUTER_API_KEY"], adapter: "system-one" });
  expect(typesafe).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", verify: "https://api.typesafe.ai/v1/models", apiKey: ["$JEV_API_KEY", "$TYPESAFE_API_KEY"] });
  expect(BACKENDS.compatible).toMatchObject({ url: "", model: "jev-latest", verify: null, apiKey: ["$JEV_GATEWAY_API_KEY"] });
  expect(BACKENDS.cloudflare).toMatchObject({ url: "", model: "typesafe/jev", adapter: "cloudflare-ai-run", verify: "https://api.cloudflare.com/client/v4/user/tokens/verify" });
  expect(BACKENDS.vercel).toMatchObject({ url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", model: "typesafe-ai/jev", adapter: "vercel-evaluation", verify: null });
  expect(DEFAULT_PRICE_PER_MTOK).toBe(0.042);
});

test("no providers.json: the built-in chain, openrouter first; an unset key is a state, not an error", () => {
  expect(names({ JGREP_HOME: tmp() })).toEqual(["openrouter:no-key", "typesafe:no-key", "compatible:no-url", "cloudflare:no-key", "vercel:no-key", "mlx:no-url"]);
  const { providers } = loadProviders({ JGREP_HOME: tmp(), OPENROUTER_API_KEY: "sk-or-1", TYPESAFE_API_KEY: "t", CLOUDFLARE_ACCOUNT_ID: "abc123" }, tmp(), tmp());
  expect(providers.map((p) => p.state)).toEqual(["ready", "ready", "no-url", "no-key", "no-key", "no-url"]);
  expect(providers[0].keySource).toBe("$OPENROUTER_API_KEY");
  expect(providers[1].tried).toEqual(["$JEV_API_KEY", "$TYPESAFE_API_KEY"]);
  expect(providers[3].url).toBe("https://api.cloudflare.com/client/v4/accounts/abc123/ai/run");
});

// ---- the file is the chain -----------------------------------------------------------------

test("the chain is EXACTLY the file's entries, in file order: a built-in the file does not name is never appended", () => {
  const { env } = homeWith([{ name: "typesafe" }, { name: "openrouter" }]);
  expect(names({ ...env, OPENROUTER_API_KEY: "o", TYPESAFE_API_KEY: "t", AI_GATEWAY_API_KEY: "v" })).toEqual(["typesafe:ready", "openrouter:ready"]);
  const { chain } = resolveChain({ env: { ...env, OPENROUTER_API_KEY: "o", TYPESAFE_API_KEY: "t" }, homeDir: tmp(), cwd: tmp(), version: "t" });
  expect(chain.entries.map((e) => e.backend.name)).toEqual(["typesafe", "openrouter"]); // OPENROUTER_API_KEY no longer jumps the queue
});

test("api_key: $VAR, ${VAR}, an array (first set wins) and a literal key", () => {
  const custom = { base_url: "https://jev.example.com", path: "/v1/systemone", adapter: "system-one", model: "m" };
  const { env } = homeWith([
    { name: "one", ...custom, api_key: "${ONE_KEY}" },
    { name: "two", ...custom, api_key: ["$UNSET_TWO", "$TWO_KEY"] },
    { name: "three", ...custom, api_key: "lit-key-3" },
  ]);
  const { providers } = loadProviders({ ...env, ONE_KEY: "k1", TWO_KEY: "k2" }, tmp(), tmp());
  expect(providers.map((p) => [p.key, p.keySource])).toEqual([["k1", "$ONE_KEY"], ["k2", "$TWO_KEY"], ["lit-key-3", "literal in providers.json"]]);
});

test("enabled: true/false and every synonym, any other value is an error naming the provider and the value", () => {
  for (const on of [true, 1, "true", "Enabled", "enable", "1", "YES", "y", "active", "on"]) {
    expect(names({ ...homeWith([{ name: "typesafe", enabled: on }]).env, TYPESAFE_API_KEY: "t" })).toEqual(["typesafe:ready"]);
  }
  for (const off of [false, 0, "false", "DISABLED", "disable", "0", "no", "n", "inactive", "Off"]) {
    expect(names({ ...homeWith([{ name: "typesafe", enabled: off }]).env, TYPESAFE_API_KEY: "t" })).toEqual(["typesafe:disabled"]);
  }
  const e = errOf(() => names(homeWith([{ name: "typesafe", enabled: "maybe" }]).env));
  expect(e.message).toContain('"typesafe"');
  expect(e.message).toContain('"maybe"');
});

test("strict validation: every malformed field exits with an error naming the file and the field", () => {
  const custom = { base_url: "https://jev.example.com", path: "/v1/systemone", adapter: "system-one", api_key: "$C_KEY", model: "m" };
  const cases: [unknown, RegExp][] = [
    [{ version: 2, providers: [] }, /"version" must be 1/],
    [{ version: 1, providers: {} }, /"providers" must be an array/],
    [{ version: 1, providers: [], extra: 1 }, /unknown field "extra"/],
    [{ version: 1, providers: [{ name: "typesafe", colour: "red" }] }, /unknown field "colour"/],
    [{ version: 1, providers: [{ name: "Bad Name" }] }, /"name" must be/],
    [{ version: 1, providers: [{ name: "typesafe" }, { name: "typesafe" }] }, /duplicate name "typesafe"/],
    [{ version: 1, providers: [{ name: "custom", base_url: "https://x.example" }] }, /"path" is required for a provider that is not built in/],
    [{ version: 1, providers: [{ ...custom, name: "custom", base_url: "http://remote.example.com" }] }, /must use https/],
    [{ version: 1, providers: [{ ...custom, name: "custom", base_url: "https://u:p@x.example" }] }, /user name, password, query or fragment/],
    [{ version: 1, providers: [{ ...custom, name: "custom", path: "/v1/{user}" }] }, /no placeholder other than \{account_id\}/],
    [{ version: 1, providers: [{ ...custom, name: "custom", adapter: "soap" }] }, /"adapter" must be one of system-one, cloudflare-ai-run, vercel-evaluation/],
    [{ version: 1, providers: [{ ...custom, name: "custom", api_key: "$bad-name" }] }, /must be \$NAME or/],
    [{ version: 1, providers: [{ ...custom, name: "custom", headers: { "X-Api-Key": "s" } }] }, /looks like a credential/],
    [{ version: 1, providers: [{ name: "typesafe", model: "vendor/model" }] }, /does not match its "model_pattern"/],
    [{ version: 1, providers: [{ ...custom, name: "custom", usd_per_mtok: -1 }] }, /"usd_per_mtok" must be a number >= 0/],
    [{ version: 1, providers: [{ ...custom, name: "aa" }, { ...custom, name: "bb" }] }, /\$C_KEY is used by both "aa" and "bb"/],
  ];
  for (const [doc, re] of cases) expect(() => buildEntries(doc, "/h/providers.json")).toThrow(re);
  // a $VAR shared with a DISABLED provider is fine: only one of them can ever send it
  expect(buildEntries({ version: 1, providers: [{ ...custom, name: "aa" }, { ...custom, name: "bb", enabled: false }] }, "f").length).toBe(2);
});

test("malformed providers.json: the error gives at most a position, never the file's text (it may hold a literal key)", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "providers.json"), '{"version": 1, "providers": [{"name": "typesafe", "api_key": "SECRET-LITERAL-KEY-123"}', { mode: 0o600 });
  const e = errOf(() => loadProviders({ JGREP_HOME: home }, tmp(), tmp()));
  expect(e.message).toContain("is not valid JSON");
  expect(e.message).not.toContain("SECRET");
  expect(e.hint ?? "").not.toContain("SECRET");
});

test("a literal api_key in a file other users can read is refused with the chmod 600 fix; $VAR-only files may be 0644", () => {
  if (process.platform === "win32") return;
  const lit = homeWith([{ name: "typesafe", api_key: "literal-key-123" }], 0o644);
  const e = errOf(() => loadProviders(lit.env, tmp(), tmp()));
  expect(e.message).toContain("literal api_key");
  expect(e.hint).toBe(`run: chmod 600 ${lit.file}`);
  expect(e.message + e.hint).not.toContain("literal-key-123");
  fs.chmodSync(lit.file, 0o600);
  expect(loadProviders(lit.env, tmp(), tmp()).providers[0].state).toBe("ready");
  expect(loadProviders(homeWith([{ name: "typesafe", api_key: "$T" }], 0o644).env, tmp(), tmp()).providers[0].state).toBe("no-key");
});

test("a custom entry on a known provider's host inherits its free key check; another host has none", () => {
  const entry = { path: "/alpha/decisions", adapter: "system-one", api_key: "$ORD_KEY", model: "typesafe/jev-1.13" };
  const p = loadProviders(homeWith([{ name: "or-decisions", base_url: "https://openrouter.ai/api", ...entry }]).env, tmp(), tmp()).providers[0];
  expect(p.verify).toBe("https://openrouter.ai/api/v1/key");
  const q = loadProviders(homeWith([{ name: "elsewhere", base_url: "https://jev.example.com", ...entry }]).env, tmp(), tmp()).providers[0];
  expect(q.verify).toBeNull();
  const r = loadProviders(homeWith([{ name: "or-decisions", base_url: "https://openrouter.ai/api", ...entry, verify: null }]).env, tmp(), tmp()).providers[0];
  expect(r.verify).toBeNull(); // an explicit null is kept
});

// ---- keys: providers.json first, the old stores as fallbacks ----------------------------------

test("key lookup: providers.json ($VAR or literal) > ~/.config/jgrep/<name>.key > legacy env file > ./.env", () => {
  const home = tmp(), cwd = tmp();
  write(path.join(cwd, ".env"), "TYPESAFE_API_KEY=from-dotenv\n");
  write(path.join(cwd, ".gitignore"), ".env\n");
  expect(resolveApiKey(typesafe, {}, home, cwd)).toBe("from-dotenv");
  write(legacyEnvFile(home), "export TYPESAFE_API_KEY=from-legacy\n");
  expect(resolveApiKey(typesafe, {}, home, cwd)).toBe("from-legacy");
  write(keyFilePath("typesafe", home), "from-keyfile\n");
  expect(resolveApiKey(typesafe, {}, home, cwd)).toBe("from-keyfile");
  expect(resolveApiKey(typesafe, { TYPESAFE_API_KEY: "from-env" }, home, cwd)).toBe("from-env");
  expect(resolveApiKey(typesafe, { JEV_API_KEY: "jev-env", TYPESAFE_API_KEY: "from-env" }, home, cwd)).toBe("jev-env"); // array order
  // the compatible provider's old key file is gateway.key (its old name)
  write(keyFilePath("gateway", home), "gw-old\n");
  expect(resolveApiKey({ ...BACKENDS.compatible, url: "https://gw.example.com/v1/systemone" }, {}, home, cwd)).toBe("gw-old");
  // a legacy entry for ANOTHER provider never satisfies this one
  const home2 = tmp();
  write(legacyEnvFile(home2), "OPENROUTER_API_KEY=o\n");
  expect(errOf(() => resolveApiKey(typesafe, {}, home2, tmp())).kind).toBe("invalid_api_key");
});

test("missing key: the error names every place looked in, and how to fix it", () => {
  const home = tmp();
  const e = errOf(() => resolveApiKey(openrouter, {}, home, tmp()));
  expect(e.kind).toBe("invalid_api_key");
  for (const s of ["$OPENROUTER_API_KEY", keyFilePath("openrouter", home), legacyEnvFile(home), "./.env"]) expect(e.message).toContain(s);
  expect(e.hint).toContain("OPENROUTER_API_KEY");
  expect(e.hint).toContain("jgrep init");
});

test("resolveApiKey: yellow warning when the key comes from a .env that .gitignore does not cover", () => {
  const home = tmp();
  const warnCwd = tmp(); write(path.join(warnCwd, ".env"), "TYPESAFE_API_KEY=k1\n"); write(path.join(warnCwd, ".gitignore"), "node_modules\n");
  const safeCwd = tmp(); write(path.join(safeCwd, ".env"), "TYPESAFE_API_KEY=k2\n"); write(path.join(safeCwd, ".gitignore"), "node_modules\n.env\n");
  const noColor = process.env.NO_COLOR;
  const spy = spyOn(console, "error");
  try {
    process.env.NO_COLOR = "1";
    expect(resolveApiKey(typesafe, {}, home, warnCwd)).toBe("k1");
    expect(spy.mock.calls.some((c: unknown[]) => String(c[0]).includes("not gitignored") && !String(c[0]).includes("\x1b["))).toBe(true);
    spy.mockClear();
    expect(resolveApiKey(typesafe, {}, home, safeCwd)).toBe("k2");
    expect(spy.mock.calls.length).toBe(0); // .env ignored -> silent
    expect(resolveApiKey(typesafe, { TYPESAFE_API_KEY: "env" }, home, warnCwd)).toBe("env");
    expect(spy.mock.calls.length).toBe(0); // key from env var -> never warns
  } finally {
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
    spy.mockRestore();
  }
});

test("parseEnvKeyFile: export prefix, quotes, comments, spacing; absent or foreign key -> null", () => {
  const f = (s: string) => parseEnvKeyFile(s, "TYPESAFE_API_KEY");
  expect(f("TYPESAFE_API_KEY=abc123\n")).toBe("abc123");
  expect(f('export TYPESAFE_API_KEY="abc123"\n')).toBe("abc123");
  expect(f("export TYPESAFE_API_KEY='abc123'\n")).toBe("abc123");
  expect(f("TYPESAFE_API_KEY=abc123 # trailing comment\n")).toBe("abc123");
  expect(f("  TYPESAFE_API_KEY = abc123\n")).toBe("abc123");
  expect(f("OTHER_KEY=x\n")).toBe(null);
  expect(f("TYPESAFE_API_KEY_X=prefixed\n")).toBe(null); // key name is not a prefix match
});

test("readKeyFile: first non-empty line; missing or blank -> null; configDir under ~/.config/jgrep", () => {
  const home = tmp();
  expect(configDir(home)).toBe(path.join(home, ".config", "jgrep"));
  expect(readKeyFile(path.join(home, "missing.key"))).toBe(null);
  write(path.join(home, "multi.key"), "\n  \nfirst-key  \nsecond-key\n");
  expect(readKeyFile(path.join(home, "multi.key"))).toBe("first-key");
  write(path.join(home, "blank.key"), "\n \n");
  expect(readKeyFile(path.join(home, "blank.key"))).toBe(null);
});

test("resolvePricePerMtok: default 0.042, JEV_PRICE_PER_MTOK override, invalid -> bad_request", () => {
  expect(resolvePricePerMtok({})).toBe(DEFAULT_PRICE_PER_MTOK);
  expect(resolvePricePerMtok({ JEV_PRICE_PER_MTOK: "0.1" })).toBe(0.1);
  for (const bad of ["abc", "0", "-1", "Infinity"]) expect(errOf(() => resolvePricePerMtok({ JEV_PRICE_PER_MTOK: bad })).kind).toBe("bad_request");
});

test("headersFor: OpenRouter hosts get attribution headers, other backends none; empty key sends no Authorization", async () => {
  const { headersFor } = await import("./providers");
  const h = headersFor("k", openrouter.url);
  expect(h["HTTP-Referer"]).toBe("https://github.com/Emasoft/jgrep");
  expect(h["X-Title"]).toBe("jgrep");
  for (const url of [typesafe.url, "http://127.0.0.1:9999/x", "https://evil.example/openrouter.ai", ""]) {
    expect(Object.keys(headersFor("k", url)).sort()).toEqual(["Authorization", "Content-Type"]);
  }
  expect(headersFor("", "http://127.0.0.1:9999/x")).toEqual({ "Content-Type": "application/json" });
});

// ---- compatible: its endpoint, never from ./.env --------------------------------------------

test("compatible: JEV_GATEWAY_URL (alias JGREP_ENDPOINT) is its full endpoint; https or loopback only; never from ./.env", () => {
  const cwd = tmp();
  const at = (env: Record<string, string>, dir = cwd) => loadProviders({ JGREP_HOME: tmp(), ...env }, tmp(), dir).providers.find((p) => p.name === "compatible")!;
  expect(at({ JGREP_ENDPOINT: "https://b.example/x" }).url).toBe("https://b.example/x");
  expect(at({ JEV_GATEWAY_URL: "https://a.example/x", JGREP_ENDPOINT: "https://b.example/x" }).url).toBe("https://a.example/x");
  expect(() => at({ JEV_GATEWAY_URL: "http://gw.example.com/v1/systemone" })).toThrow(/must use https/);
  for (const u of ["http://127.0.0.1:11434/v1/systemone", "http://[::1]:11434/v1/systemone", "http://localhost:11434/v1/systemone"]) {
    const p = at({ JGREP_ENDPOINT: u });
    expect([p.url, p.state, p.key]).toEqual([u, "ready", ""]); // a local server needs no key
  }
  const evil = tmp();
  write(path.join(evil, ".env"), "JGREP_ENDPOINT=https://attacker.example/x\nJEV_GATEWAY_URL=https://attacker.example/x\nJEV_GATEWAY_API_KEY=gw\n");
  expect(at({}, evil).state).toBe("no-url"); // the URL only from the process env
});
test("mlx: MLX_DECISION_URL is its base URL (a full /v1/systemone works too); no key on loopback, no-url without it", () => {
  const cwd = tmp();
  const mlx = (env: Record<string, string>) => loadProviders({ JGREP_HOME: tmp(), ...env }, tmp(), cwd).providers.find((p) => p.name === "mlx")!;
  // The built-in carries no base_url, so a machine not running the server skips mlx silently
  // ("no-url") instead of pointing at a port it does not have.
  expect(mlx({}).state).toBe("no-url");
  const base = mlx({ MLX_DECISION_URL: "http://127.0.0.1:8123" });
  expect([base.url, base.verify, base.state, base.key, base.model])
    .toEqual(["http://127.0.0.1:8123/v1/systemone", "http://127.0.0.1:8123/health", "ready", "", "elephant-1"]);
  // A trailing slash and a full System One URL both land on the same endpoint, never /v1/systemone/v1/systemone.
  for (const raw of ["http://127.0.0.1:8123/", "http://127.0.0.1:8123/v1/systemone"]) {
    expect(mlx({ MLX_DECISION_URL: raw }).url).toBe("http://127.0.0.1:8123/v1/systemone");
  }
  expect(() => mlx({ MLX_DECISION_URL: "http://mlx.example.com" })).toThrow(/must use https/);
  // providers.json's own base_url wins over the env fallback (the compatible rule): the env
  // var exists so a machine can name its server without writing a file, not to override one.
  const own = homeWith([{ name: "mlx", base_url: "http://127.0.0.1:9001" }]);
  const p = loadProviders({ ...own.env, MLX_DECISION_URL: "http://127.0.0.1:9999" }, tmp(), tmp()).providers[0];
  expect([p.url, p.verify, p.state]).toEqual(["http://127.0.0.1:9001/v1/systemone", "http://127.0.0.1:9001/health", "ready"]);
});

test("under Bun: JGREP_HOME / JEV_API / JEV_GATEWAY_URL / JGREP_ENDPOINT / MLX_DECISION_URL values that also sit in ./.env* are refused", () => {
  const evil = "https://evil.example/v1/systemone";
  for (const [file, name, value] of [[".env", "JEV_GATEWAY_URL", evil], [".env.local", "JGREP_ENDPOINT", evil], [".env", "JEV_API", "compatible"], [".env", "JGREP_HOME", "/tmp/evil-home"], [".env", "MLX_DECISION_URL", "http://127.0.0.1:8000"]]) {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, file), `${name}=${value}\n`);
    const e = errOf(() => loadProviders({ JGREP_HOME: tmp(), [name]: value }, tmp(), cwd));
    expect(e.message).toContain(`./${file}`);
    expect(e.hint).toContain("node");
  }
  // the same value exported in the shell (no matching ./.env) is honoured
  expect(loadProviders({ JGREP_HOME: tmp(), JEV_GATEWAY_URL: evil }, tmp(), tmp()).providers[2].url).toBe(evil);
});

// ---- pinning and models ---------------------------------------------------------------------------

test("--provider / JEV_API pin one provider: unknown and disabled are errors now; a missing key at the first request", async () => {
  const { env } = homeWith([{ name: "openrouter" }, { name: "typesafe", enabled: "off" }]);
  const r = { homeDir: tmp(), cwd: tmp(), version: "t" };
  expect(() => resolveChain({ ...r, env, pin: "nope" })).toThrow(/unknown provider "nope" \(configured: openrouter, typesafe\)/);
  expect(() => resolveChain({ ...r, env, pin: "typesafe" })).toThrow(/"typesafe" is disabled/);
  expect(() => resolveChain({ ...r, env: { ...env, JEV_API: "typesafe" } })).toThrow(/is disabled/);
  const { chain } = resolveChain({ ...r, env, pin: "openrouter" }); // no key: fine until a request is made
  const e = await rejectionOf(chain.post({ state: "x", questions: {} }, {}, 1000));
  expect(e.kind).toBe("invalid_api_key");
  expect(e.message).toContain("$OPENROUTER_API_KEY");
  const none = await rejectionOf(resolveChain({ ...r, env }).chain.post({ state: "x", questions: {} }, {}, 1000));
  expect(none.message).toContain("no provider is ready");
  expect(() => resolveChain({ ...r, env: { JGREP_HOME: tmp() }, pin: "compatible" })).toThrow(/compatible needs its endpoint/);
});

test("pickModel: --model, JEV_MODEL, JGREP_MODEL apply where they fit a provider's ids; else its own model, with a warning", () => {
  expect(pickModel(openrouter, "typesafe/jev-1.13", {})).toEqual({ model: "typesafe/jev-1.13", warning: undefined });
  const ts = pickModel(typesafe, "typesafe/jev-1.13", {});
  expect(ts.model).toBe("jev-latest");
  expect(ts.warning).toContain("--model");
  expect(pickModel(typesafe, undefined, { JEV_MODEL: "x/y", JGREP_MODEL: "jev-1.12" }).model).toBe("jev-1.12");
  expect(pickModel({ ...BACKENDS.compatible, url: "http://localhost/x" }, undefined, { JEV_MODEL: "llama3" }).model).toBe("llama3");
  expect(() => resolveChain({ env: { JGREP_HOME: tmp() }, homeDir: tmp(), cwd: tmp(), version: "t", model: "bad model" })).toThrow(/--model must be a model id/);
});

// ---- the chain: fallback, circuit breaker, errors.log -------------------------------------------

const twoProviders = () => {
  const custom = { base_url: "https://jev.example.com", path: "/v1/systemone", adapter: "system-one" };
  const h = homeWith([{ name: "first", ...custom, api_key: "$FIRST_KEY", model: "m1" }, { name: "second", ...custom, api_key: "$SECOND_KEY", model: "m2" }]);
  const { chain } = resolveChain({ env: { ...h.env, FIRST_KEY: "first-secret-key", SECOND_KEY: "second-secret-key" }, homeDir: tmp(), cwd: tmp(), version: "9.9.9", warn: () => {} });
  return { ...h, chain };
};

test("fallback: a rejected key moves the request to the next provider, which answers under its own model; errors.log gets one masked line", async () => {
  const { chain, home } = twoProviders();
  const { calls, fetchImpl } = fakeFetch({
    "Bearer first-secret-key": () => json(401, { error: { message: "bad key first-secret-key" } }),
    "Bearer second-secret-key": answerAll(0.9),
  });
  const r = await jgrep("q", chunks(1), { threshold: 0.5, batch: 16, concurrency: 1, chain, fetchImpl, cache: {} });
  expect(r.errors).toEqual([]);
  expect(r.hits.length).toBe(1);
  expect(calls.map((c) => [c.init.headers?.Authorization, JSON.parse(c.init.body!).model])).toEqual([["Bearer first-secret-key", "m1"], ["Bearer second-secret-key", "m2"]]);
  expect([...chain.fallbacks]).toEqual([["first → second (invalid_api_key, HTTP 401)", 1]]);
  expect([...chain.used]).toEqual([["second (m2)", 1]]);
  const log = fs.readFileSync(path.join(home, "errors.log"), "utf8");
  expect(log.trim().split("\n").length).toBe(1);
  expect(log).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d jgrep\/9\.9\.9 provider=first model=m1 kind=invalid_api_key status=401 fallback=second msg=/);
  expect(log).not.toContain("first-secret-key");
  expect(log).toContain("***");
  if (process.platform !== "win32") expect(fs.statSync(path.join(home, "errors.log")).mode & 0o777).toBe(0o600);
});

test("fallback answers are cached under the model that produced them", async () => {
  const { chain } = twoProviders();
  const { fetchImpl } = fakeFetch({ "Bearer first-secret-key": () => json(402, "no credits"), "Bearer second-secret-key": answerAll(0.8) });
  const cache: Record<string, unknown> = {};
  await jgrep("q", chunks(1), { threshold: 0.5, batch: 16, concurrency: 1, chain, fetchImpl, cache });
  expect(Object.keys(cache).length).toBe(1);
  // a run asking m2 is served from the cache; a run asking m1 must judge again
  const asking = (model: string) => new ProviderChain([{ backend: typesafe, model, key: () => "k" }]);
  const never = fakeFetch({});
  const m2 = await jgrep("q", chunks(1), { threshold: 0.5, batch: 16, concurrency: 1, chain: asking("m2"), fetchImpl: never.fetchImpl, cache });
  expect([m2.cached, never.calls.length]).toEqual([1, 0]);
  const again = fakeFetch({ "Bearer k": answerAll(0.1) });
  const m1 = await jgrep("q", chunks(1), { threshold: 0.5, batch: 16, concurrency: 1, chain: asking("m1"), fetchImpl: again.fetchImpl, cache });
  expect([m1.cached, again.calls.length]).toEqual([0, 1]);
});

test("a re-run of the same chain serves the fallback's cached answers: a dead first key does not re-bill every run", async () => {
  const cache: Record<string, unknown> = {};
  const run1 = twoProviders();
  await jgrep("q", chunks(3), { threshold: 0.5, batch: 1, concurrency: 1, chain: run1.chain, cache,
    fetchImpl: fakeFetch({ "Bearer first-secret-key": () => json(401, "dead"), "Bearer second-secret-key": answerAll(0.8) }).fetchImpl });
  const never = fakeFetch({});
  const r = await jgrep("q", chunks(3), { threshold: 0.5, batch: 1, concurrency: 1, chain: twoProviders().chain, cache, fetchImpl: never.fetchImpl });
  expect([r.cached, never.calls.length, r.hits.length]).toEqual([3, 0, 3]);
});

test("circuit breaker: 12 parallel batches and a rejected first provider make exactly ONE request to it", async () => {
  const { chain } = twoProviders();
  const { calls, fetchImpl } = fakeFetch({ "Bearer first-secret-key": () => json(401, "nope"), "Bearer second-secret-key": answerAll(0.9) });
  const r = await jgrep("q", chunks(12), { threshold: 0.5, batch: 1, concurrency: 12, chain, fetchImpl, cache: {} });
  expect(r.errors).toEqual([]);
  expect(calls.filter((c) => c.init.headers?.Authorization === "Bearer first-secret-key").length).toBe(1);
  expect(calls.length).toBe(13);
  expect(chain.dead.has("first")).toBe(true);
});

test("a request-shape error (400) never falls back; it is logged with fallback=no", async () => {
  const { chain, home } = twoProviders();
  const { calls, fetchImpl } = fakeFetch({ "Bearer first-secret-key": () => json(400, "bad question"), "Bearer second-secret-key": answerAll(0.9) });
  const r = await jgrep("q", chunks(1), { threshold: 0.5, batch: 16, concurrency: 1, chain, fetchImpl, cache: {} });
  expect(r.errors.map((e) => e.kind)).toEqual(["bad_request"]);
  expect(calls.length).toBe(1);
  expect(fs.readFileSync(path.join(home, "errors.log"), "utf8")).toContain("fallback=no");
});

test("OpenRouter's per-request 403 (moderation) falls back for that request only: the provider stays in the chain", async () => {
  const h = homeWith([{ name: "openrouter" }, { name: "typesafe" }]);
  const { chain } = resolveChain({ env: { ...h.env, OPENROUTER_API_KEY: "sk-or-key-123", TYPESAFE_API_KEY: "ts-key-12345" }, homeDir: tmp(), cwd: tmp(), version: "t" });
  let n = 0;
  const { calls, fetchImpl } = fakeFetch({ "Bearer sk-or-key-123": (b) => (n++ === 0 ? json(403, "flagged") : answerAll(0.9)(b)), "Bearer ts-key-12345": answerAll(0.7) });
  await jgrep("q", chunks(2), { threshold: 0.5, batch: 1, concurrency: 1, chain, fetchImpl, cache: {} });
  expect(chain.dead.size).toBe(0);
  expect(calls.map((c) => c.init.headers?.Authorization)).toEqual(["Bearer sk-or-key-123", "Bearer ts-key-12345", "Bearer sk-or-key-123"]);
});

test("a pinned provider never falls back", async () => {
  const h = homeWith([{ name: "openrouter" }, { name: "typesafe" }]);
  const { chain } = resolveChain({ env: { ...h.env, OPENROUTER_API_KEY: "sk-or-key-123", TYPESAFE_API_KEY: "ts-key-12345" }, homeDir: tmp(), cwd: tmp(), version: "t", pin: "openrouter" });
  const { calls, fetchImpl } = fakeFetch({ "Bearer sk-or-key-123": () => json(401, "nope"), "Bearer ts-key-12345": answerAll(0.7) });
  const r = await jgrep("q", chunks(1), { threshold: 0.5, batch: 16, concurrency: 1, chain, fetchImpl, cache: {} });
  expect(r.errors.map((e) => e.kind)).toEqual(["invalid_api_key"]);
  expect(calls.length).toBe(1);
});

test("every provider failing: one error listing each failure; a key failure among them is the reported kind", async () => {
  const { chain } = twoProviders();
  const { fetchImpl } = fakeFetch({ "Bearer first-secret-key": () => json(401, "nope"), "Bearer second-secret-key": () => json(404, "no such model") });
  const r = await jgrep("q", chunks(1), { threshold: 0.5, batch: 16, concurrency: 1, chain, fetchImpl, cache: {} });
  expect(r.errors.length).toBe(1);
  expect(r.errors[0].kind).toBe("invalid_api_key");
  expect(r.errors[0].message).toContain("every provider failed (first: invalid_api_key 401; second: model_unavailable 404)");
  expect(r.errors[0].hint).toContain("errors.log");
});

test("errors.log: entries older than 72 hours are dropped on every write", () => {
  const dir = tmp(), file = path.join(dir, "errors.log");
  const now = Date.parse("2026-10-02T12:00:00Z");
  const old = `${isoNow(new Date(now - ERROR_LOG_MAX_AGE_MS - 60_000))} jgrep/x provider=a kind=old\n`;
  const recent = `${isoNow(new Date(now - ERROR_LOG_MAX_AGE_MS + 60_000))} jgrep/x provider=a kind=recent\n`;
  fs.writeFileSync(file, old + recent);
  appendErrorLog(file, `${isoNow(new Date(now))} jgrep/x provider=a kind=new\n`, now);
  expect(fs.readFileSync(file, "utf8")).toBe(recent + `${isoNow(new Date(now))} jgrep/x provider=a kind=new\n`);
});

test("errors.log: a write that fails warns once on stderr and never breaks the run", () => {
  const warnings: string[] = [];
  const log = errorLogger("/dev/null/cannot/errors.log", "t", (m) => warnings.push(m));
  const entry = { backend: typesafe, model: "m", key: () => "k" };
  const e = new JevProviderError("invalid_api_key", "x", { provider: "typesafe", retryable: false });
  log(e, entry, "none-left");
  log(e, entry, "none-left");
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("could not write");
});

// ---- adapters ------------------------------------------------------------------------------------

test("cloudflare-ai-run: the request is wrapped in input, the account id is in the URL, and the v4 envelope is unwrapped", async () => {
  const p = loadProviders({ JGREP_HOME: tmp(), CLOUDFLARE_API_TOKEN: "cf-token-123", CLOUDFLARE_ACCOUNT_ID: "0123abcd" }, tmp(), tmp()).providers.find((x) => x.name === "cloudflare")!;
  expect(p.state).toBe("ready");
  const { calls, fetchImpl } = fakeFetch({
    "Bearer cf-token-123": () => json(200, { success: true, result: { state: "Completed", result: { answers: { c0: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 7 }, model: "typesafe/jev" } } }),
  });
  const r = await postSystemOne({ model: "typesafe/jev", state: "s", questions: { c0: { type: "noul", instructions: "i" } } }, p, p.key, { fetchImpl });
  expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/0123abcd/ai/run");
  expect(JSON.parse(calls[0].init.body!)).toEqual({ model: "typesafe/jev", input: { state: "s", questions: { c0: { type: "noul", instructions: "i" } } } });
  expect(r.answers.c0.noul).toBe(0.8);
  expect(r.usage?.input_tokens).toBe(7);
  expect(r.cost).toBeUndefined(); // cost_field null, no usd_per_mtok: priced by JEV_PRICE_PER_MTOK in the meter
  for (const bad of [{ success: false, errors: [] }, { success: true, result: { state: "Running", result: {} } }]) {
    const e = await rejectionOf(postSystemOne({ model: "typesafe/jev", state: "s", questions: {} }, p, p.key, { fetchImpl: fakeFetch({ "Bearer cf-token-123": () => json(200, bad) }).fetchImpl }));
    expect(e.kind).toBe("malformed_response");
  }
  // without the account id it is skipped silently; the state names the variable
  const q = loadProviders({ JGREP_HOME: tmp(), CLOUDFLARE_API_TOKEN: "t" }, tmp(), tmp()).providers.find((x) => x.name === "cloudflare")!;
  expect([q.state, q.acctTried]).toEqual(["no-account", ["$CLOUDFLARE_ACCOUNT_ID"]]);
  expect(() => loadProviders({ JGREP_HOME: tmp(), CLOUDFLARE_ACCOUNT_ID: "../evil" }, tmp(), tmp())).toThrow(/1-64 letters or digits/);
});

test("vercel-evaluation: the model rides in ai-model-id, noul goes as boolean, answers come back as noul with metadata confidence", async () => {
  const v = BACKENDS.vercel;
  const { calls, fetchImpl } = fakeFetch({
    "Bearer vk-12345678": () => json(200, {
      answers: { a: { type: "boolean", probability: 0.75 }, b: { type: "choice", choice: "x", probabilities: { x: 0.6, y: 0.4 } }, c: { type: "score", score: 0.3 } },
      providerMetadata: { typesafe: { confidence: { b: 0.9 } } }, usage: { inputTokens: 42 },
    }),
  });
  const body = { model: "typesafe-ai/jev", state: "s", questions: { a: { type: "noul", instructions: "ia", extra: 1 }, b: { type: "choice", instructions: "ib", criteria: { x: "X", y: "Y" } }, c: { type: "score", instructions: "ic" } } };
  const r = await postSystemOne(body, v, "vk-12345678", { fetchImpl });
  const sent = JSON.parse(calls[0].init.body!);
  expect(sent.model).toBeUndefined();
  expect(sent.questions).toEqual({ a: { type: "boolean", instructions: "ia" }, b: { type: "choice", instructions: "ib", criteria: { x: "X", y: "Y" } }, c: { type: "score", instructions: "ic" } });
  expect(calls[0].init.headers).toMatchObject({ "ai-model-id": "typesafe-ai/jev", "ai-gateway-protocol-version": "0.0.1", "ai-gateway-auth-method": "api-key", "ai-evaluation-model-specification-version": "4", Authorization: "Bearer vk-12345678" });
  expect(r.answers.a).toEqual({ type: "noul", noul: 0.75 });
  expect(r.answers.b.confidence).toBe(0.9);
  expect(r.answers.c.confidence).toBeNull(); // missing metadata: null, never a crash
  expect(r.usage?.input_tokens).toBe(42);
  expect(body.model).toBe("typesafe-ai/jev"); // the caller's body is never mutated
});

test("cost: cost_field reads the reported dollars; usd_per_mtok prices a provider that reports none", async () => {
  const base = { ...BACKENDS.compatible, url: "https://jev.example.com/v1/systemone" };
  const reply = () => json(200, { answers: {}, usage: { input_tokens: 1_000_000 }, billing: { usd: 0.5 }, cost: 9 });
  expect((await postSystemOne({}, { ...base, costField: "billing.usd" }, "k", { fetchImpl: fakeFetch({ "Bearer k": reply }).fetchImpl })).cost).toBe(0.5);
  expect((await postSystemOne({}, base, "k", { fetchImpl: fakeFetch({ "Bearer k": reply }).fetchImpl })).cost).toBe(9); // unset: the old lookup
  expect((await postSystemOne({}, { ...base, costField: null, usdPerMtok: 0.25 }, "k", { fetchImpl: fakeFetch({ "Bearer k": reply }).fetchImpl })).cost).toBe(0.25);
});

test("providers.example.json: valid, openrouter first, typesafe second, every jev-mcp provider, keys only as $VAR", async () => {
  const doc = JSON.parse(fs.readFileSync(path.join((import.meta as { dir: string }).dir, "..", "providers.example.json"), "utf8"));
  const entries = buildEntries(doc, "providers.example.json");
  expect(entries.map((e) => e.name)).toEqual(["openrouter", "typesafe", "compatible", "cloudflare", "vercel", "local"]);
  for (const e of doc.providers) for (const k of [e.api_key].flat()) expect(String(k).startsWith("$")).toBe(true);
  expect(entries.filter((e) => e.enabled).map((e) => e.name)).toEqual(["openrouter", "typesafe", "cloudflare", "vercel"]);
});

test("e2e: a loopback JGREP_ENDPOINT with JGREP_MODEL runs with no key at all (local System One servers)", async () => {
  const requests: { auth: string | null; model: unknown }[] = [];
  // @ts-expect-error — Bun global; no bun-types in this repo
  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body = await req.json() as { model: unknown; questions?: Record<string, unknown> };
      requests.push({ auth: req.headers.get("authorization"), model: body.model });
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions ?? {}).map((k) => [k, { type: "noul", noul: 0.9 }])) });
    },
  });
  const dir = tmp();
  const home = path.join(dir, "home"); // empty HOME: no key files, no ~/.jgrep
  fs.mkdirSync(home, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, "probe.ts"), "const answer = 42;\n".repeat(6));
    // spawn (async), not spawnSync: a sync spawn would starve the in-process stub server.
    // @ts-expect-error — Bun global; no bun-types in this repo
    const child = Bun.spawn(["bun", path.join((import.meta as { dir: string }).dir, "cli.ts"), "--no-cache", "some description", "probe.ts"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: home, JGREP_ENDPOINT: `http://127.0.0.1:${server.port}/v1/systemone`, JGREP_MODEL: "nimble" },
      stdout: "pipe", stderr: "pipe",
    });
    // @ts-expect-error — Bun global; no bun-types in this repo
    const [code, stderr] = await Promise.all([child.exited, Bun.readableStreamToText(child.stderr)]);
    expect(stderr).not.toMatch(/error|API key/i);
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) { expect(r.model).toBe("nimble"); expect(r.auth).toBeNull(); }
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("envIsGitignored: asks git (patterns like *.env count), falls back to ./.gitignore outside a repo", async () => {
  const { envIsGitignored } = await import("./providers");
  const { execFileSync } = await import("node:child_process");
  const repo = tmp();
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  write(path.join(repo, ".gitignore"), "*.env\n");
  expect(envIsGitignored(repo)).toBe(true);
  write(path.join(repo, ".gitignore"), "node_modules\n");
  expect(envIsGitignored(repo)).toBe(false);
  const plain = tmp();
  expect(envIsGitignored(plain)).toBeUndefined();
  write(path.join(plain, ".gitignore"), ".env\n");
  expect(envIsGitignored(plain)).toBe(true);
});

test("ProviderChain.single path (library callers): one backend, lazy key, never logs or falls back", async () => {
  const chain = new ProviderChain([{ backend: typesafe, model: "jev-latest", key: () => "k" }]);
  const e = await rejectionOf(chain.post({ state: "s", questions: {} }, { fetchImpl: fakeFetch({ "Bearer k": () => json(401, "x") }).fetchImpl }, 1000));
  expect(e.kind).toBe("invalid_api_key");
  expect(chain.dead.size).toBe(0);
});
