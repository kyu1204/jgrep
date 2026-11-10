---
trdd-id: 3KBUODCE
title: Configurable providers via providers.json
column: human_review
status: tasked
created: 2026-10-02T08:41:56+0200
updated: 2026-10-02T09:13:51+0200
current-owner: main-agent@jgrep
created-by: main-agent@jgrep
task-type: feature
min-approval-requirement: none
assignee: main-agent@jgrep
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@jgrep
approval-datetime: 2026-10-02T08:41:56+0200
implementation-commits: [929223b, 0bc40e4, fb87e8d]
---

# Configurable providers via providers.json

## Spec

Provider configuration moves into one user-owned file, `~/.jgrep/providers.json` (or `$JGREP_HOME/providers.json`), whose `providers` array is the priority and fallback chain. Same schema and behaviour as Quicksilver's `~/.quicksilver/providers.json` (Quicksilver TRDD-SKILHPWU); the example file is shared verbatim.

### User decisions (verbatim, 2026-10-02)

1. "make it configurable in a ~/.jgrep/providers.json  and ~/.quicksilver/providers.json configuration files"
2. "no, the keys must accept both the string of the actual key and the env var name. for example to configure openrouter: "api_key": "$OPENROUTER_API_KEY""
3. Adapters: "Both now" (Cloudflare + Vercel in both forks).
4. jgrep old key stores (~/.config/jgrep/*.key, legacy env file, project ./.env key lookup): "Keep them as extra fallbacks" (providers.json first, then old locations). Gateway URL/endpoint still never read from ./.env.
5. Config home: "Yes, one file per tool (Recommended)" — jgrep ~/.jgrep/{providers.json,cache.json}.
6. "you can also make that the order in which the providers are written in the providers.json providers array, is the exact order of priority and fallback of the providers. put the openrouter provider as the first, and typesafe as the second, and so on for the remaining ones. any change or addition to the providers will reflect the fallback in case of errors, exhausted credits, or missing env var."
7. "yes. and for errors a log must be updated (truncated at 72 hours) in ~/.jgrep/errors.log and ~/.quicksilver/errors.log . note that simple absence of env var when scanning the providers must not be considered error. Also add to each provider entry in the providers.json array a "enabled": "true|false" field, to disable a provider if the user wants to. make sure to accept also equivalent values (true=enabled,true,1,yes,active,on,etc..; false=disabled,false,0,no,inactive,off, etc.)"

### Home

- `$JGREP_HOME` (must be absolute) or `~/.jgrep`: `providers.json`, `cache.json`, `errors.log`. Directory 0700, files 0600, every write temp file + rename.
- Never read from the working directory, a project directory or `./.env`. Under Bun, a `JGREP_HOME`, `JEV_API`, `JEV_GATEWAY_URL` or `JGREP_ENDPOINT` value that Bun loaded from `./.env*` is refused.
- The cache moves from `~/.cache/jgrep/cache.json` (or `$XDG_CACHE_HOME/jgrep`) to `~/.jgrep/cache.json`. No migration: when the old file exists and the new one does not, the CLI prints once that the old file is no longer used and can be deleted. It is never deleted by jgrep.

### File and schema (version 1, identical to Quicksilver)

```json
{ "version": 1, "providers": [ { "name": "openrouter", "api_key": "$OPENROUTER_API_KEY" }, { "name": "typesafe" } ] }
```

- Top level: `version` (must be 1) and `providers` (array). Any other key is an error.
- Chain: when the file exists, EXACTLY its entries, in file order; a built-in the file does not name is never appended. An entry whose name is a built-in takes that built-in's fields as defaults, overridden field by field; any other name must give `base_url`, `path`, `adapter`, `api_key` and `model`. No file: the built-ins in order openrouter, typesafe, compatible, cloudflare, vercel, mlx (a local mlx-decision server via `MLX_DECISION_URL`, last: the offline elephant-1 fallback).
- Entry fields (unknown field = error): `name` (`^[a-z][a-z0-9-]{1,31}$`, unique), `enabled`, `base_url`, `path`, `adapter`, `api_key`, `account_id`, `model`, `model_pattern`, `cost_field`, `usd_per_mtok`, `verify`, `headers`, `key_url` — same rules as Quicksilver:
  - `enabled`: absent = enabled; JSON true/false, 1/0, case-insensitive true/enabled/enable/1/yes/y/active/on and false/disabled/disable/0/no/n/inactive/off. Anything else is an error naming the provider and the value.
  - `base_url`: https, or http only to localhost/127.0.0.1/[::1]; no credentials, query or fragment.
  - `path`: starts with `/`; the only placeholder is `{account_id}`.
  - `adapter`: `system-one` | `cloudflare-ai-run` | `vercel-evaluation` (closed set, in code).
  - `api_key`: string or array; `$NAME` / `${NAME}` reads the process environment, any other non-empty string is the literal key; first set value wins.
  - `account_id`: same forms; required when `path` holds `{account_id}`; resolved value `^[A-Za-z0-9]{1,64}$`.
  - `model` (base rule `^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,127}$`, must match `model_pattern`), `model_pattern` (regex: `--model` / `JEV_MODEL` / `JGREP_MODEL` are used for a provider only when they match, else its own `model` with a warning).
  - `cost_field` (dotted path to the reported USD cost, or null), `usd_per_mtok` (price for that provider's requests when no cost is reported, or null), `verify` (path of a free GET key check, or null), `headers` (static, non-secret: authorization, cookie, proxy-authorization, x-api-key and any name ending in -key or -token refused), `key_url` (https URL for hints).
- A custom entry on a known provider host (a built-in's default host, or the host the file gives a built-in) inherits that provider's `verify` unless it sets `verify` itself.
- Security (exit 2, jgrep's error exit, naming the file and field): malformed JSON reports only line and column, never the parser message; a literal `api_key` in a file that group/others can read, or that another user owns, is refused with the exact `chmod 600` fix; one `$VAR` may be referenced by at most one enabled provider; a literal key is never printed (status shows the variable or "literal in providers.json"); upstream text echoed in an error has the key redacted; every request uses `redirect: "error"`.

### Built-ins (jgrep)

| name | base_url / path | adapter | api_key | model / pattern | verify |
|---|---|---|---|---|---|
| openrouter | https://openrouter.ai/api /v1/systemone | system-one | $OPENROUTER_API_KEY | ~typesafe/jev-latest, `/` | /v1/key |
| typesafe | https://api.typesafe.ai /v1/systemone | system-one | $JEV_API_KEY, $TYPESAFE_API_KEY | jev-latest, `^[^/]+$` | /v1/models |
| compatible | (none) /v1/systemone | system-one | $JEV_GATEWAY_API_KEY | jev-latest | null |
| cloudflare | https://api.cloudflare.com/client/v4 /accounts/{account_id}/ai/run | cloudflare-ai-run | $JEV_CLOUDFLARE_API_TOKEN, $CLOUDFLARE_API_TOKEN; account $CLOUDFLARE_ACCOUNT_ID | typesafe/jev, `^typesafe/` | /user/tokens/verify |
| vercel | https://ai-gateway.vercel.sh /v4/ai/evaluation-model | vercel-evaluation | $AI_GATEWAY_API_KEY | typesafe-ai/jev, `^typesafe-ai/` | null |

- `compatible` replaces jgrep's `gateway` (same env vars). Without a `base_url` in the file it takes the FULL endpoint from `JEV_GATEWAY_URL` (alias `JGREP_ENDPOINT`, process env only) or the legacy `~/.config/jgrep/env`; never from `./.env`.
- A provider whose resolved URL is loopback http needs no key (local System One server, upstream #19): no Authorization header is sent.
- Cost: `cost_field` unset keeps jgrep's reported-cost lookup (`cost`, `usage.cost`, `cost_usd`); with no reported cost, `usd_per_mtok` when set, else `JEV_PRICE_PER_MTOK` (default 0.042).

### Keys (per provider, first hit wins)

1. `api_key` from providers.json (`$VAR` from the process environment, or the literal).
2. Old stores, kept as fallbacks (user decision 4): `~/.config/jgrep/<name>.key` (`gateway.key` for compatible), then each `$VAR` name of `api_key` in the legacy `~/.config/jgrep/env`, then in `./.env` of the project (warning when that .env is not gitignored).
An unset key is not an error and is never logged: the provider is skipped.

### Chain behaviour

- Skipped silently: disabled, no URL, no key, no account id.
- `--provider NAME` (replaces `--api`) or `JEV_API=NAME` pins one provider: no fallback. Unknown or disabled = error; pinned with no key = error naming every variable and file tried. Errors are raised at the first request, so `--estimate` and fully cached runs need no key.
- Per request, the provider failing with a rejected key (401/403), no credits (402), unavailable model, rate limit / 5xx / network / timeout after its retries, TLS error or an unusable reply hands the request to the next provider, and the failed provider is skipped for the rest of the run (circuit breaker). Until a provider has answered once, the run's other requests wait for that first request, so a dead key costs one request. OpenRouter's per-request 403 (moderation) falls back for that request only. A request-shape error (400/422) never falls back.
- When every provider fails, the batch error lists each provider's failure; a key/credit failure among them is the reported kind.
- The run summary names the providers and models that answered and every fallback with its reason, when the chain moved.
- A fallback answer is cached under the model that produced it.
- `jgrep status` lists the chain in order with each entry's state: disabled, key missing (variables tried), account id missing, not configured, ready (free check passed), rejected, no credits, unreachable, check failed, or "key present (not verified)" when the provider has no free check. Exit 0 when one provider is usable, else 2.

### errors.log

`$JGREP_HOME/errors.log`: one line per provider error event — ISO timestamp with offset, `jgrep/<version>`, provider, model, kind, HTTP status, fallback target (or `no` / `none-left`), message (key redacted) and hint. Entries older than 72 hours are dropped on every write; the file is rewritten atomically, 0600. A missing variable is never logged. A failed write prints one stderr warning per run and never breaks the run.

### Adapters

As Quicksilver: `system-one` POST `{model, state, questions}`; `cloudflare-ai-run` POST `{model, input:{state, questions}}`, v4 envelope, `success:false` or a run state other than Completed is an unusable reply, payload `result.result`; `vercel-evaluation` POST `{state, questions}` (noul as boolean; type, instructions, criteria kept), model in the `ai-model-id` header plus the three gateway headers, boolean answers mapped back to noul, confidence from `providerMetadata.typesafe.confidence`, camelCase usage. Both used by `postSystemOne` and `verifyApiKey` (a provider with no free check is verified by `jgrep init` with a one-question ping through its adapter).

### jgrep init

Writes `~/.jgrep/providers.json` (0600 in 0700, atomic): picks a provider (openrouter default), asks the endpoint for compatible and the account id for cloudflare when unset, keeps an existing key or verifies a pasted one, stores it as a literal `api_key` on that entry (or keeps `$VAR`), and offers to move the entry to the front of the chain. With no file yet it writes every built-in by name first. Old key stores are never written.

### Example file

`providers.example.json` at the repo root (shipped in the npm package): identical content to Quicksilver's `skills/quicksilver/providers.example.json`.

## Approval log

- 2026-10-02T08:41:56+0200 — MANDATE issued by main-agent@jgrep (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Implementation notes

- 2026-10-02: implemented in 929223b (feature), 0bc40e4 (README, CHANGELOG), fb87e8d (coordinator correction: a choice judged in parts takes the label with the highest probability in any part). Cache lookups accept any model of the chain, the head's first, so a dead first key does not re-bill every run (answers are still written under the model that gave them). A missing key is named before a missing account id (Quicksilver's order). Test runs use a bunfig preload: own empty JGREP_HOME, provider keys cleared unless JGREP_E2E_LIVE=1. Not done here: live Cloudflare and Vercel checks (no credentials exported); their e2e tests are gated on CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_API_KEY.
