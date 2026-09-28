# Benchmark: `jgrep --tests` on five OSS repos

Date: 2026-09-23 (re-run 2026-09-28 with jgrep 0.5.0 plus the package-root rule, same 60 commits). jgrep 0.4.0 for the original run, model `jev-latest` (the model field the request
sends; the JSON/`--all` output does not echo back the provider's response
model, so this is the only model identifier visible from the CLI).

## Method

For each repo, the 12 most recent commits on the default branch were picked
that: are not merges, touch at least one non-test source file, touch at
least one test file, and have a total diff under 60 KB (see `pickCommits`
in `run.ts` for the exact filter, an approximation of jgrep's own
`TEST_FILE_RE`).

For each picked commit C:

1. Ground truth G = the test files C modified or added, restricted to
   files that still exist at C.
2. Test files in G are reverted to their `C~1` state before scoring (added
   test files are deleted instead, and dropped from G, since a file that
   doesn't exist in the diff can never be selected). This stops a commit's
   own test-file edits from trivially self-selecting via the `direct`
   reason. If G is empty after this step the commit is dropped and the
   next eligible commit from the repo's history takes its place.
3. `node dist/jgrep.js --tests C~1 --all --json --no-cache` runs from the
   repo root. Selected S = entries with `p >= 0.5` (jgrep's default
   threshold for `--tests`).
4. recall = |G ∩ S| / |G|; code-only recall = |G ∩ {reason in direct,
   import, package}| / |G| (recall achievable without asking Jev at all); jev-added
   = ground-truth tests only Jev's scoring caught; extra = |S \ G|, tests
   jgrep selected that the commit's author didn't touch (not necessarily
   wrong, since a test can be affected without being edited).
5. Working tree resets with `git reset --hard C && git clean -fdq` before
   the next commit.

All of the above (checkout, revert, jgrep run, reset, clean) happens in a
scratch `git worktree`, never in the caller's repo clone. A run that errors,
exits outside {0, 1}, doesn't parse as JSON, or reports errored batches is
retried once and then dropped in favor of the next eligible commit; its row
is never written.

Raw rows: `bench/tests/results/<repo>.jsonl`. Script: `bench/tests/run.ts`
(`bun run bench/tests/run.ts <repoPath> <N> [outFile]`).

## Changes after review

Three fixes went into the script since the first run:

- Every git call that takes a repo-derived string (sha, branch, path) now
  passes it as an argv element (`execFileSync("git", [...])`), never
  interpolated into a shell command string.
- A row is only written when the jgrep run's exit status is 0 or 1, stdout
  parses as a JSON array, and the stderr summary reports zero errored
  batches. A failing run is retried once, then the commit is skipped and
  the next eligible commit is used instead.
- All git operations for a commit (checkout, test-file revert, reset,
  clean) run inside a scratch `git worktree` set up for the run and removed
  in a `finally` block, so the caller's repo clone is never touched.

The two rows that carried jgrep errors in the first run (flask `7203fea`,
`de8429f`) came from those shell-escaping and dirty-tree bugs, not from
jgrep itself: both now complete cleanly (0 errored batches). `de8429f` now
scores recall 1; `7203fea` still misses `tests/test_basic.py` for the same
reason as before (see below), which is a genuine gap in jgrep's selection,
not a benchmark artifact.

## Results

Columns: `edited` = test files the commit's author changed (\|G\|), `tests` = all test files in the repo (T), `selected` = test files jgrep picked (\|S\|), `extra` = selected but not edited.

### hono

| commit | edited | tests | selected | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 6cadf75 | 1 | 139 | 9 | 1.00 | 1.00 | 0 | 8 | 64155 | $0.0027 | 0.64 |
| de310ac | 1 | 139 | 12 | 1.00 | 1.00 | 0 | 11 | 60015 | $0.0025 | 0.58 |
| 28e8572 | 1 | 139 | 10 | 1.00 | 1.00 | 0 | 9 | 59727 | $0.0025 | 0.58 |
| 0d86899 | 1 | 139 | 10 | 1.00 | 1.00 | 0 | 9 | 60204 | $0.0025 | 0.59 |
| 52febbc | 1 | 139 | 7 | 1.00 | 1.00 | 0 | 6 | 59272 | $0.0025 | 0.62 |
| f950277 | 1 | 139 | 61 | 1.00 | 1.00 | 0 | 60 | 33519 | $0.0014 | 0.83 |
| 00ee875 | 1 | 139 | 11 | 1.00 | 1.00 | 0 | 10 | 59395 | $0.0025 | 0.56 |
| f5a5346 | 1 | 139 | 3 | 1.00 | 1.00 | 0 | 2 | 63466 | $0.0027 | 0.59 |
| cb5bea3 | 1 | 139 | 19 | 1.00 | 0.00 | 1 | 18 | 53349 | $0.0022 | 0.57 |
| e8c8c21 | 1 | 139 | 17 | 1.00 | 1.00 | 0 | 16 | 65123 | $0.0027 | 0.62 |
| edd138e | 1 | 139 | 11 | 1.00 | 1.00 | 0 | 10 | 61277 | $0.0026 | 0.57 |
| 9b4e9c2 | 1 | 139 | 4 | 1.00 | 1.00 | 0 | 3 | 62009 | $0.0026 | 0.59 |

### zod

| commit | edited | tests | selected | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| cc4cd4e | 5 | 204 | 29 | 0.60 | 0.00 | 3 | 26 | 97112 | $0.0041 | 0.65 |
| ca0229a | 5 | 204 | 102 | 1.00 | 0.00 | 5 | 97 | 97063 | $0.0041 | 0.60 |
| 56222cd | 1 | 204 | 25 | 1.00 | 0.00 | 1 | 24 | 59458 | $0.0025 | 0.98 |
| d6bc1e3 | 5 | 204 | 28 | 0.60 | 0.00 | 3 | 25 | 97090 | $0.0041 | 0.65 |
| ad32d75 | 9 | 204 | 49 | 0.89 | 0.22 | 6 | 41 | 81002 | $0.0034 | 0.63 |
| 413cce9 | 5 | 204 | 64 | 1.00 | 0.00 | 5 | 59 | 68565 | $0.0029 | 0.59 |
| 9446b5c | 2 | 204 | 44 | 1.00 | 0.00 | 2 | 42 | 66459 | $0.0028 | 0.55 |
| b12aa52 | 1 | 204 | 15 | 1.00 | 0.00 | 1 | 14 | 64797 | $0.0027 | 0.66 |
| dd9c36f | 2 | 204 | 26 | 0.50 | 0.00 | 1 | 25 | 59262 | $0.0025 | 0.55 |
| 574d480 | 1 | 204 | 3 | 1.00 | 1.00 | 0 | 2 | 59066 | $0.0025 | 0.62 |
| c532d76 | 1 | 204 | 1 | 1.00 | 1.00 | 0 | 0 | 58988 | $0.0025 | 0.88 |
| 213ee75 | 1 | 203 | 78 | 1.00 | 1.00 | 0 | 77 | 64062 | $0.0027 | 0.57 |

### fastify

| commit | edited | tests | selected | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 4a3e325 | 1 | 234 | 20 | 1.00 | 1.00 | 0 | 19 | 66552 | $0.0028 | 0.67 |
| 13d61c5 | 1 | 234 | 31 | 1.00 | 0.00 | 1 | 30 | 63610 | $0.0027 | 0.69 |
| d266f83 | 1 | 234 | 26 | 1.00 | 1.00 | 0 | 25 | 68361 | $0.0029 | 0.62 |
| d1dd890 | 1 | 233 | 33 | 1.00 | 0.00 | 1 | 32 | 68058 | $0.0029 | 0.68 |
| a34c3e5 | 1 | 233 | 21 | 1.00 | 0.00 | 1 | 20 | 67909 | $0.0029 | 0.88 |
| d66ebd1 | 2 | 233 | 10 | 1.00 | 0.00 | 2 | 8 | 72452 | $0.0030 | 0.57 |
| 0c170ca | 1 | 233 | 39 | 1.00 | 0.00 | 1 | 38 | 77872 | $0.0033 | 0.62 |
| 3aa8dfd | 1 | 233 | 17 | 1.00 | 0.00 | 1 | 16 | 74715 | $0.0031 | 0.58 |
| 4176096 | 1 | 233 | 8 | 1.00 | 0.00 | 1 | 7 | 68618 | $0.0029 | 0.91 |
| af079bd | 2 | 232 | 22 | 0.50 | 0.50 | 0 | 21 | 62538 | $0.0026 | 0.58 |
| 6e95cb9 | 1 | 232 | 49 | 1.00 | 0.00 | 1 | 48 | 66045 | $0.0028 | 0.74 |
| f5ef344 | 1 | 232 | 68 | 1.00 | 0.00 | 1 | 67 | 51598 | $0.0022 | 0.55 |

### flask

| commit | edited | tests | selected | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 8999295 | 1 | 69 | 2 | 1.00 | 0.00 | 1 | 1 | 13276 | $0.0006 | 0.47 |
| 7203fea | 1 | 69 | 3 | 0.00 | 0.00 | 0 | 3 | 13420 | $0.0006 | 0.47 |
| de8429f | 1 | 69 | 6 | 1.00 | 1.00 | 0 | 5 | 12364 | $0.0005 | 0.54 |
| 06ea505 | 1 | 69 | 2 | 1.00 | 0.00 | 1 | 1 | 13372 | $0.0006 | 0.48 |
| fbb6f0b | 5 | 69 | 8 | 1.00 | 0.20 | 4 | 3 | 16761 | $0.0007 | 0.54 |
| c17f379 | 1 | 69 | 12 | 1.00 | 0.00 | 1 | 11 | 17778 | $0.0007 | 0.67 |
| e82db2c | 4 | 69 | 7 | 0.50 | 0.00 | 2 | 5 | 13555 | $0.0006 | 0.50 |
| 5e621a2 | 1 | 69 | 6 | 1.00 | 0.00 | 1 | 5 | 12761 | $0.0005 | 0.50 |
| 6a64969 | 2 | 69 | 27 | 1.00 | 0.00 | 2 | 25 | 18503 | $0.0008 | 0.51 |
| daf1510 | 2 | 69 | 6 | 1.00 | 1.00 | 0 | 4 | 17501 | $0.0007 | 0.49 |
| 9822a03 | 1 | 69 | 3 | 1.00 | 1.00 | 0 | 2 | 14696 | $0.0006 | 0.48 |
| 53b8f08 | 1 | 69 | 9 | 1.00 | 1.00 | 0 | 8 | 12717 | $0.0005 | 0.54 |

### requests

| commit | edited | tests | selected | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 6f66281 | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 7506 | $0.0003 | 0.47 |
| 6f205ff | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 6684 | $0.0003 | 0.50 |
| 6404f34 | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 6786 | $0.0003 | 0.46 |
| a4f9a59 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6004 | $0.0003 | 0.46 |
| fd62809 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6486 | $0.0003 | 0.47 |
| 27e0981 | 1 | 40 | 1 | 0.00 | 0.00 | 0 | 1 | 6456 | $0.0003 | 0.47 |
| ef439eb | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 6584 | $0.0003 | 0.50 |
| f0198e6 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6240 | $0.0003 | 0.65 |
| bc7dd0f | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 7046 | $0.0003 | 0.52 |
| 4791422 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 5814 | $0.0002 | 0.54 |
| f8bec2f | 3 | 40 | 11 | 1.00 | 1.00 | 0 | 8 | 6808 | $0.0003 | 0.54 |
| 5b4b64c | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6056 | $0.0003 | 0.52 |

### Summary across repos

| repo | n | mean recall | mean code-only recall | mean selection ratio | total cost | mean seconds |
|---|---|---|---|---|---|---|
| hono | 12 | 1.000 | 0.917 | 0.104 | $0.0294 | 0.61 |
| zod | 12 | 0.882 | 0.269 | 0.190 | $0.0368 | 0.66 |
| fastify | 12 | 0.958 | 0.208 | 0.123 | $0.0341 | 0.67 |
| flask | 12 | 0.875 | 0.350 | 0.110 | $0.0074 | 0.52 |
| requests | 12 | 0.917 | 0.500 | 0.067 | $0.0035 | 0.51 |
| **all** | 60 | 0.926 | 0.449 | 0.119 | $0.1112 | 0.59 |

## Package-root rule (2026-09-28)

`--tests` also selects (reason `package`, no Jev call) every test whose imports
reference the package root (`from "zod"`, `"../src"`, `import flask`) when the
diff changes that package's entry file (`src/index.*` next to a `package.json`,
or `__init__.py`). Before/after on the same 60 commits:

| | before | after |
|---|---|---|
| mean recall | 0.919 | 0.926 |
| mean code-only recall | 0.432 | 0.449 |
| mean selection ratio | 0.116 | 0.119 |
| total cost | $0.1115 | $0.1112 |

The gain is requests `f8bec2f` (recall 0.33 to 1.00, code-only 0.00 to 1.00: its diff touches
`requests/__init__.py`, so all three tests are now selected in code, no Jev). On hono `f950277` the rule added 12 extra selections. zod's mean moved 0.899 to 0.882 with no package hit on
that repo: the change is Jev's own variance between runs (same commits, same
prompts). A wider variant that also counts modules the entry re-exports lifted
recall to 0.946 (flask 0.875 to 1.000) but raised the selection ratio to 0.208
(flask 0.109 to 0.390, since nearly every flask test imports `flask`), so it
was rejected. The flask and zod misses below remain because they change deep
modules (`sansio/app.py`, `core/*`), not the entry file.

## Commits with recall < 1

- **flask `7203fea`** — missed `tests/test_basic.py`. Source change was in
  `src/flask/app.py` (IPv6 server name parsing); `test_basic.py` is a
  general-purpose test file whose name doesn't stem-match `app.py`, and
  Jev scored it below the 0.5 threshold.
- **flask `e82db2c`** — missed `tests/test_blueprints.py`,
  `tests/test_cli.py`. Source change was in `src/flask/sansio/app.py`
  (`provide_automatic_options`); neither missed test file name-matches
  `app.py`, and Jev scored both below threshold.
- **fastify `af079bd`** — missed `test/types/fastify.tst.ts`. The source
  change was `fastify.d.ts` (stem `fastify`) and `lib/request.js`. jgrep's
  direct/import matching strips only `.test.`/`.spec.` suffixes and a
  trailing extension when computing a test's stem, so `fastify.tst.ts`
  stems to `fastify.tst`, not `fastify`, and never lines up with the
  changed `fastify.d.ts`. Jev scored it below the 0.5 threshold too.
- **requests `27e0981`** — missed `tests/test_requests.py`. The commit is a
  one-line typo fix in `src/requests/adapters.py` plus a matching one-line
  test fix; `test_requests.py` is the library's broad general test file, not
  stem-matched to `adapters.py`, and Jev scored it below threshold.
- **zod `cc4cd4e`**, **`d6bc1e3`**, **`ad32d75`**, **`dd9c36f`** — missed
  `packages/zod/src/v4/classic/tests/assignability.test.ts`,
  `packages/zod/src/v4/classic/tests/to-json-schema.test.ts`,
  `packages/treeshake/bundle-size.test.ts`, and
  `packages/zod/src/v4/classic/tests/recursive-types.test.ts` across these
  commits. All are broad, whole-library test files (type assignability
  checks, JSON schema round-trips, a bundle-size budget, generic
  recursive-type tests) whose names don't stem-match any single changed
  source file, so they depend entirely on Jev's per-file judgment, which
  scored them below the 0.5 threshold in these diffs.

## Notes

- Total cost across all 60 runs: $0.1112 ($0.1115 before the package-root rule), well under the $1 budget; no
  single commit run came close to the 300k-token cap (max observed was
  ~97k tokens, on zod).
- "extra" counts are not false positives: a test can be legitimately
  affected by a change without the commit's author having touched it.
- No commit needed the rule-2 retry-and-skip path in this run: every
  candidate's first attempt already met the validity checks (exit 0/1,
  parses as JSON, zero errored batches).
