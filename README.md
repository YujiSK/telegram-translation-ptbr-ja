# telegram-translation-ptbr-ja

A Telegram bot that translates between Japanese and Brazilian Portuguese
in a family group chat, aiming to keep tone, emoji, names, and forms of
address natural in both directions.

## Current status: Foundation and domain layer only — bot not implemented

This repository currently contains project conventions, documentation, a
minimal Worker scaffold (`GET /health`), CI/test tooling, and a
vendor-independent domain/config/error layer with a pure Telegram Update
parser. It does **not** yet talk to Telegram, OpenAI, or a real database.
See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the
full phased plan — **Phase 1 is complete**, and Phase 2 (D1) hasn't
started.

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
│   ├── index.ts                                            # minimal Worker: GET /health, 404 otherwise
│   ├── domain/                                             # vendor-independent types (language, speaker, translation, telegram-update)
│   ├── config/                                             # non-secret config validation
│   ├── infrastructure/telegram/                            # pure Telegram Update parser
│   └── shared/errors.ts                                    # error hierarchy (validation/config/upstream)
├── test/                                                   # mirrors src/, plus health.test.ts for the scaffold
├── .dev.vars.example                                       # empty-valued template for local Secrets
├── CLAUDE.md / AGENTS.md                                   # agent instructions (point to docs/project-rules.md)
└── wrangler.jsonc                                          # Worker config (no bindings/secrets yet)
```

`src/` will grow further into `application/`, `handlers/`, `commands/`,
and `prompts/` as described in
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

| Script                 | What it does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `npm run dev`          | Run the Worker locally (`wrangler dev`)                                                    |
| `npm run deploy`       | Deploy the Worker (`wrangler deploy`) — not yet used; no production deploy has happened    |
| `npm run typecheck`    | `tsc --noEmit`                                                                             |
| `npm run lint`         | ESLint over the whole repo                                                                 |
| `npm run format`       | Prettier, writes changes                                                                   |
| `npm run format:check` | Prettier, check-only (used in CI)                                                          |
| `npm run test`         | Vitest, running inside the Workers runtime                                                 |
| `npm run check`        | format:check + lint + typecheck + test — the same thing CI runs                            |
| `npm run cf-typegen`   | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` (run after changing bindings) |

## Secrets (names only — no values are ever committed)

```text
OPENAI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
SETUP_ADMIN_SECRET
```

None of these are registered yet. See
[`docs/security-and-privacy.md`](docs/security-and-privacy.md) for how
they'll be managed, and `.dev.vars.example` for the local-dev template.

## Cloudflare D1 binding (planned)

Binding name: **`DB`**. Not yet added to `wrangler.jsonc` — see
[`docs/data-model.md`](docs/data-model.md) for the planned schema and
[`docs/implementation-plan.md`](docs/implementation-plan.md) Phase 2 for
when it's introduced.

## Testing

```sh
npm run test
```

Tests run inside the actual Workers runtime via
`@cloudflare/vitest-pool-workers` (not a Node.js simulation of it), so
Worker-specific behavior is exercised faithfully. `test/health.test.ts`
covers the current scaffold: `GET /health` returns 200 with the expected
JSON body, unmapped paths return 404, and no external network calls occur.

## Deployment

**Not configured.** This project has never been deployed to Cloudflare,
no Telegram webhook has been registered, and no D1 database exists yet.
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
