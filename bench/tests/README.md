# Benchmark: `jgrep --tests` on five OSS repos

Date: 2026-09-23. jgrep 0.4.0, model `jev-latest` (the model field the request
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
   reason. If G is empty after this step the commit is skipped.
3. `node dist/jgrep.js --tests C~1 --all --json --no-cache` runs from the
   repo root. Selected S = entries with `p >= 0.5` (jgrep's default
   threshold for `--tests`).
4. recall = |G ∩ S| / |G|; code-only recall = |G ∩ {reason in direct,
   import}| / |G| (recall achievable without asking Jev at all); jev-added
   = ground-truth tests only Jev's scoring caught; extra = |S \ G|, tests
   jgrep selected that the commit's author didn't touch (not necessarily
   wrong, since a test can be affected without being edited).
5. Working tree resets with `git reset --hard C && git clean -fdq` before
   the next commit.

zod and fastify each had one candidate commit where G became empty after
step 2 (the only test-file change was a newly added file), so those two
repos ran 11 commits instead of 12.

Raw rows: `bench/tests/results/<repo>.jsonl`. Script: `bench/tests/run.ts`
(`bun run bench/tests/run.ts <repoPath> <N> [outFile]`).

## Results

### hono

| commit | \|G\| | T | \|S\| | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 6cadf75 | 1 | 139 | 9 | 1.00 | 1.00 | 0 | 8 | 64155 | $0.0027 | 1.13 |
| de310ac | 1 | 139 | 12 | 1.00 | 1.00 | 0 | 11 | 60015 | $0.0025 | 1.27 |
| 28e8572 | 1 | 139 | 10 | 1.00 | 1.00 | 0 | 9 | 59727 | $0.0025 | 1.17 |
| 0d86899 | 1 | 139 | 10 | 1.00 | 1.00 | 0 | 9 | 60204 | $0.0025 | 1.13 |
| 52febbc | 1 | 139 | 7 | 1.00 | 1.00 | 0 | 6 | 59272 | $0.0025 | 1.07 |
| f950277 | 1 | 139 | 49 | 1.00 | 1.00 | 0 | 48 | 37745 | $0.0016 | 1.08 |
| 00ee875 | 1 | 139 | 12 | 1.00 | 1.00 | 0 | 11 | 59395 | $0.0025 | 1.17 |
| f5a5346 | 1 | 139 | 3 | 1.00 | 1.00 | 0 | 2 | 63466 | $0.0027 | 1.14 |
| cb5bea3 | 1 | 139 | 19 | 1.00 | 0.00 | 1 | 18 | 53349 | $0.0022 | 1.06 |
| e8c8c21 | 1 | 139 | 17 | 1.00 | 1.00 | 0 | 16 | 65123 | $0.0027 | 1.27 |
| edd138e | 1 | 139 | 14 | 1.00 | 1.00 | 0 | 13 | 61277 | $0.0026 | 1.06 |
| 9b4e9c2 | 1 | 139 | 4 | 1.00 | 1.00 | 0 | 3 | 62009 | $0.0026 | 1.10 |

### zod

| commit | \|G\| | T | \|S\| | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| cc4cd4e | 5 | 204 | 30 | 0.80 | 0.00 | 4 | 26 | 97112 | $0.0041 | 1.15 |
| ca0229a | 5 | 204 | 100 | 1.00 | 0.00 | 5 | 95 | 97063 | $0.0041 | 1.13 |
| 56222cd | 1 | 204 | 26 | 1.00 | 0.00 | 1 | 25 | 59458 | $0.0025 | 1.07 |
| d6bc1e3 | 5 | 204 | 30 | 0.60 | 0.00 | 3 | 27 | 97090 | $0.0041 | 1.13 |
| ad32d75 | 9 | 204 | 48 | 0.89 | 0.22 | 6 | 40 | 81002 | $0.0034 | 1.09 |
| 413cce9 | 5 | 204 | 65 | 1.00 | 0.00 | 5 | 60 | 68565 | $0.0029 | 1.17 |
| 9446b5c | 2 | 204 | 46 | 1.00 | 0.00 | 2 | 44 | 66459 | $0.0028 | 1.22 |
| b12aa52 | 1 | 204 | 16 | 1.00 | 0.00 | 1 | 15 | 64797 | $0.0027 | 1.08 |
| dd9c36f | 2 | 204 | 26 | 0.50 | 0.00 | 1 | 25 | 59262 | $0.0025 | 1.08 |
| 574d480 | 1 | 204 | 3 | 1.00 | 1.00 | 0 | 2 | 59066 | $0.0025 | 1.20 |
| c532d76 | 1 | 204 | 1 | 1.00 | 1.00 | 0 | 0 | 58988 | $0.0025 | 1.13 |

### fastify

| commit | \|G\| | T | \|S\| | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 4a3e325 | 1 | 234 | 20 | 1.00 | 1.00 | 0 | 19 | 66552 | $0.0028 | 1.21 |
| 13d61c5 | 1 | 234 | 32 | 1.00 | 0.00 | 1 | 31 | 63610 | $0.0027 | 1.14 |
| d266f83 | 1 | 234 | 25 | 1.00 | 1.00 | 0 | 24 | 68361 | $0.0029 | 1.08 |
| d1dd890 | 1 | 233 | 31 | 1.00 | 0.00 | 1 | 30 | 68206 | $0.0029 | 1.10 |
| a34c3e5 | 1 | 233 | 22 | 1.00 | 0.00 | 1 | 21 | 67909 | $0.0029 | 1.10 |
| d66ebd1 | 2 | 233 | 9 | 1.00 | 0.00 | 2 | 7 | 72452 | $0.0030 | 1.14 |
| 0c170ca | 1 | 233 | 37 | 1.00 | 0.00 | 1 | 36 | 78083 | $0.0033 | 1.19 |
| 3aa8dfd | 1 | 233 | 18 | 1.00 | 0.00 | 1 | 17 | 74715 | $0.0031 | 1.09 |
| 4176096 | 1 | 233 | 10 | 1.00 | 0.00 | 1 | 9 | 68618 | $0.0029 | 1.14 |
| af079bd | 2 | 232 | 22 | 0.50 | 0.50 | 0 | 21 | 62538 | $0.0026 | 1.09 |
| 6e95cb9 | 1 | 232 | 51 | 1.00 | 0.00 | 1 | 50 | 66256 | $0.0028 | 1.11 |

### flask

| commit | \|G\| | T | \|S\| | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 8999295 | 1 | 69 | 2 | 1.00 | 0.00 | 1 | 1 | 13276 | $0.0006 | 0.98 |
| 7203fea | 1 | 53 | 2 | 0.00 | 0.00 | 0 | 2 | 9762 | $0.0004 | 15.47 |
| de8429f | 1 | 49 | 5 | 1.00 | 1.00 | 0 | 4 | 8371 | $0.0004 | 15.52 |
| 06ea505 | 1 | 69 | 1 | 1.00 | 0.00 | 1 | 0 | 13372 | $0.0006 | 1.08 |
| fbb6f0b | 5 | 69 | 8 | 1.00 | 0.20 | 4 | 3 | 16761 | $0.0007 | 0.98 |
| c17f379 | 1 | 69 | 12 | 1.00 | 0.00 | 1 | 11 | 17778 | $0.0007 | 1.08 |
| e82db2c | 4 | 69 | 7 | 0.50 | 0.00 | 2 | 5 | 13555 | $0.0006 | 1.03 |
| 5e621a2 | 1 | 69 | 5 | 1.00 | 0.00 | 1 | 4 | 12761 | $0.0005 | 1.02 |
| 6a64969 | 2 | 69 | 26 | 1.00 | 0.00 | 2 | 24 | 18503 | $0.0008 | 1.07 |
| daf1510 | 2 | 69 | 5 | 1.00 | 1.00 | 0 | 3 | 17501 | $0.0007 | 1.01 |
| 9822a03 | 1 | 69 | 3 | 1.00 | 1.00 | 0 | 2 | 14696 | $0.0006 | 0.98 |
| 53b8f08 | 1 | 69 | 9 | 1.00 | 1.00 | 0 | 8 | 12717 | $0.0005 | 1.07 |

### requests

| commit | \|G\| | T | \|S\| | recall | code-only recall | jev-added | extra | tokens | $ cost | s |
|---|---|---|---|---|---|---|---|---|---|---|
| 6f66281 | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 7506 | $0.0003 | 0.86 |
| 6f205ff | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 6684 | $0.0003 | 0.88 |
| 6404f34 | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 6786 | $0.0003 | 0.95 |
| a4f9a59 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6004 | $0.0003 | 0.84 |
| fd62809 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6486 | $0.0003 | 0.95 |
| 27e0981 | 1 | 40 | 1 | 0.00 | 0.00 | 0 | 1 | 6456 | $0.0003 | 0.91 |
| ef439eb | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 6584 | $0.0003 | 0.94 |
| f0198e6 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6240 | $0.0003 | 0.91 |
| bc7dd0f | 1 | 40 | 2 | 1.00 | 0.00 | 1 | 1 | 7046 | $0.0003 | 0.87 |
| 4791422 | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 5814 | $0.0002 | 0.98 |
| f8bec2f | 3 | 40 | 8 | 0.33 | 0.00 | 1 | 7 | 10090 | $0.0004 | 0.98 |
| 5b4b64c | 1 | 40 | 2 | 1.00 | 1.00 | 0 | 1 | 6056 | $0.0003 | 0.94 |

### Summary across repos

| repo | n | mean recall | mean code-only recall | mean selection ratio | total cost | mean seconds |
|---|---|---|---|---|---|---|
| hono | 12 | 1.000 | 0.917 | 0.100 | $0.0296 | 1.14 |
| zod | 11 | 0.890 | 0.202 | 0.174 | $0.0341 | 1.13 |
| fastify | 11 | 0.955 | 0.227 | 0.108 | $0.0319 | 1.13 |
| flask | 12 | 0.875 | 0.350 | 0.106 | $0.0071 | 3.44 |
| requests | 12 | 0.861 | 0.417 | 0.060 | $0.0036 | 0.92 |
| **all** | 58 | 0.916 | 0.430 | 0.109 | $0.1063 | 1.57 |

## Commits with recall < 1

- **fastify `af079bd`** — missed `test/types/fastify.tst.ts`. The source
  change was `fastify.d.ts` (stem `fastify`) and `lib/request.js`. jgrep's
  direct/import matching strips only `.test.`/`.spec.` suffixes and a
  trailing extension when computing a test's stem, so `fastify.tst.ts`
  stems to `fastify.tst`, not `fastify`, and never lines up with the
  changed `fastify.d.ts`. Jev scored it below the 0.5 threshold too.
- **flask `7203fea`** — missed `tests/test_basic.py`. Source change was in
  `src/flask/app.py` (IPv6 server name parsing); `test_basic.py` is a
  general-purpose test file whose name doesn't stem-match `app.py`, and
  Jev scored it below threshold.
- **flask `e82db2c`** — missed `tests/test_blueprints.py`,
  `tests/test_cli.py`. Source change was in `src/flask/sansio/app.py`
  (`provide_automatic_options`); neither missed test file name-matches
  `app.py`, and Jev scored both below threshold.
- **requests `27e0981`** — missed `tests/test_requests.py`. The commit is a
  one-line typo fix in `src/requests/adapters.py` plus a matching one-line
  test fix; `test_requests.py` is the library's broad general test file, not
  stem-matched to `adapters.py`, and Jev scored it below threshold.
- **requests `f8bec2f`** — missed `tests/test_lowlevel.py`,
  `tests/test_testserver.py`. This commit is a lint-tooling migration
  (ruff) touching many files with reformatting-only changes; neither
  missed file stem-matches a changed source file, and Jev scored both
  below threshold.
- **zod `cc4cd4e`**, **`d6bc1e3`**, **`ad32d75`**, **`dd9c36f`** — missed
  `packages/zod/src/v4/classic/tests/assignability.test.ts`,
  `packages/treeshake/bundle-size.test.ts`, and
  `packages/zod/src/v4/classic/tests/recursive-types.test.ts` across these
  commits. All three are broad, whole-library test files (type
  assignability checks, a bundle-size budget, generic recursive-type
  tests) whose names don't stem-match any single changed source file, so
  they depend entirely on Jev's per-file judgment, which scored them below
  the 0.5 threshold in these diffs.

## Notes

- Total cost across all 58 runs: $0.1063, well under the $1 budget; no
  single commit run came close to the 300k-token cap (max observed was
  ~97k tokens, on zod).
- "extra" counts are not false positives: a test can be legitimately
  affected by a change without the commit's author having touched it.
