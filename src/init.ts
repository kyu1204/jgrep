// `jgrep init`: interactive setup. Key -> verify -> where to store -> agent
// skills (opt-in) -> star prompt. Every step is skippable with ctrl-c.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import * as p from "@clack/prompts";
import {
  CONFIG_FILE, ENDPOINT, MODEL, OPENROUTER_ENDPOINT, OPENROUTER_MODEL,
  installSkills, resolveProvider, saveApiKey, verifyApiKey,
} from "./jgrep";

export const REPO_URL = "https://github.com/kyu1204/jgrep";
const CONSOLE_URL = "https://console.typesafe.ai";

/** OpenRouter keys are prefixed `sk-or-`; everything else is treated as a TypeSafe key. */
export const varNameFor = (key: string): "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY" =>
  key.startsWith("sk-or-") ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
const endpointFor = (varName: "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY") =>
  varName === "OPENROUTER_API_KEY" ? { endpoint: OPENROUTER_ENDPOINT, model: OPENROUTER_MODEL } : { endpoint: ENDPOINT, model: MODEL };
const SKILL_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "jgrep", "SKILL.md");

function bail(msg = "Setup cancelled."): never {
  p.cancel(msg);
  process.exit(1);
}
const guard = <T,>(v: T | symbol): T => (p.isCancel(v) ? bail() : (v as T));

function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => { /* best effort; the URL is printed anyway */ });
}

export async function init() {
  p.intro("jgrep init");

  // 1. key
  let existing: string | undefined;
  let existingVar: "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY" | undefined;
  try {
    const p0 = resolveProvider();
    existing = p0.apiKey;
    existingVar = varNameFor(existing);
  } catch { /* none */ }
  if (existing) {
    const keep = guard(await p.confirm({
      message: `A ${existingVar} key is already configured (…${existing.slice(-4)}). Keep it?`,
      initialValue: true,
    }));
    if (!keep) { existing = undefined; existingVar = undefined; }
  }

  let apiKey = existing;
  let varName = existingVar;
  let model: string | undefined;
  while (!apiKey) {
    const typed = guard(await p.password({
      message: `Paste your TypeSafe or OpenRouter API key (${CONSOLE_URL})`,
      validate: (v) => (v?.trim() ? undefined : "The key is required: jgrep cannot run without it."),
    })).trim();
    const v = varNameFor(typed);
    const { endpoint, model: wireModel } = endpointFor(v);
    const s = p.spinner();
    s.start(v === "OPENROUTER_API_KEY" ? "Checking the key against openrouter.ai" : "Checking the key against api.typesafe.ai");
    try {
      const r = await verifyApiKey(typed, fetch, endpoint, wireModel);
      if (r.ok) { s.stop(`Key accepted (${r.model ?? "jev"})`); apiKey = typed; varName = v; model = r.model; }
      else { s.stop(`Rejected with HTTP ${r.status}`, 1); }
    } catch (e) {
      s.stop(`Could not reach the API: ${(e as Error).message}`, 1);
    }
    if (!apiKey) {
      const again = guard(await p.confirm({ message: "Try another key?", initialValue: true }));
      if (!again) bail("No working key; run `jgrep init` again later.");
    }
  }

  // 2. where to store (only when the key is new)
  if (!existing) {
    const where = guard(await p.select({
      message: "Where should the key live?",
      options: [
        { value: "global", label: "~/.config/jgrep/env", hint: "recommended: works in every project" },
        { value: "project", label: "./.env in this directory", hint: "add .env to .gitignore" },
        { value: "none", label: "Don't save", hint: "I'll export the key myself" },
      ],
    }));
    if (where === "global") p.log.success(`Saved to ${saveApiKey(apiKey, varName!)} (mode 600)`);
    else if (where === "project") {
      fs.appendFileSync(".env", `${varName}=${apiKey}\n`);
      p.log.success("Appended to ./.env");
      if (!fs.existsSync(".gitignore") || !fs.readFileSync(".gitignore", "utf8").split("\n").includes(".env")) {
        p.log.warn(".env is not in .gitignore");
      }
    } else p.log.info(`Not saved. Use: export ${varName}=…`);

    // A rejected key can still be live elsewhere (a shell-exported var, or the other
    // var already sitting in ./.env / the global config) and would keep outranking
    // what was just saved — resolveProvider() reads the real precedence, so re-run
    // it and warn rather than silently leaving the new key unused.
    if (where !== "none") {
      try {
        const picked = resolveProvider();
        if (picked.apiKey !== apiKey) {
          p.log.warn(`A different key still takes precedence (TYPESAFE_API_KEY wins over OPENROUTER_API_KEY, and an exported env var wins over saved files) — unset it or remove it from ./.env for ${varName} to take effect.`);
        }
      } catch { /* resolveProvider() only throws with no key at all — nothing to warn about */ }
    }
  }

  // 3. agent skills (opt-in)
  const agents = [
    { value: "claude", label: "Claude Code", hint: "~/.claude/skills/jgrep" },
    { value: "codex", label: "Codex", hint: "~/.codex/skills/jgrep" },
  ].filter((a) => fs.existsSync(path.join(os.homedir(), `.${a.value}`)));
  if (agents.length && fs.existsSync(SKILL_SRC)) {
    const picked = guard(await p.multiselect({
      message: "Teach your coding agents to use jgrep? (space to toggle, enter to continue)",
      options: agents,
      required: false,
    }));
    if (picked.length) {
      for (const dir of installSkills(SKILL_SRC, os.homedir(), picked)) p.log.success(`Skill installed: ${dir}`);
    }
  }

  // 4. star
  const star = guard(await p.confirm({ message: "Enjoying jgrep? Give it a star on GitHub", initialValue: true }));
  if (star) { openUrl(REPO_URL); p.log.info(REPO_URL); }

  p.note(
    [
      `jgrep "catches an error and silently ignores it" src/`,
      `jgrep -C "validates the webhook signature" app/`,
      `jgrep --diff --staged "leaves debug output behind"`,
    ].join("\n"),
    "Try it",
  );
  p.outro(model ? `Ready (${model}). Key: ${existing ? "existing" : CONFIG_FILE}` : "Ready.");
}
