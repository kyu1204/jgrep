<div align="center">

# jgrep

**grep for what code *does*, not what it's called.**

```
jgrep "catches an error and silently ignores it" src/
```

[![npm](https://img.shields.io/npm/v/jevgrep?color=0a0&label=npm)](https://www.npmjs.com/package/jevgrep)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)
[![model](https://img.shields.io/badge/powered%20by-Jev%20%C2%B7%20TypeSafe-8a2be2)](https://docs.typesafe.ai)

*No index. No embeddings. No LLM round-trips. A whole `src/` tree in ~2 s for about a cent.*

<img src="docs/demo.gif" alt="jgrep demo: semantic search over src/ and a git diff" width="900">

</div>

---

## Why

| you want to find…                          | `grep` / `rg` | embeddings | an LLM | **jgrep** |
| ------------------------------------------ | :-----------: | :--------: | :----: | :-------: |
| an exact name or string                    | ✅ instant     | meh        | 🐢 $$  | use grep  |
| "code that swallows errors"                | ❌             | ❌ fuzzy    | ✅ slow | ✅ **2 s** |
| "endpoint with no auth check" *in my diff* | ❌             | ❌          | ✅ $$   | ✅ **¢**   |
| needs an index / vector DB                 | no            | yes        | no     | **no**    |

jgrep runs on [Jev](https://docs.typesafe.ai), a *System One* model: it never
generates text, it answers typed yes/no questions with calibrated
probabilities, in parallel, at $0.042 per million input tokens with output free.
jgrep packs 16 code chunks and 16 questions into one request and turns the
probabilities into `file:line` hits.

## Install

```bash
npm i -g jevgrep     # installs the `jgrep` command
jgrep init           # paste your TypeSafe key, pick where to keep it, done
```

`jgrep init` verifies the key against the API, stores it with `chmod 600`,
and optionally teaches Claude Code / Codex to use jgrep. Get a key at
[console.typesafe.ai](https://console.typesafe.ai).

<details>
<summary>Prefer not to run init?</summary>

```bash
export TYPESAFE_API_KEY=...                                   # env
echo 'TYPESAFE_API_KEY=...' >> .env                           # per project
mkdir -p ~/.config/jgrep && echo 'TYPESAFE_API_KEY=...' > ~/.config/jgrep/env   # global
```
</details>

## Use

### Find code by behavior

```bash
jgrep "reads user input without validating it" app/
jgrep -C "parses a JWT or decodes a base64 token payload" src/     # -C prints the chunk
jgrep -t 0.9 "builds an SQL string by concatenation" .            # stricter
jgrep -a -t 0 "is dead code nothing calls" lib/ | head            # everything, best first
```

### Lint a change with rules written in English

```bash
jgrep --diff --staged "leaves debug output such as console.log"
jgrep --diff origin/main "adds an HTTP endpoint that has no auth check"
jgrep --diff origin/main "changes billing logic without touching a test"
```

Exit status is grep's: `0` matched, `1` nothing matched, `2` jgrep could not run
(bad key, API down, malformed response). In CI keep the three apart: a plain `!`
would turn an outage or an expired secret into a passing check.

```yaml
- run: npm i -g jevgrep
- name: no unauthenticated endpoints
  env: { TYPESAFE_API_KEY: "${{ secrets.TYPESAFE_API_KEY }}" }
  run: |
    set +e
    jgrep --diff "origin/${{ github.base_ref }}" "adds an HTTP endpoint that has no auth check"
    case $? in
      0) echo "::error::jgrep found a match"; exit 1 ;;
      1) ;;                                          # clean
      *) echo "::error::jgrep failed to run";  exit 1 ;;
    esac
```

### Run only the tests a change can affect

```bash
jgrep --tests origin/main | xargs bun test        # or vitest / pytest / go test
jgrep --tests --staged -a                         # every test file with its probability
```

Three layers, cheapest first: tests named after a changed file (`foo.ts` → `foo.test.ts`)
and tests that import a changed module are selected in code; the rest are asked of Jev
with the compacted diff (source files only, changed lines only) and each test file's
imports and test names, one Noul per file. Default threshold is 0.5 here because a
missed test costs more than an extra one. Run the full suite afterwards; this is for the
fast first signal.

Measured on a 142-file TypeScript suite, 3 commits touching 12 source files (2026-09-21):

| | files | test cases | wall time |
| --- | ---: | ---: | ---: |
| full suite | 142 | 1,420 | 18.9 s |
| `jgrep --tests HEAD~3` | 47 (12 by name, 27 by import, 8 by Jev) | 536 | 12.6 s |

Selection itself: 7 requests, 56k tokens, $0.0024, 1.0 s. The suite above is fast, so
runner startup dominates; the ratio matters more on suites that take minutes.

### Score a table (CSV / JSONL), not just code

Every row becomes one state. One description works like grep; a JSON file of
Jev questions (noul, choice, score) adds one answer column per question.

```bash
jgrep --rows creators.csv "beauty is the main content of this account"
jgrep --rows creators.csv --questions beauty.json --out scored.csv
```

```json
{
  "beauty":   { "type": "noul",   "instructions": "Is beauty the main content of this account?" },
  "category": { "type": "choice", "instructions": "Dominant sub-category?",
                "criteria": { "skincare": "skin care", "makeup": "cosmetics", "other": "not beauty" } },
  "fit":      { "type": "score",  "instructions": "Fit for a Korean skincare seeding campaign?",
                "criteria": ["no fit", "weak", "moderate", "strong", "ideal"] }
}
```

Question objects are passed to the API verbatim, so anything Jev accepts works.
Output columns: `beauty` (probability), `category` + `category_p`, `fit` + `fit_conf`.
Eight creators and five questions is one request, 3k tokens, well under a cent;
see [`examples/`](examples/). This is the "AI map-reduce" shape: scrape N
things, ask k typed questions each, filter in a spreadsheet.

### Feed your coding agent

Agents burn most of their tokens *looking* for code. jgrep hands them a short
list of ranges instead of whole files. On a 115 KB module the agent read
6 KB of matching chunks instead of everything.

```bash
jgrep init                   # tick "Claude Code" / "Codex" to install the skill
jgrep --json "spawns a child process" src/ | jq '.[].file'
```

The skill also has the agent run a few `--diff --staged` rules on its own
change before committing: a second model checking the first one's work, for
a fraction of a cent.

## All options

```
jgrep init                               interactive setup
jgrep [options] "<description>" [path ...]
jgrep [options] --diff [ref] "<description>"
jgrep [options] --rows <file.csv|.jsonl> "<description>"
jgrep [options] --rows <file> --questions <q.json> [--out scored.csv]
jgrep [options] --tests [ref] [--staged] [path ...]

  -t, --threshold <p>   print chunks with probability >= p (default 0.7)
  -C, --show            print the matching chunk body under each hit
  -a, --all             print every chunk with its probability, best first
      --json            machine-readable output
      --diff [ref]      grep git diff hunks (working tree, or against <ref>)
      --staged          with --diff / --tests: staged changes only
      --tests [ref]     predictive test selection: test files a diff plausibly affects
      --rows <file>     grep rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions asked of every row
      --out <file>      with --questions: write the CSV here instead of stdout
  -b, --batch <n>       chunks per request (default 16)
  -c, --concurrency <n> parallel requests (default 16)
      --timeout <s>     per-batch deadline, retries included (default 15)
      --request-timeout <s>  per-attempt HTTP timeout (default 30)
      --retries <n>     failed attempts tolerated per batch (default 4)
      --rate <req/s>    global request pacing (token bucket); 0 = unlimited
      --fail-fast       abort on the first fatal error instead of isolating it
      --no-cache        ignore and do not write ~/.cache/jgrep
```

## Reliability & errors

Failures are isolated by default: a failed batch marks only its chunks errored
(rows, when scoring), the rest of the run continues, and answers already paid
for are kept in the cache.

- **Retries**: statuses 408/429/5xx and transport errors (timeouts,
  `ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`) retry with full-jitter exponential
  backoff (500 ms base, 30 s cap), `--retries` times (default 4, so 5 attempts).
  A provider `Retry-After` is honored, capped at 5 minutes.
- **Deadlines**: `--request-timeout` (30 s) bounds one HTTP attempt;
  `--timeout` (15 s) is the deadline for a whole batch *including* its retries —
  an expired batch is recorded as errored and the run moves on.
- **Pacing**: `--rate REQ/SEC` spaces all requests with a token bucket
  (0 = unlimited).
- **Circuit breaker**: 3 consecutive fatal failures — out of credits, bad key,
  model gone, host unreachable, TLS — stop new dispatches instead of hammering
  on; chunks never attempted are reported as `circuit_breaker_open`.
  `--fail-fast` restores abort-on-the-first-fatal instead of isolating.

Exit status: `0` hits, `1` none, `2` on error or when any chunk/row errored —
partial failures still report their hits, the summary line carries the error
breakdown (` · 4 errored (3 timeout, 1 rate_limited)`), and up to 5 examples
go to stderr. Every failure carries a typed kind:

| kind                   | meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `insufficient_credits` | out of credits — top up with the provider                      |
| `invalid_api_key`      | key rejected; the hint tells you if it worked earlier this run |
| `model_unavailable`    | the provider does not serve this model                         |
| `rate_limited`         | throttled — pace with `--rate`                                 |
| `bad_request`          | request-shape problem; the provider's body is quoted           |
| `malformed_response`   | unexpected 200 body — the API surface may have changed         |
| `server_unreachable`   | network or provider down after retries                         |
| `tls_error`            | certificate problem, message quoted verbatim                   |
| `timeout`              | attempt or batch deadline exceeded                             |
| `circuit_breaker_open` | never attempted — the breaker stopped new dispatches           |

**`--json` is unchanged** (same contract as 0.3.0): the bare array — code mode
`[{file,start,end,p,text}]`, rows questions mode the scored table rows (your row
fields plus the answer columns), rows single-description mode the shown hits
`[{row, p, ...row fields}]` with `row` the CSV line number. Questions mode
(`--questions`) includes **every row** — an errored row keeps its place with the
question columns empty (its flattened answer is null); single-description mode
emits only the shown hits, so errored rows never enter that array. Errors
surface through the stderr summary and exit 2.

## How it works

1. **Files** come from `git ls-files` (untracked included, ignored excluded),
   or a directory walk. Binaries and files over 1 MB are skipped.
2. **Chunks**: each file is split at column-0 line starts into 5 to 60 line
   pieces. With `--diff`, each hunk is a chunk and keeps its `+`/`-` markers.
3. **One request, 16 chunks, 16 questions**: `state.chunks[]` plus a Noul
   question per chunk, *"look only at chunk c3, does it match: …"*.
4. **Threshold**: probabilities at or above `-t` are printed in file order.
   Answers are cached by `(model, question, chunk)` in `~/.cache/jgrep/`, so
   the same query again is free and instant.

| repo                         | chunks | time  | cost    |
| ---------------------------- | -----: | ----: | ------: |
| TypeScript CLI, `src/`       |    896 | 1.8 s | $0.010  |
| same query again (cache)     |    896 | 0.0 s | $0      |
| one module, `app/lib/`       |    521 | 1.6 s | $0.006  |

## Tips

- Write the description in **English** and describe the **code**, not the
  feature: *"decides whether to alert based on OCR confidence"* beats
  *"alert feature"*. Jev's accuracy is lower on non-English text.
- One behavior per query. Split compound questions and combine in your head
  (or in a script with `--json`).
- Chunks are judged in isolation, so cross-file flow ("does this eventually
  hit the DB") will not match. Ask about the local code.
- `p >= 0.9` is reliable, `0.7-0.9` is worth a look.

## Develop

```bash
bun test src/     # unit tests, no network
bun run build     # dist/jgrep.js, plain node, deps bundled
```

If jgrep saved you a file-hunting session, a ⭐ on GitHub is the best thanks.

MIT
