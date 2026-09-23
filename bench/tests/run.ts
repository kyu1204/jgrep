#!/usr/bin/env bun
// Benchmark: jgrep --tests predictive test selection against real commit history.
//
// Usage: bun run bench/tests/run.ts <repoPath> <N> [outFile]
//
// For each of the N most recent eligible commits on the repo's default branch:
//   - ground truth G = test files the commit touched
//   - test-file changes are reverted to their pre-commit state so the diff fed to
//     jgrep only contains the non-test change (test files can't trivially self-select)
//   - `jgrep --tests <parent> --all --json --no-cache` is run from the repo root
//   - recall / selection-ratio / cost / tokens / seconds are computed and printed
//     as one JSON line (and appended to outFile if given)
//
// All checkouts/resets/cleans happen inside a scratch `git worktree`, never in the
// caller's repo clone. Runs that error, exit outside {0,1}, or don't parse are
// retried once, then skipped (never written as a row).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JGREP = path.resolve(import.meta.dir, "../../dist/jgrep.js");

function isTestFile(f: string): boolean {
  const base = path.basename(f);
  return (
    /(^|\/)(test|tests|__tests__)\//.test(f) ||
    /\.test\./.test(base) ||
    /\.spec\./.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /.*_test\.py$/.test(base)
  );
}
const NOISE_RE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock)$|\.(md|mdx|rst|txt)$|(^|\/)(\.github|\.circleci)\//;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
}

function defaultBranch(repo: string): string {
  try {
    const ref = git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
    return ref.replace("refs/remotes/", "");
  } catch {
    return "origin/HEAD";
  }
}

function fileExistsAt(cwd: string, ref: string, file: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Candidate { sha: string; }

// Returns up to `limit` eligible commits (may return fewer if history runs out).
// Scans more than N because some candidates get skipped later (empty ground truth
// after excluding added-only test files, or a jgrep run that never becomes valid).
function pickCommits(repo: string, limit: number): Candidate[] {
  const branch = defaultBranch(repo);
  const log = git(repo, ["log", branch, "--no-merges", "--format=%H", "-n", "500"]).trim().split("\n").filter(Boolean);
  const out: Candidate[] = [];
  for (const sha of log) {
    if (out.length >= limit) break;
    let parent: string;
    try {
      parent = git(repo, ["rev-parse", `${sha}~1`]).trim();
    } catch {
      continue; // root commit, no parent
    }
    const names = git(repo, ["diff", "--name-only", parent, sha]).trim().split("\n").filter(Boolean);
    if (!names.length) continue;
    const testFiles = names.filter(isTestFile);
    const sourceFiles = names.filter((f) => !isTestFile(f) && !NOISE_RE.test(f));
    if (!testFiles.length || !sourceFiles.length) continue;
    // at least one test change must map to a real pre-existing source edit (not just new test file)
    const diffSize = Buffer.byteLength(git(repo, ["diff", parent, sha]), "utf8");
    if (diffSize >= 60 * 1024) continue;
    out.push({ sha });
  }
  return out;
}

interface Row {
  repo: string; sha: string; parent: string;
  groundTruthCount: number; groundTruthAddedExcluded: number;
  totalTestFiles: number; selectedCount: number;
  recall: number | null; codeOnlyRecall: number | null; jevAdded: number;
  extra: number; tokens: number; costUsd: number; requests: number; seconds: number;
  groundTruth: string[]; selected: { file: string; p: number; reason: string }[];
  missed: string[];
  errors: number;
}

type AttemptResult =
  | { status: "ok"; row: Row }
  | { status: "empty-ground-truth" }
  | { status: "invalid"; reason: string };

// Runs one commit entirely inside `wtDir` (a scratch worktree). Never touches `repo`.
function attemptOne(wtDir: string, sha: string, repoName: string): AttemptResult {
  git(wtDir, ["checkout", "-q", "--detach", sha]);
  try {
    const parent = git(wtDir, ["rev-parse", `${sha}~1`]).trim();
    const changedNames = git(wtDir, ["diff", "--name-only", parent, sha]).trim().split("\n").filter(Boolean);
    let groundTruth = changedNames.filter(isTestFile).filter((f) => fs.existsSync(path.join(wtDir, f)));
    let addedExcluded = 0;
    for (const f of groundTruth.slice()) {
      if (fileExistsAt(wtDir, parent, f)) {
        git(wtDir, ["checkout", "-q", parent, "--", f]);
      } else {
        // added in this commit: can't be selected against a diff that no longer contains it
        fs.rmSync(path.join(wtDir, f), { force: true });
        groundTruth = groundTruth.filter((g) => g !== f);
        addedExcluded++;
      }
    }
    if (!groundTruth.length) return { status: "empty-ground-truth" };

    const t0 = Date.now();
    const res = spawnSync(
      "node",
      [JGREP, "--tests", parent, "--all", "--json", "--no-cache"],
      { cwd: wtDir, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }
    );
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    const seconds = (Date.now() - t0) / 1000;

    if (res.error) return { status: "invalid", reason: `spawn error: ${res.error.message}` };
    if (res.status !== 0 && res.status !== 1) return { status: "invalid", reason: `exit status ${res.status}` };

    let all: { file: string; p: number; reason: string }[];
    try {
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      all = parsed;
    } catch {
      return { status: "invalid", reason: "stdout did not parse as a JSON array" };
    }

    const erroredMatch = /(\d+) errored/.exec(stderr);
    const errors = erroredMatch ? Number(erroredMatch[1]) : 0;
    if (errors > 0) return { status: "invalid", reason: `${errors} errored batches` };

    const T = all.length;
    if (T === 0) return { status: "invalid", reason: "totalTestFiles is 0" };

    const selected = all.filter((s) => s.p >= 0.5);
    const S = new Set(selected.map((s) => s.file));
    const G = new Set(groundTruth);
    const inter = [...G].filter((g) => S.has(g));
    const recall = G.size ? inter.length / G.size : null;
    const codeOnly = new Set(all.filter((s) => s.reason === "direct" || s.reason === "import").map((s) => s.file));
    const codeOnlyInter = [...G].filter((g) => codeOnly.has(g));
    const codeOnlyRecall = G.size ? codeOnlyInter.length / G.size : null;
    const jevAdded = inter.length - codeOnlyInter.length;
    const extra = [...S].filter((f) => !G.has(f)).length;
    const missed = [...G].filter((g) => !S.has(g));

    const summaryMatch = /· (\d+) requests · (\d+) tokens · \$([\d.]+) ·/.exec(stderr);
    const requests = summaryMatch ? Number(summaryMatch[1]) : 0;
    const tokens = summaryMatch ? Number(summaryMatch[2]) : 0;
    const costUsd = summaryMatch ? Number(summaryMatch[3]) : 0;

    const row: Row = {
      repo: repoName, sha, parent,
      groundTruthCount: G.size, groundTruthAddedExcluded: addedExcluded,
      totalTestFiles: T, selectedCount: selected.length,
      recall, codeOnlyRecall, jevAdded, extra, tokens, costUsd, requests, seconds,
      groundTruth: [...G], selected, missed, errors,
    };
    return { status: "ok", row };
  } finally {
    git(wtDir, ["reset", "-q", "--hard", sha]);
    git(wtDir, ["clean", "-fdq"]);
  }
}

async function main() {
  const [repoArg, nArg, outArg] = process.argv.slice(2);
  if (!repoArg || !nArg) {
    console.error("usage: run.ts <repoPath> <N> [outFile]");
    process.exit(2);
  }
  const repo = path.resolve(repoArg);
  const n = Number(nArg);
  const repoName = path.basename(repo);
  // scan a larger pool than N: some candidates get skipped (empty ground truth,
  // or a run that stays invalid after one retry) and are replaced by the next one
  const pool = pickCommits(repo, Math.max(n * 3, n + 15));

  const out: Row[] = [];
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-bench-"));
  let worktreeAdded = false;
  try {
    for (const { sha } of pool) {
      if (out.length >= n) break;
      if (!worktreeAdded) {
        execFileSync("git", ["worktree", "add", "--detach", wtDir, sha], { cwd: repo, stdio: "pipe" });
        worktreeAdded = true;
      }
      let result = attemptOne(wtDir, sha, repoName);
      if (result.status === "empty-ground-truth") continue;
      if (result.status === "invalid") {
        result = attemptOne(wtDir, sha, repoName); // retry once
      }
      if (result.status === "ok") {
        out.push(result.row);
        console.log(JSON.stringify(result.row));
      } else if (result.status === "invalid") {
        console.log(`skipped ${sha}: ${result.reason}`);
      }
    }
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: repo, stdio: "pipe" });
      } catch {
        try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
        try { execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "pipe" }); } catch {}
      }
    } else {
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
    }
  }

  if (out.length < n) {
    console.error(`warning: only got ${out.length}/${n} rows for ${repoName} (pool exhausted)`);
  }
  if (outArg) {
    fs.mkdirSync(path.dirname(outArg), { recursive: true });
    fs.writeFileSync(outArg, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}

main();
