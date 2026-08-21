# telegram-translation-ptbr-ja

A Telegram bot that translates between Japanese and Brazilian Portuguese
in a family group chat, aiming to keep tone, emoji, names, and forms of
address natural in both directions.

## Current status: Phase 8A deployment preparation complete — bot not deployed

This repository currently contains project conventions, documentation, a
Worker with `GET /health`, `POST /telegram/webhook`, and
`POST /admin/bootstrap` boundaries, CI/test tooling, a vendor-independent
domain/config/error layer, a pure Telegram Update parser, a locally
tested D1 migration/repository layer, a mockable Telegram `sendMessage`
client, a full OpenAI translation pipeline (versioned prompt, Structured
Outputs client, timeout + capped transient-only retry, and the
translate-and-reply application use case), speaker memory
(per-`(chat_id, user_id)` auto-observed style, explicit preferences, and
short term corrections, resolved explicit-over-observed and folded into
the OpenAI prompt without a second API call), and the full command
surface — `/help`, `/status`, `/profile`, `/remember`, `/forget`,
`/forgetme`, `/correct`, and admin-only `/enable`/`/disable`
(`src/commands/`, `src/application/execute-command.ts`), completely
separate from the translation flow: a command message never reaches
OpenAI. The webhook verifies Telegram's Secret header, gates messages
through the allowlist/dedupe tables, applies reliability/security
hardening (see below), then routes to either the command path or (for
ordinary text) the speaker-memory-informed translation path — all tested
against mocked OpenAI/Telegram HTTP responses and local D1 (583 tests);
no real OpenAI/Telegram API call has been made, and the Phase 5/6/7
migrations have been applied only locally. No Telegram bot has been
created, no Secret is registered, the Worker is not deployed, and no
webhook is registered with Telegram — those actions, plus the remote
migrations and the production admin/chat bootstrap, are Phase 8B, each
requiring its own separate approval (see
[`docs/operations.md`](docs/operations.md), "External action approval
matrix"). See [`docs/implementation-plan.md`](docs/implementation-plan.md)
for the full phased plan — **Phases 0–7 are complete, Phase 8A
(deployment preparation) is complete, and Phase 8B (the external actions
themselves) has not started.**

**Deployment preparation (Phase 8A):** a `POST /admin/bootstrap` endpoint
(`SETUP_ADMIN_SECRET`-gated, entirely separate from the Telegram webhook
flow) provides the one sanctioned way to register the first real bot
admin and allowlist the first real chat — a single atomic, idempotent D1
upsert into the existing `bot_admins`/`allowed_chats` tables, with no new
migration. `docs/operations.md` is now the deployment runbook: an
external-action approval matrix (nine independent approval units), a
first-deployment ordering, a per-Secret registration runbook, a remote
migration runbook, a Worker-deployment runbook, a webhook-registration
runbook (a documented manual operator call — no permanent webhook-setup
endpoint was built), post-deploy smoke checks, and an emergency-stop
procedure. Nothing external was actually performed — every command in
the runbook uses placeholder values only.

**Reliability and security hardening (Phase 7):** concurrent dedupe
correctness is verified under simultaneous delivery; a per-chat inbound
handled-update rate limit (`MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE`,
default 60/minute), a per-chat OpenAI attempt burst limit
(`MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE`, default 20/minute), and a
global daily OpenAI attempt ceiling (`MAX_OPENAI_ATTEMPTS_PER_DAY`,
default 300/UTC day) are enforced using only the existing D1 binding — no
new Cloudflare Rate Limiting binding or other remote service. All three
values are non-secret `wrangler.jsonc` vars, safe to tune after the
Phase 9 pilot without a code change. Exceeding a limit responds 200 and
keeps the update's dedupe reservation, so a Telegram redelivery is never
double-charged. Structured, field-allowlisted logging replaced ad hoc
logging; message text, translated text, command text, correction terms,
display names, prompts, raw OpenAI/Telegram responses, Secrets, and raw
error messages are never logged. A dedicated security regression suite
covers the project's threat table (prompt injection, SQL injection,
sensitive-data-at-rest, log-based leaks, unauthorized access). See
[`docs/security-and-privacy.md`](docs/security-and-privacy.md) and
[`docs/architecture.md`](docs/architecture.md) for details.

## Architecture (planned)

```text
Telegram group ──webhook──▶ Cloudflare Worker ──▶ OpenAI (gpt-4o-mini)
                                   │
                                   ▼
                            Cloudflare D1
                        (speaker memory, allowlist,
                         dedupe — never message text)
                                   │
                                   ▼
                            Cloudflare Worker ──reply──▶ Telegram group
```

- **Runtime:** Cloudflare Workers, TypeScript
- **Database:** Cloudflare D1 (binding name will be `DB`)
- **Translation:** OpenAI API, model `gpt-4o-mini`
- **Interface:** Telegram Bot API

Full details: [`docs/architecture.md`](docs/architecture.md).

## MVP scope

**In scope (see [`docs/implementation-plan.md`](docs/implementation-plan.md)):**
text-message translation, JA/PT-BR/other-language detection, reply-format
translation posting, single-message reply context, speaker profiles and
explicit preferences, a translation-correction dictionary,
`/status` `/profile` `/remember` `/forget` `/forgetme` `/correct` `/help`
`/enable` `/disable`, update-ID dedupe, webhook Secret verification, a
group allowlist, limited automatic retry for OpenAI, and structured logs
that never include message text.

**Out of scope:** voice, image OCR, sticker translation, video, full
conversation history, long-term conversation context, RAG/vector search,
an admin web UI, multi-tenant SaaS, and (for now) production deployment
or live webhook registration.

## Privacy principles

- Conversation text is never persisted. D1 stores only speaker metadata
  (display name, primary language, low-risk style tendencies), explicit
  settings, a correction dictionary, and ID-level bookkeeping — never
  message bodies or full OpenAI prompts.
- Explicit user/admin settings always take priority over anything the bot
  infers automatically.
- No inferred personality, health, political, or religious profiling —
  ever.
- Secrets never appear in this repository, in any form.

Full details, including the storage allow/deny list:
[`docs/security-and-privacy.md`](docs/security-and-privacy.md) and
[`docs/data-model.md`](docs/data-model.md).

## Repository layout

```text
telegram-translation-ptbr-ja/
├── .claude/skills/telegram-translation-project/SKILL.md   # Claude Code skill for this repo
├── .github/workflows/ci.yml                               # format/lint/typecheck/test on push & PR
├── docs/                                                   # architecture, data model, security, ops, plan, ADRs
├── src/
│   ├── index.ts                                            # Worker: GET /health, POST /telegram/webhook, POST /admin/bootstrap, 404 otherwise
│   ├── env.d.ts                                             # Secret binding types (merged into the generated Env)
│   ├── domain/                                             # vendor-independent types (language, speaker, translation, telegram-update, speaker-memory, bootstrap)
│   ├── config/                                             # non-secret config validation
│   ├── prompts/                                            # versioned OpenAI prompt + Structured Outputs schema
│   ├── commands/                                           # command vocabulary, pure parser, plain-text response builders
│   ├── application/                                        # translate-and-reply and execute-command use cases (boundary interfaces only)
│   ├── handlers/                                           # HTTP/webhook entry points (telegram-webhook.ts, admin-bootstrap.ts)
│   ├── infrastructure/admin/                                # Phase 8A: setup-secret.ts (bootstrap Secret check)
│   ├── infrastructure/d1/                                  # parameterized D1 repositories and row validation
│   ├── infrastructure/openai/                              # Responses API client, response validation, domain conversion
│   ├── infrastructure/telegram/                            # Update parser, webhook Secret check, sendMessage client
│   └── shared/errors.ts, structured-log.ts, time-windows.ts, secret-compare.ts # error hierarchy, structured logging, UTC time-bucket math, timing-safe Secret comparison
├── test/                                                   # mirrors src/, plus health.test.ts for the scaffold
├── migrations/0001_initial.sql                             # local Phase 2 D1 schema (applied remotely)
├── migrations/0002_speaker_memory.sql                      # local Phase 5 D1 schema (applied locally only — see Phase 8B)
├── migrations/0003_commands.sql                             # local Phase 6 D1 schema (bot_admins; applied locally only — see Phase 8B)
├── migrations/0004_reliability.sql                          # local Phase 7 D1 schema (rate_limit_counters, openai_daily_usage; applied locally only — see Phase 8B)
├── .dev.vars.example                                       # empty-valued template for local Secrets
├── CLAUDE.md / AGENTS.md                                   # agent instructions (point to docs/project-rules.md)
├── worker-configuration.d.ts                               # generated binding/runtime types
└── wrangler.jsonc                                          # Worker config (remote DB binding; no Secrets)
```

## Getting started in GitHub Codespaces

1. Open this repository in a Codespace.
2. `npm install`
3. `npm run check` — confirms format, lint, typecheck, and tests all pass
   in a fresh environment.
4. `npm run dev` — runs the Worker locally with `wrangler dev` (no
   external calls in the current scaffold).

## Local development

Requirements: Node.js **22+** (matches the `engines` field in
`package.json` and what Wrangler 4.x requires) and npm.

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in real values only once Secrets are actually needed
npm run dev
```

`.dev.vars` is gitignored. Never put real values in `.dev.vars.example`.

## Available npm scripts

| Script                 | What it does                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `npm run dev`          | Run the Worker locally (`wrangler dev`)                                                 |
| `npm run deploy`       | Deploy the Worker (`wrangler deploy`) — not yet used; no production deploy has happened |
| `npm run typecheck`    | `tsc --noEmit`                                                                          |
| `npm run lint`         | ESLint over the whole repo                                                              |
| `npm run format`       | Prettier, writes changes                                                                |
| `npm run format:check` | Prettier, check-only (used in CI)                                                       |
| `npm run test`         | Vitest, running inside the Workers runtime                                              |
| `npm run check`        | format:check + lint + typecheck + test — the same thing CI runs                         |
| `npm run cf-typegen`   | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` after binding changes      |

## Secrets (names only — no values are ever committed)

```text
OPENAI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
SETUP_ADMIN_SECRET
```

None of these are registered as real Cloudflare Secrets yet.
`TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, and `OPENAI_API_KEY` are
read by the webhook boundary, Telegram client, and OpenAI client when
present, and `SETUP_ADMIN_SECRET` is read by the Phase 8A
`POST /admin/bootstrap` endpoint
(`src/infrastructure/admin/setup-secret.ts`) — every one of them is
optional in code and fails safely (rejecting requests) when absent. See
[`docs/security-and-privacy.md`](docs/security-and-privacy.md) for how
they'll eventually be managed, [`docs/operations.md`](docs/operations.md)
for the full per-Secret registration runbook, and `.dev.vars.example` for
the local-dev template.

## Cloudflare D1 binding

Binding name: **`DB`**. The real database name and ID are configured, while
local development continues to use local D1 by default. The initial
migration (`0001_initial.sql`) has been applied remotely; the Phase 5
migration (`0002_speaker_memory.sql`), the Phase 6 migration
(`0003_commands.sql`), and the Phase 7 migration
(`0004_reliability.sql`) have each been applied and verified locally only
(`wrangler d1 migrations apply --local`) — applying any of them to the
remote database is a Phase 8B action (see
[`docs/operations.md`](docs/operations.md), "Remote migration runbook").
Phase 8A adds no new migration — the `POST /admin/bootstrap` endpoint
writes only to the existing `bot_admins`/`allowed_chats` tables. The
Worker has not been deployed. See
[`docs/data-model.md`](docs/data-model.md) and
[`docs/implementation-plan.md`](docs/implementation-plan.md) Phases 2,
5, 6, 7, and 8.

## Testing

```sh
npm run test
```

Tests run inside the actual Workers runtime via
`@cloudflare/vitest-pool-workers` (not a Node.js simulation of it), so
Worker-specific and local D1 behavior are exercised faithfully. Coverage
includes `test/health.test.ts` (the health/404 scaffold),
`test/handlers/telegram-webhook.test.ts` (Secret verification, parsing,
allowlist/dedupe gating, the full translate-and-reply flow including
speaker memory read/write, and the dedupe-release policy on transient
vs. permanent failures, all against local D1),
`test/handlers/telegram-webhook-commands.test.ts` (the full command
surface end to end: each command's success/failure path, admin
authorization, the unknown-chat/disabled-chat/`/enable`-exception
routing rules, OpenAI-isolation assertions, and command-specific
dedupe/retry semantics, all against local D1),
`test/infrastructure/telegram/{webhook-secret,send-message}.test.ts`
(Secret comparison and the `sendMessage` client's error classification),
`test/infrastructure/openai/{client,translate}.test.ts` (Structured
Outputs request/response handling, retry/timeout behavior, and malformed-
response rejection), `test/prompts/{translation-v1,translation-v2}.test.ts`
(prompt shape and schema for both versions),
`test/application/translate-and-reply.test.ts` and
`test/application/execute-command.test.ts` (both use cases in isolation
via mocked boundaries), `test/commands/parse-command.test.ts` (the pure
command parser, including malformed-syntax and `@BotName`-suffix cases),
`test/domain/speaker-memory.test.ts` (the explicit-over-observed
priority resolver and correction selection, in isolation),
`test/infrastructure/d1/{repositories,speaker-memory-repositories,bot-admins,forget-me,reliability-counters}.test.ts`
(the Phase 2, Phase 5, Phase 6, and Phase 7 D1 repositories, including
all four migrations applied in order against local D1, and a
concurrency test asserting exactly one successful dedupe reservation
under simultaneous delivery for the same `update_id`),
`test/handlers/telegram-webhook-reliability.test.ts` (the per-chat
inbound rate limit, the per-chat OpenAI attempt burst limit, and the
global daily OpenAI attempt ceiling, end to end),
`test/handlers/telegram-webhook-security.test.ts` (the Phase 7 security
regression pass: prompt-injection-shaped and SQL-injection-shaped input,
sensitive-data-at-rest schema inspection, and log-leak assertions), and
the Phase 8A bootstrap-endpoint suite —
`test/domain/bootstrap.test.ts` (the pure request parser),
`test/infrastructure/admin/setup-secret.test.ts` (the bootstrap Secret
check), `test/infrastructure/d1/bootstrap.test.ts` (the atomic
admin+chat upsert, idempotency, and D1-failure classification against
local D1), and `test/handlers/admin-bootstrap.test.ts` (end to end:
authentication ordering, request validation, successful bootstrap,
idempotency, D1 failure handling, routing isolation from
`/telegram/webhook`, and structured-log leak assertions). No test calls
the real Telegram, OpenAI, or remote D1 — outbound `fetch` is always a
supplied mock.

## Deployment

**Not performed.** This project has never been deployed to Cloudflare,
no Telegram webhook has been registered, and the provisioned remote D1
database contains only the schema created by `0001_initial.sql`.
See [`docs/implementation-plan.md`](docs/implementation-plan.md) (Phases
8–9) and [`docs/operations.md`](docs/operations.md) for the planned path
there.

## Further reading

- [`docs/architecture.md`](docs/architecture.md) — system design
- [`docs/data-model.md`](docs/data-model.md) — planned D1 schema
- [`docs/security-and-privacy.md`](docs/security-and-privacy.md) — security
  and privacy rules
- [`docs/operations.md`](docs/operations.md) — operational workflows
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — phased
  build plan
- [`docs/project-rules.md`](docs/project-rules.md) — coding conventions
  (canonical source, referenced by `CLAUDE.md` and `AGENTS.md`)
- [`docs/decisions/0001-cloudflare-workers-d1.md`](docs/decisions/0001-cloudflare-workers-d1.md) —
  why Cloudflare Workers + D1
