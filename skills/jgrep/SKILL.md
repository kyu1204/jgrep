---
name: jgrep
license: MIT
compatibility: Requires Node.js 18+ (or Bun), git, and network access to the chosen provider API
description: >-
  Semantic grep for code. Use `jgrep` when you need to locate code by what it
  DOES rather than by an identifier you already know ("where do we retry
  failed requests", "code that swallows errors", "anything that shells out"),
  before opening many files to look for something, and as a cheap self-check
  of your own diff before committing. Returns file:line ranges with a
  probability, in about 2 seconds for a whole src/ tree. Keep using plain
  grep/rg for exact names and strings.
---

# jgrep

`jgrep "<description in English>" [paths]` asks a fast decision model (Jev, via
OpenRouter, TypeSafe, a compatible endpoint, Cloudflare, Vercel, or a local
mlx-decision server) one yes/no question per 5-60 line chunk and prints the
chunks that match. It never reads files into your context: you get a short list,
then you Read only the ranges you need.

## Setup

First run `command -v jgrep`. If it prints nothing, tell the user to install it
and stop; do not install it yourself. The user's install command:

```bash
curl -fsSL https://raw.githubusercontent.com/Emasoft/jgrep/main/install-dev.sh | bash -s -- --choice 8
```

Providers are listed in `~/.jgrep/providers.json`, in fallback order (no file:
openrouter, typesafe, compatible, cloudflare, vercel, then a local mlx-decision
server once `MLX_DECISION_URL` is set). Each entry's key is an env
var (`"api_key": "$OPENROUTER_API_KEY"`) or a literal key; a provider whose key is
unset is skipped, and a request that fails on a rejected key, no credits, a missing
model, a 429/5xx or a network error (never a malformed request) moves to the next
provider. `jgrep status` lists the chain and
each provider's state. Never put a key on the command line and never edit the
user's providers.json yourself: if jgrep reports "no provider is ready" or "No
<provider> API key found", tell the user (they export a key or run `jgrep init`)
rather than working around it. Errors are logged to `~/.jgrep/errors.log` (72 h).

## When to use it instead of grep or reading files

- You know the behavior, not the name: "validates the webhook signature",
  "builds the SQL string by concatenation", "catches and ignores errors".
- You would otherwise open 5+ files hunting for something.
- You want a second opinion on your own change: run it on the diff.

Do not use it for exact identifiers, strings, or paths. `rg` is free and instant.

## Commands

```
jgrep "description" src/                 # hits with p >= 0.7, file order
jgrep -t 0.85 "description" src/         # fewer, higher-precision hits
jgrep -C "description" src/              # print the matching chunk bodies
jgrep -a -t 0 "description" src/ | head  # everything, best first (when 0 hits)
jgrep --funcs "description" src/         # large tree: shortlist files by signatures first
jgrep --json "description" src/          # hits as a JSON array: [{file,start,end,p,text}]
jgrep --tag "real bug,needs review" "description" src/   # classify hits for triage
jgrep --diff --staged "rule"             # lint your staged change
jgrep --diff origin/main "rule"          # lint the branch against main
jgrep --tests origin/main | xargs bun test  # run only the tests a diff can affect
jgrep --estimate "description" src/      # price a run first; sends nothing
```

Spending has no cap unless one is set: on a big tree run `--estimate` first, and
pass `--budget <usd>` when the user gave you a spending limit.

## Help

`jgrep --help` prints the full reference — every flag, default, env var, exit
status, examples and use cases:

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
  failure moves the request on unless bad_request/circuit_breaker_open,
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

## Reading results

```
src/loop/state.ts:108-115  p=0.96  export function readRun(...)
```

`p` is the probability the chunk matches. Treat >= 0.9 as reliable, 0.7-0.9
as worth a look, below 0.5 as no. After a run, Read only the listed ranges
(`offset`/`limit`), not whole files. Exit 2 while hits still print means a
partial failure; the error breakdown and a hint per kind are on stderr.

## Writing the description

- English, one concrete behavior per query. Split compound questions.
- Describe the code, not the feature name: "decides whether to send an
  alert based on OCR confidence" beats "alert feature".
- Chunks are 5-60 lines seen in isolation, so cross-file flow ("does this
  eventually write to the DB") will not match; ask about the local code.

## Self-review before committing

Run 2-4 rules on the staged diff; each rule is one sentence about a mistake
you might have made. Exit 0 means a hit, so investigate those chunks.

```
jgrep --diff --staged "leaves debug output such as console.log or print"
jgrep --diff --staged "changes behavior without a corresponding test change"
jgrep --diff --staged "adds an endpoint or handler with no input validation"
```

In CI keep exit 1 (clean) apart from exit 2 (could not run): test `[ $? -eq 1 ]`,
never `!`, or an outage or an expired key passes the check.

## Which tests to run for a change

`jgrep --tests [ref]` prints the test files a diff plausibly affects (by name, by
import graph, then by Jev). Use it before running a large suite:
`jgrep --tests origin/main | xargs <runner>`; run the full suite afterwards.

## Tables, not code

`jgrep --rows data.csv "<description>"` treats every row as a chunk and prints
matching rows. With `--questions q.json` (a JSON object of Jev questions:
`{name: {type: noul|choice|score, instructions, criteria?}}`, a `choice`
question's `criteria` keyed by label) it writes the table back with one answer
column per question (`--out scored.csv`, or `--json` for the flattened answer
array). A row too big for one request is judged in parts; a choice then takes the
best label any part gives that is not the catch-all (the last criterion, or
`--default <label>`), else the catch-all at its best probability. Use it to label, triage or filter records instead of reading them one by one.

## Cache and cost

Answers are cached by (model, question, chunk) in `~/.jgrep/cache.json`, so a
re-run is free; an answer a fallback provider gave is cached under its own model.
Trailing whitespace, blank lines and line endings do not re-bill; any change in
content or leading indentation does. Cost is settled per request: the provider's
reported number, else input tokens × the entry's `usd_per_mtok` or
`$JEV_PRICE_PER_MTOK` (default $0.042 per million, output free).
`--budget` covers every mode and is as exact as the estimate (about 15%); with
`--funcs`, `--estimate` prints pass 1 and an upper bound for pass 2.

## Files jgrep reads

Any size up to a 100 MB hard ceiling (`--max-bytes N` sets a lower limit);
binaries are skipped. Symlinks found while listing are skipped and reported;
pass `--follow-symlinks` only when the user wants them (secret-looking links stay
refused). Nothing is truncated to fit Jev's context: big chunks are split and a
per-file verdict takes the best part. Run the installed `jgrep` (node), not
`bun src/cli.ts`, in an untrusted repo: under bun a compatible endpoint, a
provider pin or a jgrep home that came from the repo's `./.env` is refused.
