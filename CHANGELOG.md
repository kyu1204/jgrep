# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Configurable providers: `~/.jgrep/providers.json`** (TRDD-3KBUODCE), the same
  format as Quicksilver's `~/.quicksilver/providers.json`. Its `providers` array is
  the fallback chain: the first provider whose key is set takes each request, and a
  rejected key, no credits, an unavailable model, or a 429/5xx/network failure after
  retries moves the request to the next one (never a 400/422). When the file exists
  the chain is exactly its entries; without it, the built-ins in order openrouter,
  typesafe, compatible, cloudflare, vercel, mlx. `api_key` is `"$VAR"`, `"${VAR}"`, a
  literal key (the file must then be `chmod 600`) or an array; `"enabled"` accepts
  true/false and yes/no, y/n, on/off, 1/0, enabled/disabled, enable/disable,
  active/inactive (any case), anything else is a config error; every field is
  validated strictly. Example: `providers.example.json` (shipped).
- **`mlx`: a local mlx-decision server as the last fallback** (elephant-1). It
  speaks the System One request and answer, so no adapter was needed; it needs no
  key on loopback and costs nothing. `MLX_DECISION_URL` (process environment only,
  never `./.env`) gives its base URL — a full `/v1/systemone` URL works too — and
  with the variable unset the entry is `no-url` and skipped, so a machine not
  running the server behaves exactly as before. jgrep never starts the server
  (`mlx-decision server -m baselabs/elephant-1`): one per machine, ~15 GB of RAM,
  often shared with other tools.
- A failed provider is skipped for the rest of the run, and until a provider has
  answered once the run's other requests wait for it (a dead key costs one
  request). The run ends with a `fallback:` line when it moved, and every provider
  error is logged to `~/.jgrep/errors.log` (keys masked, entries older than 72 h
  dropped on each write). A fallback answer is cached under its own model.
- Cloudflare Workers AI (`cloudflare-ai-run`) and the Vercel AI Gateway
  (`vercel-evaluation`) adapters, as built-in providers `cloudflare` and `vercel`.
- `jgrep status [--provider NAME]`: the chain in order and each provider's state,
  from the free key checks only (OpenRouter `/api/v1/key`, TypeSafe `/v1/models`,
  Cloudflare `/user/tokens/verify`); a provider without one shows "key present (not
  verified)", never "ready".

- `--follow-symlinks` / `JGREP_FOLLOW_SYMLINKS=1`: follow symlinks found while
  listing (deduped by real path, directory loops cut, secret-looking link names or
  targets still refused). Default: skipped and reported.
- `--max-bytes N` / `JGREP_MAX_BYTES`: an opt-in per-file size limit. There is no
  default limit any more (the silent 1 MB skip is gone); a 100 MB hard ceiling
  cannot be raised (a larger value exits 1). Over-limit files are reported.
- `jgrep init --request-timeout <s>`.
- Error kind `forbidden` (OpenRouter 403: moderation or model permission; per
  chunk, never trips the breaker).
- `--budget` warns when the provider bills more per token than
  `JEV_PRICE_PER_MTOK` (the reservation price).
- **`--default <label>`**: names the catch-all category of `--tag` or of a
  `--rows --questions` choice (default: the last category; an unknown label, or no
  categories at all, exits 1). A choice judged in parts follows the USER's rule
  "Best real evidence wins": a part votes only when its top label is not the
  catch-all; the voting part with the highest probability decides the label and is
  reported; with no vote the row gets the catch-all at its best probability. This
  replaces the per-label maximum, under which many confident catch-all parts
  outvoted the one part that held the evidence. A single part is unchanged; noul
  and score keep the max over the parts. `--default` is part of the rows cache key.

### Changed

- `jgrep init` writes `~/.jgrep/providers.json` (0600 in a 0700 home, atomic): the
  pasted key as the provider's literal `api_key`, the compatible endpoint, the
  Cloudflare account id, and optionally the provider first in the chain. It no
  longer writes `~/.config/jgrep/<name>.key`, the legacy env file or `./.env`;
  those are still read, after providers.json, as key fallbacks.
- `--api` is now `--provider` (the benches too); `JEV_API` still pins. The `gateway`
  provider is now `compatible` (same `JEV_GATEWAY_URL` / `JEV_GATEWAY_API_KEY`; its
  old `gateway.key` file is still read). An OpenRouter key no longer jumps the queue:
  the order of providers.json decides, and openrouter comes first in the built-in
  order. TypeSafe also reads `JEV_API_KEY` (before `TYPESAFE_API_KEY`).
- jgrep's home is `~/.jgrep` (`$JGREP_HOME` for tests): the cache moved from
  `~/.cache/jgrep/cache.json` (or `$XDG_CACHE_HOME/jgrep`) to `~/.jgrep/cache.json`.
  The old cache is not migrated or deleted; jgrep says once that it can be deleted.

- Nothing is truncated to fit Jev's context any more: oversized chunks (giant
  fences, hunks, minified lines) are split with overlap, requests are packed under
  a byte budget, `--funcs` keeps every signature (no 200-signature / 8000-char
  cut), `--tests` sends the whole diff and whole signatures in parts, and an
  over-context `--rows` row is judged in parts. Per-file verdicts take the best
  part (noul/score: highest; choice: "Best real evidence wins", see `--default`).
- `--estimate --funcs` prices pass 1 exactly and pass 2 as an upper bound (text
  and `--json` `upper_bound`) instead of the plain search.
- Run cost totals settle every request like the budget meter (reported cost, else
  tokens × price), so intermittent cost reporting is not undercounted.
- `--model`, `$JEV_MODEL` and `$JGREP_MODEL` apply to each provider whose ids they
  fit (`model_pattern`); the others keep their own model, with a warning.
- A failed cache save warns once.
- `git ls-files` runs inside each listed directory (a directory in another repo
  than the cwd was silently walked without .gitignore); other ls-files failures
  are reported once.
- The `skills` installer is pinned (`skills@1.7.0`) in `jgrep init` and
  install-dev.sh; install-dev.sh installs a missing bun without asking only with
  an explicit `--yes`.

### Fixed

- `--help` is built from the constants the code uses (defaults, limits, built-in
  providers and their key variables, adapters, the `enabled` words, exit codes), and
  the help blocks in README.md and SKILL.md are regenerated from it
  (`bun run sync-docs`); tests fail when the accepted options or the env vars read
  differ from the ones `--help` names, or when the docs mention one that does not
  exist. Drift fixed on the way: `jgrep status` also takes `--request-timeout`
  (default 15, like `jgrep init`); the cloudflare key is `JEV_CLOUDFLARE_API_TOKEN`
  first, then `CLOUDFLARE_API_TOKEN`; a timeout, network, TLS, 403 or malformed
  answer also moves a request to the next provider; the `enabled` error message
  listed only some of the accepted words; `--help` now states that `--default` with
  an unknown label exits 1.
- `--tests` ignored `--budget` / `$JEV_BUDGET`.
- A failed request the provider likely billed (malformed 200, timeout, 5xx) now
  keeps its budget reservation as spend.
- OpenRouter's 400 "Model X does not exist" is `model_unavailable`; error
  messages carry the body's `error.message` (no `user_id` in output); a long
  `Retry-After` reports `rate_limited` instead of `timeout`; the credits hint never
  names the provider already in use; redirects are never followed.
- `--diff` / `--tests` decode git's quoted and TAB-terminated `+++` paths.
- `--tests` no longer treats README/data files under `tests/` as tests, and keeps
  changed lines such as `+--flag`.
- votes=1 cache reads require a finite number.
- `jgrep init`: a valid OpenRouter key on an empty account (402) can be saved, a
  network failure is "unverified", not "rejected".

### Security

- install-dev.sh option 8 resets only a clone it created (marker), whose origin is
  exactly the fork, with no uncommitted changes, on `main`.
- Symlinks are not followed by default (a tracked link could send a file outside
  the repo to the provider).
- Under bun, `JGREP_HOME` / `JEV_GATEWAY_URL` / `JGREP_ENDPOINT` / `JEV_API`
  values that came from an auto-loaded `./.env*` are refused (run the bin under node).
- providers.json is read only from jgrep's home; a literal key in a file others can
  read is refused with the `chmod 600` fix; parse errors never quote the file; one
  `$VAR` may belong to one enabled provider only; keys are redacted from echoed
  provider text and errors.log. The `.env` gitignore check uses `git check-ignore`.
- The test suite runs with its own empty jgrep home and without provider keys
  (`bunfig.toml` preload), so no test reads the user's providers.json or sends
  code to a real provider.
- SARIF URIs are percent-encoded; terminal output strips control characters; CSV
  output neutralises formula-looking cells.
- Workflows: least-privilege CI token, actions on their latest majors pinned to
  commit SHAs, `persist-credentials: false`, `inputs.limit` validated, npm pinned.

## [0.7.0] - 2026-10-02 — roadmap completion (issue #1: WI-2, WI-3, WI-4, WI-5, WI-6, WI-7, WI-9, WI-10) and upstream v0.6.0 sync

Completes the deferred roadmap of
[Emasoft/jgrep#1](https://github.com/Emasoft/jgrep/issues/1): every remaining
work item is implemented. [0.4.0](#040---2026-09-20--providers-reliability-isolation-benchmarks-issue-1-wi-1-wi-8-wi-11-wi-12)
shipped WI-1 (multi-provider), WI-8 (error taxonomy), WI-11 (partial-failure
isolation), and WI-12 (benchmarks); markdown chunking ships here too.

### Documentation

- `jgrep --help` rewritten: short usage, flags grouped by purpose (search,
  input and chunking, output, modes, provider and keys, environment,
  reliability, cost), every env var the code reads (`JEV_*`, `JGREP_ENDPOINT`,
  `JGREP_MODEL`, the three key vars, `NO_COLOR`), exit codes, 14 runnable
  examples and a use-case list. Every flag `parse()` accepts is listed, `-h`
  and `-V` included; the help-length test cap moves from 60 to 140 lines.
- Keys come from the environment: help, README and skill lead with exporting
  `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` (or `JEV_GATEWAY_API_KEY`) in the
  shell profile; no example carries a key; `jgrep init` is documented as the
  fallback for users without an env var.
- README: install leads with the fork's curl one-liner; new Examples, Use cases
  and Cost sections (`--estimate`, the opt-in `--budget` reservation cap and its
  estimator-accuracy ceiling); provider auto-selection order; cache semantics
  under its own heading; `budget_exhausted` in the error table; states that the
  fork is never published to npm (`"private": true`, publish workflow
  upstream-only); the CI recipe installs the fork; upstream credit section.
  The `install-dev.sh` section no longer tells end users to use npm.
- Agent skill (`skills/jgrep/SKILL.md`): help block regenerated, setup reduced
  to "check `command -v jgrep`, keys from the env", examples updated (`--funcs`,
  `--estimate`, `--budget`), README duplication removed (358 → 261 lines). The
  same file ships through `jgrep init`, `install-dev.sh` and the Claude Code
  plugin.
- Test fixtures use the valid pinned OpenRouter id `typesafe/jev-1.13` (the
  `~` prefix is for OpenRouter's `-latest` aliases only).

### Synced from upstream (kyu1204/jgrep v0.5.0–v0.6.0)

- `--estimate`: prints requests, input tokens and cost a run would need (code, `--diff`, `--rows`, `--tests`), exits 0, sends nothing and needs no key; `--json` prints `{requests,tokens,usd,estimate:true}`. Cost uses `JEV_PRICE_PER_MTOK`.
- `--tests`: type-test suffixes (`.tst.ts`, `.test-d.ts`, `_test.ts`), dynamic `import()` and `export … from` in signatures, and package-root selection (tests importing the package by name or `../src` are selected in code when the package entry file changes; reason `package`).
- `--tests` now isolates failures per batch like the other modes: a failed batch becomes per-test errors (exit 2, hints on stderr) instead of rejecting the run, a partial 200 is `malformed_response` instead of a `p:NaN` entry, `--fail-fast` and the circuit breaker apply, and the cache is saved in a `finally`.
- OpenRouter moved to the stable `https://openrouter.ai/api/v1/systemone` path; the billed startup probe and `--no-probe` are gone (the first batch's typed error already distinguishes a bad key, no credits and transient failures).
- OpenRouter app-attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-Title: jgrep`, `X-OpenRouter-Categories`) are sent to openrouter.ai only; TypeSafe and gateways no longer get `X-Title`.
- Gateway: a loopback `http://` server (e.g. a local Ollama System One endpoint) needs no key and is auto-selected; a remote gateway must be `https://`. `JGREP_ENDPOINT` / `JGREP_MODEL` are accepted as aliases of `JEV_GATEWAY_URL` / `JEV_MODEL` (process env only, never `./.env`).
- `~/.agents/skills/jgrep` that is a symlink (old dev installs) is replaced by a real dir instead of copying through it.
- Claude Code plugin manifest (`/plugin marketplace add Emasoft/jgrep`), release-on-merge publish workflow (still upstream-only), `bench/tests` harness and results, README/skill CI recipe that keeps exit 2 distinct from exit 1.

### Added

- **`--group`** (WI-3): chunks sharing a normalized (indent-aware) signature are
  near-identical boilerplate — the first is judged, siblings inherit its
  verdict (exactly one question for the whole family), and `--group` prints
  one group per signature (representative body + sites; `--json`/`--json-errors`
  gain `groups[]`).
- **`--tag <list>`** (WI-4): classify the standing hits — one `choice` question
  per hit (at most 16 per request), categories given comma-separated. The
  winning category prints after the `p` column (`[real bug]`) and rides on
  `--json` hit objects as `tag`/`tag_p`. Runs after `--verify` filtering; a
  failed tag batch never errors the run — those hits stay untagged.
- **Verification cascade** (WI-2): `--verify` re-asks every hit with strict
  instructions and keeps it only at `p >= 0.6 × threshold` (fail-open when the
  verify batch itself fails); `--votes <n>` (1–5) judges every chunk n times
  and the MEDIAN probability wins, with per-vote cache keys.
- **`--funcs`** (WI-5): two-phase function navigation — pass 1 packs all of a
  file's regex-extracted function/method/class signature lines into one
  signature chunk per file (tree-sitter is a future upgrade; the regexes are
  the documented fallback) and judges those first; pass 2 runs the normal
  chunk search only on the shortlisted files. Files in unsupported languages
  and files with no extractable signatures are skipped. A file whose
  signature request failed is reported as an error (exit 2), pass-1 tokens and
  cost are counted in the summary, and both passes share one `--budget`.
- **Cost controls & SARIF** (WI-7): `--estimate` text output gains a per-file
  chunk table above the estimated requests/tokens/cost line (one dry-run
  implementation for every mode, see the upstream entry above); `--budget <usd>` is an opt-in hard spend
  cap (no cap unless set; `JEV_BUDGET` env form): every request reserves its
  estimated cost before it is sent, a request that does not fit is never sent
  (its chunks error `budget_exhausted`), and the response replaces the
  reservation with the real cost — so concurrent workers can no longer
  overshoot the budget by a whole wave of requests, and `--rows` now honours
  it too (it used to ignore it); `--sarif` prints SARIF 2.1.0
  ingestible by GitHub code scanning.
- **`--envelopes`** (WI-9): appends each chunk's numbers (`[numbers: 42, 7]`)
  to the judged text, steadying Jev's counting of quantities; off by default,
  and envelope/non-envelope runs share one cache.
- **Cache hardening** (WI-6): keys hash the normalized chunk text (trailing
  whitespace, blank lines and line endings no longer re-bill; leading
  indentation is kept, so differently indented code is never served another
  block's verdict — the in-run `--group` signature follows the same rule and
  also includes the markdown section; old raw-text keys miss once and
  re-bill, no migration code), saves are atomic (temp file + rename, so
  concurrent processes never see a half-written cache), and the cache is
  capped at 10,000 entries with oldest-first eviction (v1 envelope with an
  insertion-order list).
- install-dev.sh: remote/curl install path — `curl -fsSL https://raw.githubusercontent.com/Emasoft/jgrep/main/install-dev.sh | bash -s -- --choice 8` (new menu `[8]`, appended, never renumbered) clones or updates a script-managed fork clone at `~/.local/share/jgrep` (`JGREP_DEV_DIR` overrides the location), then runs the full local setup (deps, build, system-wide bin symlink, agent-skill refresh), autodetects and replaces previous installs with `.bak` archival exactly like option 1, and auto-installs bun when missing (node stays a runtime requirement); the interactive menu refuses through a pipe (exit 2 with the two documented one-liners), and the fork can never publish npm (`publish.yml` now runs only in the upstream `kyu1204/jgrep` repo).
- markdown-aware chunking: .md/.mdx files split at headings with section-trail
  context; fenced code blocks never split — sub-section extraction via
  -C/--json start-end.
- Fork publish lock: `package.json` is `"private": true` (npm refuses to
  publish the fork; GitHub, curl and bun installs are unaffected), and
  `src/workflows.test.ts` fails CI if any job in `.github/workflows/publish.yml`
  does not start its `if:` with `github.repository == 'kyu1204/jgrep'` — the
  `jevgrep` package belongs to upstream.

### Fixed

- `--batch 0` or a fractional `--batch` (e.g. `-b 1.5`) is rejected by the CLI ("batch must be a positive integer"); library callers get the value floored and clamped at 1 — `+= 0` used to spin the batching loop forever and a fraction overlapped batches.
- rows mode, single description: `--out` now writes a CSV of the shown hits (`row,p,<answer columns>`) instead of being a silent no-op; `--json --out` still writes JSON; stdout keeps the pretty output.
- Per-chunk/per-row errors carry the provider error's `hint`: rendered as a grey indented line under each stderr example and included in `--json-errors` objects (hints previously surfaced only on fatal throws).
- A 200 response that answers only some chunks records the unanswered ones as `malformed_response` errors — they no longer appear as `p:NaN` entries in `all` with no error and no cache entry.
- rows mode `requests` no longer counts packs the circuit breaker never attempted.
- `JEV_PRICE_PER_MTOK` is validated right after provider resolution (both modes) — an invalid price can no longer surface only after the run has billed tokens.
- install-dev.sh: `check` and choice 6 never create the target directory (a missing `~/.local/bin` was mkdir'd under "no mutation").
- The gateway 402 hint drops the "top up credits at …" clause when the provider has no billing URL ("insufficient credits on the gateway provider").
- Reliability: expired waiters are evicted from the rate limiter without consuming a token, and the per-batch deadline is monotonic with a fail-fast settlement guard.
- Removed dead code: the redundant unreachable-codes branch in `classifyTransport` (identical fallthrough) and the unused `installSkills` (superseded by init's universal skill installer).
- Docs: README now says code-mode `--json` is byte-identical to 0.3.0 while rows mode is a flattened answer array; the bench `--limit` note reads "rows per class"; the Bench workflow input says "Rows per class / cases"; the `--help` init line reads "(provider, key, agent skills)".
- CI runs the bench unit tests too (`bun test src/ bench/`).
- `--rate` pacing: queued waiters whose batch deadline lapses are evicted from the rate-limiter queue and fail with `timeout` **without consuming a token**; limiter errors name the provider.
- Node runtime: `AbortSignal.timeout` received fractional millisecond budgets (from the monotonic-deadline conversion) and threw `RangeError` on every batch when run under node — all computed delays are now integers (the CI node-smoke and installed-bin runs are clean).

## [0.4.0] - 2026-09-20 — providers, reliability, isolation, benchmarks (issue #1: WI-1, WI-8, WI-11, WI-12)

### Added

- **Multi-provider layer**: `typesafe`, `openrouter`, and `gateway` (any System One-speaking endpoint, e.g. LiteLLM) speak the same protocol. Pick with `--api`, `$JEV_API`, or let jgrep find a key (typesafe first). `--model` / `$JEV_MODEL` override the model id; `JEV_GATEWAY_URL` + `JEV_GATEWAY_API_KEY` point at a self-hosted gateway.
- **Key chain**, per provider: env var > `~/.config/jgrep/<name>.key` (written 0600) > the legacy `~/.config/jgrep/env` > `./.env` in the project — with a warning when the `.env` key is not covered by `.gitignore`. `chmod 600` is a no-op on Windows; init warns there too.
- **Reliability engine**: full-jitter exponential backoff (500 ms base, 30 s cap), provider `Retry-After` honored (capped at 5 min), transport-error retries (`ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`/`EAI_AGAIN`), `--retries` (default 4 → 5 attempts), `--request-timeout` (30 s per attempt), `--timeout` (15 s per-batch deadline including retries), `--rate REQ/SEC` token-bucket pacing, `--fail-fast`, and an OpenRouter-only startup probe (`--no-probe` skips it; removed again in the upstream sync).
- **Error taxonomy**: failures surface as one of 10 typed kinds — `insufficient_credits`, `invalid_api_key`, `model_unavailable`, `rate_limited`, `bad_request`, `malformed_response`, `server_unreachable`, `tls_error`, `timeout`, `circuit_breaker_open` — each with an actionable hint; `invalid_api_key` distinguishes a key that worked earlier this run (expired/revoked) from one that never worked.
- **Partial-failure isolation**: a failed batch marks only its chunks in `errors[]` and the run continues; answers already paid for stay in the cache; exit code is 2 when any chunk errored. A circuit breaker aborts after 3 consecutive fatal failures and reports untouched chunks as `circuit_breaker_open`.
- `--json-errors` (implies `--json`): opt-in object shape `{hits, errors}` (code) / `{answers, errors}` (rows) including per-row/per-chunk typed errors.
- **Cost**: the provider's reported number when it sends one (OpenRouter), else `tokens × $JEV_PRICE_PER_MTOK` (default `0.042` per Mtok).
- **Per-provider `jgrep init`**: pick the provider first, verify the key against it, then choose where to store it (per-provider key file, legacy env file, project `.env`, none).
- **Agent-skill install** via the vercel `skills` universal installer (`npx skills add`, every agent harness), falling back to `~/.agents/skills/jgrep`.
- **Benchmark harness**: `bench/accuracy.ts` (SMS spam + AG News) and `bench/code_selection.ts`, with fixtures committed so runs are reproducible; executed on demand by the `workflow_dispatch` Bench workflow.
- **Published accuracy numbers** (OpenRouter, `~typesafe/jev-latest`): SMS 0.95, AG News 0.84, code selection 1.00.
- install-dev.sh: dev-only interactive setup script; --choice N runs menu actions unattended for headless dev boxes (not shipped in the npm package); detects installed type/path ([CURRENT] markers), full uninstall (npm/symlink/copy/brew-aware, identity-verified, idempotent), npm/GitHub identity pinning (jevgrep ↔ kyu1204/jgrep); auto-refreshes the agent skill after local installs

### Changed

- `--json` output shape unchanged from 0.3.0 (bare array; rows entries position-aligned, errored rows `null` — no longer a run-fatal condition).
- Cache keys are model-scoped: queries against a different model (openrouter's `~typesafe/jev-latest`, any `--model` override) get their own entries and re-bill once on the first run.
- Rows and agent-skill docs updated; the bundled `skills/jgrep/SKILL.md` is rewritten around the v0.4 flags with the full `--help` screen embedded.

### Fixed

- The success-path response parse now runs inside the request timeout (the old code read the body after the abort signal had expired).
- A provider `Retry-After` header is no longer ignored.
- One failing batch no longer loses the whole run's results or cache.
- Doc: the agent example pipes `--json` through `jq '.[].file'`, matching the array shape (was `jq '.hits[].file'`).

### Security

- API keys are written with mode 0600 (per-provider key files and the legacy env file).
- A key loaded from `./.env` that is not gitignored warns on stderr.
