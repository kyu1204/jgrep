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
import { execSync, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
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

function sh(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
}

function defaultBranch(repo: string): string {
  try {
    const ref = sh(repo, "git symbolic-ref refs/remotes/origin/HEAD").trim();
    return ref.replace("refs/remotes/", "");
  } catch {
    return "origin/HEAD";
  }
}

function fileExistsAt(repo: string, ref: string, file: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Candidate { sha: string; }

function pickCommits(repo: string, n: number): Candidate[] {
  const branch = defaultBranch(repo);
  const log = sh(repo, `git log ${branch} --no-merges --format=%H -n 500`).trim().split("\n").filter(Boolean);
  const out: Candidate[] = [];
  for (const sha of log) {
    if (out.length >= n) break;
    let parent: string;
    try {
      parent = sh(repo, `git rev-parse ${sha}~1`).trim();
    } catch {
      continue; // root commit, no parent
    }
    const names = sh(repo, `git diff --name-only ${parent} ${sha}`).trim().split("\n").filter(Boolean);
    if (!names.length) continue;
    const testFiles = names.filter(isTestFile);
    const sourceFiles = names.filter((f) => !isTestFile(f) && !NOISE_RE.test(f));
    if (!testFiles.length || !sourceFiles.length) continue;
    // at least one test change must map to a real pre-existing source edit (not just new test file)
    const diffSize = Buffer.byteLength(sh(repo, `git diff ${parent} ${sha}`), "utf8");
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

function runOne(repo: string, sha: string): Row | null {
  sh(repo, `git checkout -q ${sha}`);
  const parent = sh(repo, `git rev-parse ${sha}~1`).trim();
  const changedNames = sh(repo, `git diff --name-only ${parent} ${sha}`).trim().split("\n").filter(Boolean);
  let groundTruth = changedNames.filter(isTestFile).filter((f) => fs.existsSync(path.join(repo, f)));
  let addedExcluded = 0;
  for (const f of groundTruth.slice()) {
    if (fileExistsAt(repo, parent, f)) {
      sh(repo, `git checkout -q ${parent} -- ${JSON.stringify(f)}`);
    } else {
      // added in this commit: can't be selected against a diff that no longer contains it
      fs.rmSync(path.join(repo, f), { force: true });
      groundTruth = groundTruth.filter((g) => g !== f);
      addedExcluded++;
    }
  }
  if (!groundTruth.length) {
    sh(repo, `git reset -q --hard ${sha}`);
    sh(repo, "git clean -fdq");
    return null;
  }

  const t0 = Date.now();
  const res = spawnSync(
    "node",
    [JGREP, "--tests", parent, "--all", "--json", "--no-cache"],
    { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }
  );
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const seconds = (Date.now() - t0) / 1000;

  let all: { file: string; p: number; reason: string }[] = [];
  try { all = JSON.parse(stdout); } catch { all = []; }
  const T = all.length;
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
  const erroredMatch = /(\d+) errored/.exec(stderr);
  const errors = erroredMatch ? Number(erroredMatch[1]) : 0;

  sh(repo, `git reset -q --hard ${sha}`);
  sh(repo, "git clean -fdq");

  return {
    repo: path.basename(repo), sha, parent,
    groundTruthCount: G.size, groundTruthAddedExcluded: addedExcluded,
    totalTestFiles: T, selectedCount: selected.length,
    recall, codeOnlyRecall, jevAdded, extra, tokens, costUsd, requests, seconds,
    groundTruth: [...G], selected, missed, errors,
  };
}

async function main() {
  const [repoArg, nArg, outArg] = process.argv.slice(2);
  if (!repoArg || !nArg) {
    console.error("usage: run.ts <repoPath> <N> [outFile]");
    process.exit(2);
  }
  const repo = path.resolve(repoArg);
  const n = Number(nArg);
  const origBranch = sh(repo, "git rev-parse --abbrev-ref HEAD").trim();
  const commits = pickCommits(repo, n);
  const out: Row[] = [];
  for (const { sha } of commits) {
    const row = runOne(repo, sha);
    if (!row) continue;
    out.push(row);
    console.log(JSON.stringify(row));
  }
  sh(repo, `git checkout -q ${origBranch === "HEAD" ? "-" : origBranch}`);
  if (outArg) {
    fs.mkdirSync(path.dirname(outArg), { recursive: true });
    fs.writeFileSync(outArg, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}

main();
