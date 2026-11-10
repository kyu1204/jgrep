<div align="center">

# jgrep

**grep for what code *does*, not what it's called.**<br>
**Gate PRs on it. Run only the tests a diff can affect.**

```
jgrep "catches an error and silently ignores it" src/
```

[![upstream npm](https://img.shields.io/npm/v/jevgrep?color=0a0&label=upstream%20npm)](https://www.npmjs.com/package/jevgrep)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)
[![model](https://img.shields.io/badge/powered%20by-Jev%20%C2%B7%20TypeSafe-8a2be2)](https://docs.typesafe.ai)
[![openrouter](https://img.shields.io/badge/also%20via-OpenRouter-6467f2)](https://openrouter.ai/typesafe)

*No index. No embeddings. No LLM round-trips. A whole `src/` tree in ~2 s for about a cent.*

*On five OSS repos, `--tests` picked 12% of the test files and still caught over 90% of the
tests each commit's author changed, for $0.11 across 60 commits ([bench](bench/tests/README.md)).*

<sub>This is Emasoft's fork of [kyu1204/jgrep](https://github.com/kyu1204/jgrep), the original
project by kyu1204, published on npm as `jevgrep`; this fork is installed from GitHub and is never
published to npm. Not [dzhng/jevgrep](https://github.com/dzhng/jevgrep) (`jg`), a separate code-discovery CLI.</sub>

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

jgrep runs on [Jev](https://docs.typesafe.ai), through TypeSafe or
[OpenRouter](https://openrouter.ai/typesafe), a *System One* model: it never
generates text, it answers typed yes/no questions with calibrated
probabilities, in parallel, at $0.042 per million input tokens with output free.
jgrep packs 16 code chunks and 16 questions into one request and turns the
probabilities into `file:line` hits.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Emasoft/jgrep/main/install-dev.sh | bash -s -- --choice 8
```

Then give jgrep a key the way you give it to every other tool: export
`OPENROUTER_API_KEY` (or `TYPESAFE_API_KEY`, or another provider's key, see
[Providers](#providers)) in your shell profile. jgrep finds it; there is nothing to
pass on the command line. Get a key at
[openrouter.ai/keys](https://openrouter.ai/keys) or
[console.typesafe.ai](https://console.typesafe.ai). To choose providers and their
order, write `~/.jgrep/providers.json`, or let `jgrep init` write it (below).
`jgrep --estimate ...` shows what a run would cost without sending anything or
needing a key.

### This fork is never published to npm

`package.json` is `"private": true` and the publish workflow runs only in the
upstream repository, so nothing from this fork ever reaches npm. The `jevgrep`
package on npm is upstream's release (`npm i -g jevgrep` installs that, not this
fork). Install the fork with the one-liner above, or from a clone:

```sh
./install-dev.sh --choice 1     # local: build this checkout, symlink the jgrep bin
```

`--choice 8` clones the fork into `~/.local/share/jgrep` (override with
`JGREP_DEV_DIR`) — a script-managed directory, never a dev checkout: every
re-run fetches `origin/main` and `git reset --hard origin/main` there — but only
in a clone the script created itself (it carries a `jgrep-managed` marker in its
git dir), whose origin is exactly the fork, with no uncommitted changes and on
`main`; anything else is refused, so a `JGREP_DEV_DIR` pointed at a real checkout
can never lose work (a clone made by an older script is adopted with the `touch`
command the refusal prints). Then it
runs the full setup: deps (`bun install`), build, the `jgrep` bin symlinked
system-wide (npm global bin → `/usr/local/bin` → `~/.local/bin`), and the
agent-skill refresh. Previous installs are autodetected and replaced exactly
like option 1: symlinks are repointed (including one pointing at an old clone
path), real files are archived as `jgrep.bak-<timestamp>` with the printed
`mv` command to revert. Updating = re-running the same command. A missing bun is
installed via [bun.sh](https://bun.sh) only after a yes: the script asks (through
`/dev/tty` when piped) and installs without asking only with an explicit
`--yes` (`--choice` alone no longer implies it); node ≥ 18 is still required at
runtime. The
interactive menu cannot run through a pipe — use the `--choice 8` one-liner;
`--choice 8 --dry-run` previews everything and mutates nothing.

Or by hand from a clone (no npm release involved):

```sh
git clone https://github.com/Emasoft/jgrep && cd jgrep
bun install && bun run build
npm i -g .        # installs the `jgrep` bin from this folder
```

### `jgrep init`

`jgrep init` writes `~/.jgrep/providers.json` for you. It asks **which provider**
(OpenRouter, TypeSafe, a compatible System One endpoint, Cloudflare Workers AI or
the Vercel AI Gateway), the endpoint for `compatible` and the account id for
Cloudflare when they are not exported, keeps an existing key or verifies a pasted
one (OpenRouter, TypeSafe and Cloudflare through their free key-check routes, never
a billed request; a key on an empty account is accepted with a top-up warning, and
a network failure lets you save the key unverified instead of calling it
rejected), saves it as that provider's literal `api_key` (the file is written
`0600` in a `0700` directory, atomically) unless you export the variable yourself,
offers to put the provider first in the fallback chain, and optionally installs the
jgrep skill into your AI agents (every harness, via the pinned vercel `skills`
installer). `jgrep init --request-timeout <s>` sets the key check's timeout
(default 15 s).

## Providers

Providers live in **`~/.jgrep/providers.json`** (or `$JGREP_HOME/providers.json`),
the same format as [Quicksilver](https://github.com/Emasoft/quicksilver)'s
`~/.quicksilver/providers.json`. The `providers` array **is the fallback chain**:
the first provider whose key is set gets each request, and a request that fails on
a rejected key (401/403), no credits (402), an unavailable model, or a 429 / 5xx /
network error after its retries moves on to the next one. A request-shape error
(400/422) would fail everywhere, so it never falls back.

```json
{
  "version": 1,
  "providers": [
    { "name": "openrouter", "api_key": "$OPENROUTER_API_KEY" },
    { "name": "typesafe", "api_key": ["$JEV_API_KEY", "$TYPESAFE_API_KEY"] },
    { "name": "cloudflare", "enabled": "off" }
  ]
}
```

With no file, the chain is the six built-ins in this order:

| name         | endpoint                                                             | default model          | key (`api_key`)                                                     | free key check |
| ------------ | -------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------- | -------------- |
| `openrouter` | `https://openrouter.ai/api/v1/systemone`                             | `~typesafe/jev-latest` | `$OPENROUTER_API_KEY`                                               | `/api/v1/key`  |
| `typesafe`   | `https://api.typesafe.ai/v1/systemone`                               | `jev-latest`           | `$JEV_API_KEY`, `$TYPESAFE_API_KEY`                                 | `/v1/models`   |
| `compatible` | `base_url` + `path`, or `$JEV_GATEWAY_URL` (any System One endpoint) | `jev-latest`           | `$JEV_GATEWAY_API_KEY`                                              | none           |
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts/<id>/ai/run`          | `typesafe/jev`         | `$JEV_CLOUDFLARE_API_TOKEN`, `$CLOUDFLARE_API_TOKEN` + `$CLOUDFLARE_ACCOUNT_ID` | `/user/tokens/verify` |
| `vercel`     | `https://ai-gateway.vercel.sh/v4/ai/evaluation-model`                | `typesafe-ai/jev`      | `$AI_GATEWAY_API_KEY`                                               | none           |
| `mlx`        | `$MLX_DECISION_URL` + `/v1/systemone` (local server)                 | `elephant-1`           | `$MLX_DECISION_API_KEY` (none on loopback)                          | `/health`      |

- **The file is the chain, exactly.** When providers.json exists, only its entries
  are used, in its order; a built-in it does not name is never appended. An entry
  named like a built-in takes the built-in's fields as defaults and overrides any
  of them; any other name is a new provider and must give `base_url`, `path`,
  `adapter` (`system-one`, `cloudflare-ai-run` or `vercel-evaluation`), `api_key`
  and `model`. `providers.example.json` (shipped with jgrep) shows every field.
- **Keys.** `api_key` is `"$VAR"` or `"${VAR}"` (read from your environment), a
  literal key, or an array of these (the first one set wins). A provider whose key
  is unset is skipped silently — that is not an error. A file holding a literal key
  must be `chmod 600`: otherwise jgrep refuses it and prints the command. Keys are
  never printed (`jgrep status` names the variable, or "literal in providers.json").
  If providers.json gives no key, jgrep still looks in its old places, in this
  order: `~/.config/jgrep/<name>.key`, the legacy `~/.config/jgrep/env`, then the
  project's `./.env` (warned on stderr when it is not gitignored).
- **`enabled`**: `false` (or `no`, `n`, `off`, `0`, `disabled`, `disable`, `inactive`)
  skips an entry; `true` (or `yes`, `y`, `on`, `1`, `enabled`, `enable`, `active`) or
  no field keeps it; any case. Anything else is a config error (exit 2) naming the
  provider and the value.
- **Pinning.** `--provider NAME` (or `JEV_API=NAME`) uses only that provider, with
  no fallback. `--model` (or `JEV_MODEL`, `JGREP_MODEL`) applies to each provider
  whose model ids it fits (OpenRouter ids are `vendor/model`, TypeSafe ids have no
  slash); the others keep their own model, with a warning.
- **`mlx`.** A local [mlx-decision](https://github.com/armbues/mlx-decision) server
  speaks the same System One request and answer, so `elephant-1` runs on this
  machine with no key and no per-call cost. It is LAST in the chain: it answers
  only after a hosted provider failed or ran out of credits. jgrep never starts
  it (`mlx-decision server -m baselabs/elephant-1`, ~15 GB of RAM, one per
  machine) — export `MLX_DECISION_URL` while it runs, and with none set the entry
  is skipped like `compatible` without an endpoint. elephant-1 is far slower than a
  hosted model: 47 chunks of `src/cli.ts` took about 3 minutes in 16-chunk batches on
  an M-series Mac, and one 16-chunk batch of its large chunks already outlived the
  15 s default `--timeout`. Raise `--timeout` (and `--request-timeout`) for local runs.
  It answers concurrent requests (20 chunks at `-c 16` took 4.9 s; serial at `-c 1`,
  14.0 s), so keep the default concurrency and raise only the timeouts. Two
  consequences of a server that is free but not free-priced: `--budget` and
  `--estimate` still reserve at the run-wide `$JEV_PRICE_PER_MTOK`, so `--budget 0`
  refuses a free local answer (leave the budget off when the chain may reach mlx);
  and the probabilities are the local model's own — a `p` from elephant-1 is not
  comparable with a `p` from Jev, though the `fallback:` line and the per-model
  cache keep the two apart.
- **Circuit breaker.** A provider that failed is skipped for the rest of the run,
  and until a provider has answered once the run's other requests wait for that
  first one, so a dead key costs one request, not one per batch. An answer a
  fallback provider gave is cached under its own model.
- **What happened.** When a run falls back, stderr ends with a `fallback:` line
  (from which provider to which, why, how many requests) and which provider and
  model answered. Every provider error is logged to **`~/.jgrep/errors.log`**:
  timestamp, version, provider, model, kind, HTTP status, where the request went
  next, the message (keys masked); entries older than 72 hours are dropped on
  every write. `jgrep status` lists the chain with each provider's state (ready,
  key present (not verified), key missing, rejected, no credits, unreachable,
  disabled) using only the free key checks.

```bash
jgrep "swallows errors" src/                            # the chain, in providers.json order
jgrep --provider openrouter "swallows errors" src/      # only OpenRouter, no fallback
jgrep status                                            # the chain and each provider's state
JEV_GATEWAY_URL=http://127.0.0.1:11434/v1/systemone \
  jgrep --provider compatible --model nimble --tests HEAD~1   # a local server: no key needed
# or fall back to a local mlx-decision server (elephant-1) when the hosted ones fail:
MLX_DECISION_URL=http://127.0.0.1:8123 jgrep "swallows errors" src/
```

A `base_url` must be `https://`, except a loopback `http://` server
(`localhost`, `127.0.0.1`, `[::1]`), which also needs no key. providers.json is
read only from jgrep's home, and `JEV_GATEWAY_URL` (alias `JGREP_ENDPOINT`) only
from the environment (or the URL an older `jgrep init` saved in
`~/.config/jgrep/env`); `MLX_DECISION_URL` only from the environment. None of them
is ever read from a project's `./.env`, so a cloned repo cannot redirect your key
to its own server. **Run jgrep under node** (the installed bin does, via its
shebang): bun loads `./.env` into the environment by itself, so under bun a
`JGREP_HOME`, `JEV_API`, `JEV_GATEWAY_URL`, `JGREP_ENDPOINT` or `MLX_DECISION_URL`
value that came from a `./.env*` file is refused. Requests never follow a redirect.

Requests to openrouter.ai carry OpenRouter's app-attribution headers
(`HTTP-Referer`, `X-OpenRouter-Title` and its older alias `X-Title`, both `jgrep`,
`X-OpenRouter-Categories: cli-agent`); no other endpoint gets them. Answers are
cached per model id, so switching models never reuses another model's answers.

## Examples

Every example from `jgrep --help`, runnable as written from this repo's root:

```bash
jgrep "catches an error and silently ignores it" src/
jgrep -C -t 0.9 "builds an SQL string by concatenation" .
jgrep -a -t 0 "retries failed HTTP requests" src/ | head
jgrep --funcs "parses command-line arguments" src/
jgrep --diff --staged "leaves debug output such as console.log"
jgrep --diff origin/main --sarif "adds an endpoint without an auth check"
jgrep --tag "real bug,best-effort cleanup" "swallows an exception" src/
jgrep --json "spawns a child process" src/ | jq -r '.[].file'
bun test $(jgrep --tests origin/main)
jgrep --rows examples/creators.csv "beauty is the main content of this account"
jgrep --rows examples/creators.csv --questions examples/beauty.json --out scored.csv
jgrep --estimate "swallows errors" src/
jgrep --budget 0.05 "swallows errors" .
jgrep --provider openrouter "swallows errors" src/
```

## Use cases

| you want to… | run |
| --- | --- |
| find where X happens in an unfamiliar repo | `jgrep -C "validates the webhook signature" .` |
| triage a big diff or PR: rank the hunks, then label them | `jgrep --diff origin/main --tag "bug,refactor" "changes error handling"` |
| pick the tests to run in CI | `jgrep --tests origin/main \| xargs bun test` |
| classify CSV / JSONL rows with typed questions | `jgrep --rows data.csv --questions q.json --out scored.csv` |
| cap spending: price the run first, then set a hard cap | `jgrep --estimate "<rule>" src/ && jgrep --budget 0.02 "<rule>" src/` |
| SARIF for code scanning in CI | `jgrep --diff origin/main --sarif "<rule>" > jgrep.sarif` |
| a local or Ollama System One server, no key, no code leaves the machine | `JEV_GATEWAY_URL=http://localhost:11434/v1/systemone jgrep --provider compatible --model <name> "<rule>" src/` |

## Cost

Cost is settled per request: the provider's reported number when it sends one
(OpenRouter), else that request's `input tokens × $JEV_PRICE_PER_MTOK` (default
`$0.042` per million input tokens, output free), so a provider that reports cost
only sometimes is not undercounted.

- **`--estimate`** is a dry run for every mode (code, `--diff`, `--rows`,
  `--tests`): it builds every request the run would send, counts cached chunks
  as free, prints a per-file chunk table and
  `estimated: N requests, ~T input tokens, ~$X`, sends nothing, needs no key,
  and exits 0 (`--json` prints `{requests,tokens,usd,estimate:true}`). With
  `--funcs` it prices pass 1 (the signature chunks) exactly and pass 2 as an
  **upper bound** — every candidate file shortlisted — since pass 2 depends on
  answers a dry run never gets (`estimated --funcs pass 1: …` and
  `upper bound with pass 2 …`; `--json` adds `upper_bound`).
- **`--budget <usd>`** is a hard cap, and it is **opt-in: there is no cap
  unless you set one** (`--budget`, or `JEV_BUDGET`; the flag wins). Before a
  request is sent, its estimated cost is *reserved* against the budget; a
  request that does not fit in what is left is never sent and its chunks error
  `budget_exhausted` (exit 2, with a `raise --budget` hint). Each response
  replaces its reservation with the real cost. Because concurrent requests
  reserve before they are sent, a wave of parallel workers cannot overshoot.
  It covers every mode: the search, `--verify`, `--tag`, both `--funcs`
  passes, `--rows` and `--tests`. Hits and cached answers already in hand are
  kept. A request that fails after the provider likely billed it (a 200 with a
  malformed body, a client-side timeout, a 5xx) keeps its reservation as spend.
  `--budget 0` sends nothing.
- **The cap's ceiling is the estimator's accuracy.** A reservation is
  estimated input tokens × `$JEV_PRICE_PER_MTOK`; the estimate lands within
  about 15% of billed tokens (e.g. 186,987 estimated vs 187,344 billed on this
  repo's `src/`), so the requests in flight can push the final spend past the
  limit by up to that margin.
  If `JEV_PRICE_PER_MTOK` is set far below what the provider really charges,
  every reservation is under-priced and the cap overshoots in proportion — so
  with `--budget` set, jgrep compares the provider-reported cost per token with
  that price and prints a warning (naming the value to set) when the provider
  bills more than 10% above it.

## Use

### Find code by behavior

```bash
jgrep "reads user input without validating it" src/
jgrep -C "parses a JWT or decodes a base64 token payload" src/     # -C prints the chunk
jgrep -t 0.9 "builds an SQL string by concatenation" .            # stricter
jgrep -a -t 0 "is dead code nothing calls" src/ | head            # everything, best first
```

### Lint a change with rules written in English

```bash
jgrep --diff --staged "leaves debug output such as console.log"
jgrep --diff origin/main "adds an HTTP endpoint that has no auth check"
jgrep --diff origin/main "changes billing logic without touching a test"
```

Exit status is grep's: `0` matched, `1` nothing matched, `2` jgrep could not run
or a chunk errored (bad key, API down, malformed response, partial failure). In
CI keep the three apart: a plain `!` would turn an outage or an expired secret
into a passing check.

```yaml
- run: curl -fsSL https://raw.githubusercontent.com/Emasoft/jgrep/main/install-dev.sh | bash -s -- --choice 8
- name: no unauthenticated endpoints
  env: { TYPESAFE_API_KEY: "${{ secrets.TYPESAFE_API_KEY }}" }   # or OPENROUTER_API_KEY
  run: |
    set +e
    jgrep --diff "origin/${{ github.base_ref }}" "adds an HTTP endpoint that has no auth check"
    case $? in
      0) echo "::error::jgrep found a match"; exit 1 ;;
      1) ;;                                          # clean
      *) echo "::error::jgrep failed to run";  exit 1 ;;
    esac
```

#### GitHub Action

The same gate as a one-liner, maintained upstream (it installs the npm `jevgrep`
package, not this fork). For test selection use `mode: tests` instead
(see [jgrep-action](https://github.com/kyu1204/jgrep-action)).

```yaml
- uses: actions/checkout@v5
  with: { fetch-depth: 0 }
- uses: kyu1204/jgrep-action@v1
  with: { mode: diff, rule: "adds an HTTP endpoint that has no auth check", api-key: "${{ secrets.TYPESAFE_API_KEY }}" }
```

### Run only the tests a change can affect

```bash
jgrep --tests origin/main | xargs bun test        # or vitest / pytest / go test
jgrep --tests --staged -a                         # every test file with its probability
```

Three layers, cheapest first: tests named after a changed file (`foo.ts` → `foo.test.ts`)
and tests that import a changed module (or the package root, when the package entry file
(`src/index.*`, `index.*` or `__init__.py`) changed) are selected in code; the rest are asked of Jev
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

On five OSS repos (hono, zod, fastify, flask, requests; 60 commits that changed both source
and tests), `--tests` selected 12% of test files and caught 93% of the tests each commit's
author had touched, versus 45% from name, import and package-root matching alone; $0.11 total
(upstream's measurement). Method and per-commit rows: [bench/tests](bench/tests/README.md).

### Score a table (CSV / JSONL), not just code

Every row becomes one state. One description works like grep; a JSON file of
Jev questions (noul, choice, score) adds one answer column per question.

```bash
jgrep --rows examples/creators.csv "beauty is the main content of this account"
jgrep --rows examples/creators.csv --questions examples/beauty.json --out scored.csv
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

Question objects are passed to the API verbatim, so anything Jev accepts works
(a `choice` question's `criteria` must be a record keyed by label, as above; an
array is rejected with HTTP 400).
A row too big for one request is judged in parts. For a `choice` the best real
evidence wins: the catch-all label is the last criterion (`other` above) unless
`--default <label>` names another (an unknown label exits 2); a part votes only
when its top label is not the catch-all, the voting part with the highest
probability decides, and a row where no part votes gets the catch-all at its best
probability. noul and score take the highest part.
Output columns: `beauty` (probability), `category` + `category_p`, `fit` + `fit_conf`.
Eight creators and five questions is one request, 3k tokens, well under a cent;
see [`examples/`](examples/). This is the "AI map-reduce" shape: scrape N
things, ask k typed questions each, filter in a spreadsheet.

### Feed your coding agent

Agents burn most of their tokens *looking* for code. jgrep hands them a short
list of ranges instead of whole files. On a 115 KB module the agent read
6 KB of matching chunks instead of everything.

```bash
jgrep --json "spawns a child process" src/ | jq '.[].file'             # bare array (v0.3.0 shape)
jgrep --json-errors "spawns a child process" src/ | jq '.hits[].file'  # opt-in object, errors included
```

The agent skill is `skills/jgrep/SKILL.md`; it embeds `jgrep --help` verbatim
(a test keeps the two identical). Every install path ships that same file: the
curl install (and `install-dev.sh` options 1-3) refreshes it in every
agent-skills harness (Claude Code, Codex, OpenCode, Cursor, +75 more) via the
vercel `skills` installer, falling back to the standard `~/.agents/skills/jgrep`
folder; `jgrep init` offers the same install; manually:
`npx skills@1.7.0 add ./skills -g` from a checkout (the installer is pinned to
an exact version everywhere).

Or install the skill as a Claude Code plugin (the `jgrep` command must be installed too):

```
/plugin marketplace add Emasoft/jgrep
/plugin install jgrep@jgrep
```

The skill also has the agent run a few `--diff --staged` rules on its own
change before committing: a second model checking the first one's work, for
a fraction of a cent.

## Reliability

Failures are isolated by default: a failed batch marks only its chunks errored,
the rest of the run continues, and answers already paid for are kept in the
cache.

- **Retries**: statuses 408/429/500/502/503/504/529 and transport errors
  (timeouts, `ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`/`EAI_AGAIN`) retry with
  full-jitter exponential backoff (500 ms base, 30 s cap), `--retries` times
  (default 4, so 5 attempts). A provider `Retry-After` is honored, capped at
  5 minutes; one longer than what is left of the batch deadline fails the batch
  at once as `rate_limited` (pace with `--rate`) instead of sleeping into a
  `timeout`. Redirects are never followed (the request carries your key): a 3xx
  endpoint fails fast with a hint to use the final URL.
- **Deadlines**: `--request-timeout` (30 s) bounds one HTTP attempt;
  `--timeout` (15 s) is the deadline for a whole batch *including* its retries —
  an expired batch is recorded as errored and the run moves on.
- **Pacing**: `--rate REQ/SEC` spaces all requests with a token bucket
  (0 = unlimited).
- **Circuit breaker**: 3 consecutive fatal failures — out of credits, bad key,
  model gone, host unreachable, TLS — abort the run instead of hammering on;
  chunks never attempted are reported as `circuit_breaker_open`. `--fail-fast`
  restores abort-on-the-first-fatal.

## Errors & exit codes

Exit status: `0` hits, `1` none, `2` when any chunk errored or a fatal was
thrown. Hits and the error breakdown are both printed, and every failed chunk
carries a typed kind with a hint on stderr. With several providers in the chain,
these are the errors left after every provider was tried: the message lists each
provider's failure, and a key or credit failure among them is the kind reported.

| kind                   | hint |
| ---------------------- | ---- |
| `insufficient_credits` | billing URL to top up, or switch to the other hosted provider (`--provider openrouter` / `--provider typesafe`) |
| `invalid_api_key`      | names where the provider's key comes from; tells you when the key worked earlier this run (expired/revoked) vs never worked (wrong provider's key) |
| `model_unavailable`    | pin a version with `--model` (e.g. `typesafe/jev-1.13`), or `--provider typesafe`; OpenRouter's 400 "Model X does not exist" lands here |
| `forbidden`            | OpenRouter 403: moderation flagged that chunk, or the key has no access to the model — per chunk, never trips the breaker |
| `rate_limited`         | the provider is throttling — pace with `--rate` |
| `bad_request`          | request-shape problem; the provider's error message is quoted (`error.message` of a JSON body, so account fields such as `user_id` never reach the output) |
| `malformed_response`   | the API surface may have changed — pin `--model` or report it |
| `server_unreachable`   | check the network or the provider's status page |
| `tls_error`            | certificate problem, message quoted verbatim |
| `timeout`              | raise `--timeout` or `--request-timeout` |
| `circuit_breaker_open` | provider failing consistently — the chunk was never attempted |
| `budget_exhausted`     | the request did not fit in what was left of `--budget` and was never sent — raise `--budget` |

**`--json` is backward-compatible**: code mode is byte-identical to 0.3.0
(`[{file,start,end,p,text}]`); rows mode is a flattened answer array with
`null` for an errored row (position-aligned, so index `i` is
always input row `i`). Errored chunks/rows are not in the array; they surface
through the stderr summary and exit 2. New in 0.4.0: **`--json-errors`**
(implies `--json`) opts into the object shape — code mode
`{"hits":[…],"errors":[{file,start,end,kind,message}]}`, rows mode
`{"answers":[…],"errors":[{row,kind,message}]}`. `--out` writes whichever
shape was selected.

Cache notes. Keys include the resolved model id, so entries for another
provider's model — openrouter's `~typesafe/jev-latest`, any `--model` override —
are separate from typesafe's `jev-latest`: those queries re-bill once on the
first run after upgrading, default typesafe queries keep their old keys. A
failed batch is retried as a whole: keeping per-answer results from a failed
batch depends on the provider returning per-question answers alongside errors,
which is still to be verified on OpenRouter.

### Cache

Answers are cached in `~/.jgrep/cache.json` (or `$JGREP_HOME/cache.json`) by
(model, question, chunk), so the same query again is free. The cache used to live
in `~/.cache/jgrep/` (or `$XDG_CACHE_HOME/jgrep/`); it is not migrated, and jgrep
says once, until the new cache exists, that the old file can be deleted; a save that fails (read-only home, full disk) prints one warning instead
of silently re-billing every run. New in 0.7.0: cache keys hash the **normalized** chunk text (trailing
whitespace stripped, blank lines dropped, line endings unified) rather than the
raw bytes, so trailing spaces, blank-line churn and CRLF/LF changes do not
re-bill; any change in content or in leading indentation still does
(indentation is meaning in Python, YAML, Makefiles and diffs). Entries keyed on the old
raw chunk text simply miss once and re-bill after upgrading; there is no
migration code. The cache is also capped at **10,000 entries** (`v1` envelope
with an insertion-order list): when a save would exceed the cap, the oldest
entries are evicted first and the newest judgments always survive. Saves are
atomic — written to a temp file next to the cache and renamed into place — so
concurrent jgrep processes can never see a half-written cache.

## All options

`jgrep --help`, verbatim:

```
jgrep 0.7.0 — semantic grep powered by Jev

usage: jgrep init [--request-timeout <s>]   setup: provider, key (checked), agent skills
       jgrep status [--provider <name>] [--request-timeout <s>]  the chain and its state
       jgrep [options] "<description>" [path ...]
       jgrep [options] --diff [ref] "<description>"
       jgrep [options] --tests [ref] [--staged] [path ...]
       jgrep [options] --rows <file.csv|.jsonl> "<description>"
       jgrep [options] --rows <file> --questions <q.json> [--out scored.csv]

Describe the code in English; jgrep asks Jev one yes/no question per chunk and
prints the chunks that match as file:line ranges with a probability p.

search
  -t, --threshold <p>   print chunks with p >= this (default 0.7; 0.5 with --tests)
  -a, --all             print every chunk with its probability, best first
  -C, --show            print the matching chunk body under each hit
      --diff [ref]      judge git diff hunks instead of files (working tree, or vs <ref>)
      --staged          with --diff / --tests: staged changes only

input and chunking
  paths default to "."; files come from git ls-files (else a walk, max 5000 files);
  binaries are skipped; code splits into 5-60 line chunks, Markdown at headings,
  a diff per hunk; anything too big for Jev's context is split, never truncated,
  and a per-file verdict (--funcs, --tests, a split row) takes the best part
  -b, --batch <n>       chunks per request (default 16; fewer when chunks are big)
      --max-bytes <n>   skip files over n bytes (default: none; over the 100 MB
                        hard ceiling always skipped; a larger n exits 2)
      --follow-symlinks follow symlinks found while listing (default: skip and
                        report them); secret-looking names/targets stay refused
      --no-cache        ignore and do not write the cache (~/.jgrep/cache.json)

output
      --json            hits as a JSON array [{file,start,end,p,text}] (v0.3.0 shape);
                        --rows: flattened answer objects, null for an errored row
      --json-errors     implies --json and prints an object instead: code mode
                        {hits, errors:[{file,start,end,kind,message}]},
                        rows mode {answers, errors:[{row,kind,message}]}
      --sarif           SARIF 2.1.0 instead of text: one rule per description, one
                        result per hit (GitHub code scanning)
      --out <file>      with --rows: write the CSV (or, with --json, the JSON) here

modes
      --funcs           two passes: shortlist files by their function signatures,
                        then search only those (code search; ignored with --diff)
      --group           print one group per near-identical signature with its sites
                        (each family is judged once; --json adds "groups")
      --votes <n>       ask every chunk n times (1-5); the median probability wins
      --verify          re-ask every hit strictly; it stands at p >= 0.6 x threshold
      --envelopes       append each chunk's numbers to its text (steadier counting)
      --tag <a,b,...>   classify each hit into one of 2+ categories, printed as [tag]
      --default <label> catch-all category of --tag or a --questions choice (default:
                        the last; unknown: exit 2); a split row takes its best other label
      --tests [ref]     print the test files a diff plausibly affects (by name, by
                        import, then by Jev); pipe the list into your test runner
      --rows <file>     judge the rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions (noul/choice/score) asked
                        of every row; prints the table with one column per question
  --group, --votes, --verify, --envelopes and --tag apply to code and --diff search

provider and keys (~/.jgrep/providers.json; `jgrep status` shows the chain)
      --provider <name> only this provider, no fallback (env JEV_API)
      --model <id>      model id where it fits a provider's ids (env JEV_MODEL, JGREP_MODEL)
  providers.json: {"version":1,"providers":[{"name":"openrouter","api_key":
  "$OPENROUTER_API_KEY"},{"name":"typesafe"}]}: array order = fallback order; a
  failure moves the request on unless bad_request/circuit_breaker_open/budget_exhausted,
  logged to ~/.jgrep/errors.log (kept 72 h); api_key "$VAR" or a literal (chmod 600),
  else ~/.config/jgrep/{<name>.key,env}, ./.env; fields: providers.example.json
  "adapter": system-one/cloudflare-ai-run/vercel-evaluation
  "enabled" (any case): true/enabled/enable/1/yes/y/active/on or absent keeps an entry,
  false/disabled/disable/0/no/n/inactive/off skips it, anything else is a config error
  built-ins (the chain without a file) and their key env vars (the first one set wins):
    openrouter  OPENROUTER_API_KEY
    typesafe    JEV_API_KEY / TYPESAFE_API_KEY
    compatible  JEV_GATEWAY_API_KEY
    cloudflare  JEV_CLOUDFLARE_API_TOKEN / CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
    vercel      AI_GATEWAY_API_KEY
    mlx         MLX_DECISION_API_KEY

environment
  JEV_GATEWAY_URL       compatible: full System One endpoint when providers.json gives
                        no base_url; https:// or a loopback http:// server that needs no
                        key (alias JGREP_ENDPOINT; process env only, never ./.env)
  MLX_DECISION_URL      mlx: base URL of a local mlx-decision server (unset: skipped; env only)
  JGREP_HOME            jgrep's home instead of ~/.jgrep (absolute path)
  JEV_BUDGET            default --budget in dollars (the flag wins)
  JEV_PRICE_PER_MTOK    dollars per million input tokens for --estimate, --budget and
                        the cost line when the provider reports none (default 0.042;
                        --budget warns when the provider bills more)
  JGREP_MAX_BYTES       default --max-bytes; JGREP_FOLLOW_SYMLINKS=1: --follow-symlinks
  NO_COLOR              plain output (also plain when stdout is not a terminal)

reliability
      --timeout <s>     per-batch deadline, retries included (default 15)
      --request-timeout <s>  per-attempt HTTP timeout (default 30; init, status: 15)
      --retries <n>     failed attempts tolerated per batch (default 4)
  -c, --concurrency <n> parallel requests (default 16)
      --rate <req/s>    global request pacing (token bucket); 0 = unlimited
      --fail-fast       abort on the first fatal error instead of isolating it

cost (no cap unless you set one)
      --estimate        dry run: requests, input tokens and cost; sends nothing and
                        needs no key (--funcs: pass 1, plus pass 2 as an upper bound)
      --budget <usd>    hard spend cap: each request reserves its estimated cost and
                        is not sent when it does not fit (every mode); 0 sends nothing

  -h, --help            print this help
  -v, -V, --version     print version

exit status: 0 when something matched, 1 when nothing did, 2 on error or when any
chunk errored (partial failure: hits and errors both reported; each failed chunk has a
typed kind and a hint on stderr). --estimate exits 0. In CI test for 1, never use !:
  jgrep --diff origin/main "adds an endpoint without an auth check"; [ $? -eq 1 ]

examples:
  jgrep "catches an error and silently ignores it" src/
  jgrep -C -t 0.9 "builds an SQL string by concatenation" .
  jgrep -a -t 0 "retries failed HTTP requests" src/ | head
  jgrep --funcs "parses command-line arguments" src/
  jgrep --diff --staged "leaves debug output such as console.log"
  jgrep --tag "real bug,best-effort cleanup" "swallows an exception" src/
  jgrep --json "spawns a child process" src/ | jq -r '.[].file'
  jgrep --rows examples/creators.csv "beauty is the main content of this account"
  jgrep --rows examples/creators.csv --questions examples/beauty.json --out scored.csv
  jgrep --follow-symlinks --max-bytes 5000000 "reads user input" .

use cases:
  find where X happens in an unfamiliar repo
      jgrep -C "validates the webhook signature" .
  triage a big diff or PR: rank the hunks, then label them
      jgrep --diff origin/main --tag "bug,refactor" "changes error handling"
  pick the tests to run in CI
      jgrep --tests origin/main | xargs bun test
  classify CSV / JSONL rows with typed questions
      jgrep --rows data.csv --questions q.json --out scored.csv
  cap spending: price the run first, then set a hard cap
      jgrep --estimate "<rule>" src/ && jgrep --budget 0.02 "<rule>" src/
  SARIF for code scanning in CI
      jgrep --diff origin/main --sarif "<rule>" > jgrep.sarif
  a local or Ollama System One server, no key, no code leaves the machine
      JEV_GATEWAY_URL=http://localhost:11434/v1/systemone \
        jgrep --provider compatible --model <name> "<rule>" src/
```

### Judging, cost controls, and machine-readable output

The `--help` screen gives each flag one line; these are the same flags in
full.

- `--group` prints one group per normalized (indent-aware) chunk signature —
  near-identical code at several sites is judged once — and, with `--json`,
  adds a `"groups"` array.
- `--votes N` (1–5, default 1) judges every chunk N times; the median probability
  wins.
- `--verify` re-asks every hit strictly; the hit stands only at
  `p >= 0.6 × threshold`.
- `--envelopes` appends each chunk's numbers (`[numbers: 42, 7]`) to the judged
  chunk text, steadying Jev's counting of quantities (off by default; cache keys
  stay keyed on the normalized chunk text, so an envelope re-run
  replays for free).
- `--estimate` and `--budget <usd>`: see [Cost](#cost).
- `--sarif` prints SARIF 2.1.0 instead of text: one rule per description, one
  result per hit (percent-encoded relative uri, or a `file://` uri for an
  absolute path, + region.startLine/endLine) — ingestible by GitHub code
  scanning.
- `--funcs` is two-phase **function navigation**: pass 1 packs ALL of a file's
  regex-extracted function/method/class signature lines into signature chunks
  (one for a normal file, several context-sized ones for a big file — never cut;
  a tree-sitter parse is a future upgrade — the regexes are the documented
  fallback) and judges those first, shortlisting a file when ANY of its
  signature chunks matches; pass 2 then runs the normal chunk
  search only on the files whose signatures matched, so the search cost tracks
  the shortlist instead of the whole tree. Files in unsupported languages (see
  `funcs.ts` for the extension map) and files with no extractable signatures are
  skipped in `--funcs` mode — pass 1 cannot shortlist what it never saw. A file
  whose signature request failed is reported as an error (exit 2) rather than
  silently left out, and the summary counts both passes' tokens and cost.
- `--tag "best-effort cleanup,real bug"` classifies the standing hits with one
  `choice` question per hit (batched like the search, at most 16 hits per
  request): the winning category prints after the `p` column (`[real bug]`) and
  rides on `--json` hit objects as `tag`/`tag_p`. It runs after `--verify`
  filtering, so tags only attach to hits that survived the gate. A failed tag
  batch never errors the run — those hits stay untagged (the annotation pass is
  never worth failing a search that already answered).

## How it works

1. **Files** come from `git ls-files` run inside each directory (untracked
   included, ignored excluded), or a directory walk. Binaries are skipped; there
   is no size limit unless you set `--max-bytes` (files over the 100 MB hard
   ceiling are always skipped and reported). Symlinks found while listing are
   skipped and reported unless `--follow-symlinks` (then each file is read once
   by its real path, directory loops are cut, and a link whose name or target
   looks like a secret — `.env*`, `*.key`, `*.pem`, `id_*`, `credentials`,
   `kubeconfig`, … — is still refused); a path you name on the command line is
   always followed, like `grep -r`.
2. **Chunks**: each file is split at column-0 line starts into 5 to 60 line
   pieces. Markdown files (`.md`/`.mdx`) are split at their headings instead,
   each chunk carrying its section trail (`jgrep > Help`) as context, and fenced
   code blocks are kept whole. With `--diff`, each hunk is a chunk and keeps
   its `+`/`-` markers. **Nothing is ever truncated to fit Jev's 32k-token
   context**: a chunk over 16 KB (a giant fence, hunk or minified line) is split
   at line boundaries with 3 lines of overlap (a single giant line by
   characters), every request is packed to stay under 40 KB, and a per-file
   verdict (`--funcs` pass 1, `--tests`, a `--rows` row judged in parts) takes
   the best part's answer (a `choice`: the best label that is not the catch-all,
   see `--default`).
3. **One request, up to 16 chunks, one question each**: `state.chunks[]` plus a
   Noul question per chunk, *"look only at chunk c3, does it match: …"*.
4. **Threshold**: probabilities at or above `-t` are printed in file order.
   Answers are cached by `(model, question, chunk)` in `~/.jgrep/cache.json`,
   so the same query again is free and instant.

| repo                         | chunks | time  | cost    |
| ---------------------------- | -----: | ----: | ------: |
| TypeScript CLI, `src/`       |    896 | 1.8 s | $0.010  |
| same query again (cache)     |    896 | 0.0 s | $0      |
| one module, `app/lib/`       |    521 | 1.6 s | $0.006  |

## Accuracy

How reliable is the matching? A benchmark harness — labeled fixtures (SMS spam,
AG News, hand-written code-selection cases) plus an accuracy runner — lives
under `bench/`, with the fixtures committed so every run is reproducible.
Latest results:

| benchmark              |   n | accuracy | macro-F1 |
| ---------------------- | --: | -------: | -------: |
| SMS spam vs ham        | 200 |     0.95 |     0.95 |
| AG News (4-way)        | 120 |     0.84 |     0.84 |
| Code selection (top-1) |  20 |     1.00 |        — |

Numbers above are **one provider's run** — OpenRouter, model
`~typesafe/jev-latest` — on 2026-09-20 at commit `1b3a4f9`, not a
cross-provider average. The bench runs **on demand** via the Bench workflow
(`workflow_dispatch`); TypeSafe numbers land here after the first CI bench run.

```bash
bun bench/accuracy.ts --fixture sms --limit 20   # precision/recall on 20 rows per class
```

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

### Live e2e (opt-in)

`src/e2e.live.test.ts` exercises the real OpenRouter path: 4 live calls — a
behavioral code query, a rows classification, the invalid-key error taxonomy,
and the `jgrep init` key check — costing about **$0.005** per full run.

```bash
JGREP_E2E_LIVE=1 bun test src/e2e.live.test.ts   # needs OPENROUTER_API_KEY
```

It never runs in CI: the suite is double-gated on the opt-in `JGREP_E2E_LIVE=1`
env var AND on `CI` being unset (GitHub Actions always sets `CI`), so no CI run
can trigger spend. Without the flag, `bun test` reports these tests as skipped.

### install-dev.sh

`install-dev.sh` is this fork's installer: it installs, inspects, and
uninstalls every flavor of the `jgrep` bin. End users run option `[8]` through
the curl one-liner in [Install](#install); the other options serve
development from a checkout.

Interactive menu (stable numbering — never renumbered):

```text
[1] local dev (symlink)   build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js
[2] local pinned (copy)   build current branch, copy snapshot
[3] fork main (copy)      build origin/main, copy         (fetch + git worktree in a tmpdir)
[4] upstream main (copy)  build upstream/main, copy       (fetch + git worktree in a tmpdir)
[5] npm stable            npm install -g jevgrep (upstream's published release)
[6] check only            autodetect report, no mutation
[7] uninstall jgrep       remove every detected install (npm/symlink/copy/brew-aware)
[8] fork install (remote/curl)   clone or update the fork at ~/.local/share/jgrep, then full setup (deps, build, bin, agent skill) — needs git + curl (bun is installed on demand)
[q] quit
```

Before the menu a `current:` line reports the detected install (type, path,
version) and the matching option is marked `[CURRENT]`; multiple installs
produce an explicit warning. Options that cannot run right now (bun missing,
remote mispointed) are shown as `[unavailable: …]` instead of `[AVAILABLE]`.

Headless / unattended mode — `--choice N` (or a bare `N`) runs one option with
zero prompts, everything auto-confirmed and deterministic exit codes;
`./install-dev.sh uninstall` is an alias for `--choice 7`; `--dry-run` prints
the would-be commands and mutates nothing; `--target DIR` installs into `DIR`
instead of the default chain (`$(npm prefix -g)/bin` → `/usr/local/bin` →
`~/.local/bin`); `check` prints the full autodetect report:

```sh
./install-dev.sh --choice 1            # build current branch + symlink, zero prompts
./install-dev.sh --choice 7 --dry-run  # preview the uninstall
./install-dev.sh --choice 8 --dry-run  # preview the remote/curl install ([8])
./install-dev.sh check                 # full report, no mutation
```

Fool-proofing, by design:

- **Identity-verified npm package** — before any `npm install`/`npm uninstall`
  the script verifies that `jevgrep` really is this project's package
  (`repository.url` must point at `github.com/kyu1204/jgrep`). npm also hosts
  an **unrelated** `jgrep` package ("Recursive grep."), and the name collides
  across GitHub — if `jevgrep` ever stops pointing at kyu1204/jgrep (takeover,
  hijack, registry mix-up) the script refuses loudly instead of installing or
  removing the wrong thing. No override. Options 3/4 verify the `origin`/
  `upstream` git remotes the same way; options 1/2 verify the checkout's
  `package.json` name.
- **Refuses to remove files that are not jgrep** — uninstall proves each entry
  (`--version`) before touching it, archives real files as `.bak` with a
  revert hint, never deletes the repo's `dist/jgrep.js` through a symlink, and
  leaves brew-owned files to `brew`.
- **Idempotent** — installing the same build again is a no-op ("already up to
  date"), and uninstalling with nothing installed prints "jgrep is not
  installed — nothing to do" and exits 0.
- **Agent-skill auto-refresh** — after a local install ([1]/[2]/[3]) the agent
  skill (`skills/jgrep/SKILL.md`) is refreshed too: the vercel `skills`
  installer (`npx -y skills@1.7.0 add ./skills -g -y`, pinned) updates every detected
  harness, falling back to `~/.agents/skills/jgrep` when the installer fails
  or is offline. Without this a dev-folder install would leave AI harnesses
  quoting stale flags (the skill embeds a verbatim copy of `jgrep --help`).
  Upstream-source installs ([4]) skip the refresh (no skill in that tree), and
  the refresh is best-effort — it never fails the install. The manual
  alternative is unchanged: `npx skills@1.7.0 add ./skills -g`.

The menu numbers are a stable contract: they will never be renumbered.

## Credits

jgrep was created by kyu1204 ([kyu1204/jgrep](https://github.com/kyu1204/jgrep),
npm `jevgrep`). This fork adds the multi-provider, reliability, budget and
roadmap work and merges upstream releases; the upstream project owns the npm
package and the GitHub Action.

If jgrep saved you a file-hunting session, a ⭐ on GitHub is the best thanks.

MIT
