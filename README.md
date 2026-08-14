# telegram-translation-ptbr-ja

A Telegram bot that translates between Japanese and Brazilian Portuguese
in a family group chat, aiming to keep tone, emoji, names, and forms of
address natural in both directions.

## Current status: Phase 4 complete — bot not deployed

This repository currently contains project conventions, documentation, a
Worker with `GET /health` and a `POST /telegram/webhook` boundary, CI/test
tooling, a vendor-independent domain/config/error layer, a pure Telegram
Update parser, a locally tested D1 migration/repository layer, a
mockable Telegram `sendMessage` client, and a full OpenAI translation
pipeline (versioned prompt, Structured Outputs client, timeout + capped
transient-only retry, and the translate-and-reply application use case).
The webhook verifies Telegram's Secret header, gates messages through the
allowlist/dedupe tables, calls OpenAI exactly once per message, and posts
the translated reply — all tested against mocked OpenAI/Telegram HTTP
responses; no real OpenAI API call has been made. No Telegram bot has
been created, no Secret is registered, the Worker is not deployed, and no
webhook is registered with Telegram — those four actions belong to
Phase 8. See [`docs/implementation-plan.md`](docs/implementation-plan.md)
for the full phased plan — **Phases 0–4 are complete** and Phase 5
(speaker memory) has not started.

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
│   ├── index.ts                                            # Worker: GET /health, POST /telegram/webhook, 404 otherwise
│   ├── env.d.ts                                             # Secret binding types (merged into the generated Env)
│   ├── domain/                                             # vendor-independent types (language, speaker, translation, telegram-update)
│   ├── config/                                             # non-secret config validation
│   ├── prompts/                                            # versioned OpenAI prompt + Structured Outputs schema
│   ├── application/                                        # translate-and-reply use case (boundary interfaces only)
│   ├── handlers/                                           # HTTP/webhook entry points
│   ├── infrastructure/d1/                                  # parameterized D1 repositories and row validation
│   ├── infrastructure/openai/                              # Responses API client, response validation, domain conversion
│   ├── infrastructure/telegram/                            # Update parser, webhook Secret check, sendMessage client
│   └── shared/errors.ts                                    # error hierarchy (validation/config/upstream)
├── test/                                                   # mirrors src/, plus health.test.ts for the scaffold
├── migrations/0001_initial.sql                             # local Phase 2 D1 schema (applied remotely)
├── .dev.vars.example                                       # empty-valued template for local Secrets
├── CLAUDE.md / AGENTS.md                                   # agent instructions (point to docs/project-rules.md)
├── worker-configuration.d.ts                               # generated binding/runtime types
└── wrangler.jsonc                                          # Worker config (remote DB binding; no Secrets)
```

`src/` will grow further into `commands/` (Phase 6) as described in
[`docs/project-rules.md`](docs/project-rules.md).

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
present, but the code treats them as optional and fails safely (rejecting
requests) when they're absent — see
[`docs/security-and-privacy.md`](docs/security-and-privacy.md) for how
they'll eventually be managed, and `.dev.vars.example` for the local-dev
template.

## Cloudflare D1 binding

Binding name: **`DB`**. The real database name and ID are configured, while
local development continues to use local D1 by default. The initial migration
has been applied remotely; the Worker has not been deployed. See
[`docs/data-model.md`](docs/data-model.md) and
[`docs/implementation-plan.md`](docs/implementation-plan.md) Phase 2.

## Testing

```sh
npm run test
```

Tests run inside the actual Workers runtime via
`@cloudflare/vitest-pool-workers` (not a Node.js simulation of it), so
Worker-specific and local D1 behavior are exercised faithfully. Coverage
includes `test/health.test.ts` (the health/404 scaffold),
`test/handlers/telegram-webhook.test.ts` (Secret verification, parsing,
allowlist/dedupe gating, the full translate-and-reply flow, and the
dedupe-release policy on transient vs. permanent failures, all against
local D1), `test/infrastructure/telegram/{webhook-secret,send-message}.test.ts`
(Secret comparison and the `sendMessage` client's error classification),
`test/infrastructure/openai/{client,translate}.test.ts` (Structured
Outputs request/response handling, retry/timeout behavior, and malformed-
response rejection), `test/prompts/translation-v1.test.ts` (prompt shape
and schema), and `test/application/translate-and-reply.test.ts` (the use
case in isolation). No test calls the real Telegram, OpenAI, or remote
D1 — outbound `fetch` is always a supplied mock.

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
