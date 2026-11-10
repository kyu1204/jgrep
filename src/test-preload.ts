// Test preload (bunfig.toml [test] preload): hermetic provider state for every `bun test`
// run (TRDD-3KBUODCE). The run gets its own empty jgrep home, so no test reads or writes
// the user's real ~/.jgrep (providers.json, cache.json, errors.log) — the tests that spawn
// the CLI with `...process.env` inherit it. The provider variables are cleared unless a
// live test was asked for (JGREP_E2E_LIVE=1): with providers.json, a key exported in the
// developer's shell would otherwise put a REAL provider first in a spawned CLI's chain,
// sending repo code and spending credits from a test.
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import path from "node:path";

declare const process: { env: Record<string, string | undefined> };

process.env.JGREP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-test-home-"));
if (process.env.JGREP_E2E_LIVE !== "1") {
  for (const k of [
    "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY", "JEV_GATEWAY_API_KEY", "JEV_CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY", "JEV_API", "JEV_GATEWAY_URL", "JGREP_ENDPOINT",
    "JEV_MODEL", "JGREP_MODEL", "MLX_DECISION_URL", "MLX_DECISION_API_KEY",
  ]) delete process.env[k];
}
