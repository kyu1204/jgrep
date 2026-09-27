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
import { CONFIG_FILE, ENDPOINT, MODEL, OPENROUTER_ENDPOINT, OPENROUTER_MODEL, resolveProvider } from "./jgrep";
import { varNameFor } from "./init";

process.env.JGREP_NO_MAIN = "1";

/** resolveProvider() falls back to the real ~/.config/jgrep/env for whichever var is
 *  missing from the passed env object — same as resolveApiKey always did. This dev
 *  machine has a real TYPESAFE_API_KEY there, which would otherwise leak into these
 *  in-process unit tests (a spawned child process gets a fresh CONFIG_FILE from its
 *  own HOME and needs none of this). Blank CONFIG_FILE reads for the call only. */
function withoutConfigFile<T>(fn: () => T): T {
  const parked = CONFIG_FILE + ".provider-test-parked";
  const existed = fs.existsSync(CONFIG_FILE);
  if (existed) fs.renameSync(CONFIG_FILE, parked);
  try { return fn(); } finally { if (existed) fs.renameSync(parked, CONFIG_FILE); }
}

declare const Bun: {
  spawn(cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; stdout?: string; stderr?: string }): {
    exited: Promise<number>;
    stdout: ReadableStream; stderr: ReadableStream;
  };
  serve(opts: { port: number; fetch: (req: Request) => Response | Promise<Response> }): { stop(): void; port: number };
  readableStreamToText(s: ReadableStream): Promise<string>;
};

// ---- resolveProvider(): precedence -------------------------------------------

test("resolveProvider: TYPESAFE_API_KEY wins when both keys are set", () => {
  const env = { TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "sk-or-key" };
  expect(resolveProvider(env as any)).toEqual({ apiKey: "ts-key", endpoint: ENDPOINT, model: MODEL });
});

test("resolveProvider: OPENROUTER_API_KEY alone routes to the OpenRouter endpoint/model", () => {
  const env = { OPENROUTER_API_KEY: "sk-or-key" };
  withoutConfigFile(() =>
    expect(resolveProvider(env as any)).toEqual({ apiKey: "sk-or-key", endpoint: OPENROUTER_ENDPOINT, model: OPENROUTER_MODEL }));
});

test("resolveProvider: JGREP_ENDPOINT overrides the URL only, keeping the key's model", () => {
  const stub = "http://127.0.0.1:8765";
  expect(resolveProvider({ TYPESAFE_API_KEY: "ts-key", JGREP_ENDPOINT: stub } as any))
    .toEqual({ apiKey: "ts-key", endpoint: stub, model: MODEL });
  withoutConfigFile(() =>
    expect(resolveProvider({ OPENROUTER_API_KEY: "sk-or-key", JGREP_ENDPOINT: stub } as any))
      .toEqual({ apiKey: "sk-or-key", endpoint: stub, model: OPENROUTER_MODEL }));
});

test("resolveProvider: no key -> error mentioning both variables", () => {
  withoutConfigFile(() => {
    expect(() => resolveProvider({} as any)).toThrow(/TYPESAFE_API_KEY/);
    expect(() => resolveProvider({} as any)).toThrow(/OPENROUTER_API_KEY/);
  });
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
