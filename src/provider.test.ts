// Issue #7: endpoint/model routing by key (resolveProvider), init's key-type
// detection (varNameFor), and one end-to-end run against a local stub server via
// JGREP_ENDPOINT that never contacts typesafe.ai.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import { ENDPOINT, MODEL, OPENROUTER_ENDPOINT, OPENROUTER_MODEL } from "./jgrep";
import { varNameFor } from "./init";

process.env.JGREP_NO_MAIN = "1";

declare const Bun: {
  spawnSync(cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): {
    stdout: { toString(): string };
  };
  spawn(cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; stdout?: string; stderr?: string }): {
    exited: Promise<number>;
    stdout: ReadableStream; stderr: ReadableStream;
  };
  serve(opts: { port: number; fetch: (req: Request) => Response | Promise<Response> }): { stop(): void; port: number };
  readableStreamToText(s: ReadableStream): Promise<string>;
};

// ---- resolveProvider(): precedence -------------------------------------------
// CONFIG_FILE (~/.config/jgrep/env) is computed once from os.homedir() at import
// time, so an in-process call can't be pointed at an isolated config — and this dev
// machine has a real key there. Each case runs resolveProvider() in a FRESH `bun -e`
// subprocess with its own isolated, empty HOME: the real config is never touched,
// read, or renamed.
const jgrepModule = path.join(import.meta.dir, "jgrep.ts");
function runResolveProvider(env: Record<string, string>): unknown {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-resolve-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  try {
    const script = `import { resolveProvider } from ${JSON.stringify(jgrepModule)};\n`
      + `try { console.log(JSON.stringify(resolveProvider())); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`;
    const res = Bun.spawnSync(["bun", "-e", script], {
      cwd: dir,
      env: { ...process.env, HOME: home, TYPESAFE_API_KEY: "", OPENROUTER_API_KEY: "", JGREP_ENDPOINT: "", ...env },
    });
    return JSON.parse(res.stdout.toString().trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveProvider: TYPESAFE_API_KEY wins when both keys are set", () => {
  expect(runResolveProvider({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "sk-or-key" }))
    .toEqual({ apiKey: "ts-key", endpoint: ENDPOINT, model: MODEL });
});

test("resolveProvider: OPENROUTER_API_KEY alone routes to the OpenRouter endpoint/model", () => {
  expect(runResolveProvider({ OPENROUTER_API_KEY: "sk-or-key" }))
    .toEqual({ apiKey: "sk-or-key", endpoint: OPENROUTER_ENDPOINT, model: OPENROUTER_MODEL });
});

test("resolveProvider: JGREP_ENDPOINT overrides the URL only, keeping the key's model", () => {
  const stub = "http://127.0.0.1:8765";
  expect(runResolveProvider({ TYPESAFE_API_KEY: "ts-key", JGREP_ENDPOINT: stub }))
    .toEqual({ apiKey: "ts-key", endpoint: stub, model: MODEL });
  expect(runResolveProvider({ OPENROUTER_API_KEY: "sk-or-key", JGREP_ENDPOINT: stub }))
    .toEqual({ apiKey: "sk-or-key", endpoint: stub, model: OPENROUTER_MODEL });
});

test("resolveProvider: JGREP_ENDPOINT rejects plain http:// to a non-loopback host", () => {
  expect(runResolveProvider({ TYPESAFE_API_KEY: "ts-key", JGREP_ENDPOINT: "http://example.com" }))
    .toMatchObject({ error: expect.stringContaining("https://") });
});

test("resolveProvider: loopback http:// stubs are allowed, IPv4 and IPv6", () => {
  for (const url of ["http://127.0.0.1:8765", "http://localhost:8765", "http://[::1]:8765"])
    expect(runResolveProvider({ TYPESAFE_API_KEY: "ts-key", JGREP_ENDPOINT: url })).toMatchObject({ endpoint: url });
});

test("resolveProvider: no key -> error mentioning both variables", () => {
  const r = runResolveProvider({}) as { error: string };
  expect(r.error).toMatch(/TYPESAFE_API_KEY/);
  expect(r.error).toMatch(/OPENROUTER_API_KEY/);
});

// ---- init: key-prefix detection ------------------------------------------------

test("varNameFor: sk-or- prefix is OpenRouter, everything else is TypeSafe", () => {
  expect(varNameFor("sk-or-v1-abc123")).toBe("OPENROUTER_API_KEY");
  expect(varNameFor("ts-live-abc123")).toBe("TYPESAFE_API_KEY");
  expect(varNameFor("anything-else")).toBe("TYPESAFE_API_KEY");
});

// ---- end-to-end: JGREP_ENDPOINT hits the stub, never typesafe.ai --------------

const cliPath = path.join(import.meta.dir, "cli.ts");

test("e2e: JGREP_ENDPOINT sends requests to the stub with the OpenRouter key/model, never typesafe.ai", async () => {
  const requests: { auth: string | null; model: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body = await req.json() as { model: unknown };
      requests.push({ auth: req.headers.get("authorization"), model: body.model });
      return Response.json({ answers: Object.fromEntries(Object.keys((body as any).questions ?? {}).map((k) => [k, { type: "noul", noul: 0.9 }])) });
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-stub-"));
  const home = path.join(dir, "home"); // empty HOME: no ~/.config/jgrep/env, no ~/.cache
  fs.mkdirSync(home, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, "probe.ts"), "const answer = 42;\n".repeat(6));
    // spawn (async), not spawnSync: a sync spawn blocks this process's event loop,
    // starving the stub server's own fetch handler (same process, same JS thread).
    const child = Bun.spawn(["bun", cliPath, "--no-cache", "some description", "probe.ts"], {
      cwd: dir,
      env: {
        ...process.env, JGREP_NO_MAIN: "", HOME: home,
        TYPESAFE_API_KEY: "", OPENROUTER_API_KEY: "sk-or-stub-key",
        JGREP_ENDPOINT: `http://127.0.0.1:${server.port}`,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, Bun.readableStreamToText(child.stderr)]);
    expect(stderr).not.toMatch(/error|No API key/i); // the run-summary line on stderr is fine; a fatal error is not
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.auth).toBe("Bearer sk-or-stub-key");
      expect(r.model).toBe(OPENROUTER_MODEL);
    }
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
