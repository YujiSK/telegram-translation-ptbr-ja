# CLAUDE.md

## Project

A Cloudflare Workers + TypeScript Telegram bot that translates between
Japanese and Brazilian Portuguese in a family group, backed by Cloudflare
D1 for speaker memory. See `README.md` for the full picture.

## Current phase

**Phase 7 completed; Phase 8A (deployment preparation) completed; Phase
8B (external actions) not started.** The local webhook boundary, Secret
verification, allowlist/dedupe wiring, OpenAI translation (a single
Structured Outputs call per message), the Telegram reply, speaker
memory (per-`(chat_id, user_id)` observed style, explicit preferences,
and term corrections, resolved explicit-over-observed and folded into
the OpenAI prompt with no second API call), the full command surface
(`/help`, `/status`, `/profile`, `/remember`, `/forget`, `/forgetme`,
`/correct`, admin-only `/enable`/`/disable` — completely separate from
the translation flow, never calling OpenAI), reliability/security
hardening (concurrent dedupe verification, a per-chat inbound rate
limit, a per-chat and a global daily OpenAI attempt limit, structured
field-allowlisted logging, and a security regression pass), and a
production-bootstrap endpoint (`POST /admin/bootstrap`,
`SETUP_ADMIN_SECRET`-gated, entirely separate from `/telegram/webhook`)
are implemented and tested against mocked OpenAI/Telegram responses and
local D1 — no real OpenAI/Telegram API call has been made, and the
Phase 5, Phase 6, and Phase 7 migrations
(`migrations/0002_speaker_memory.sql`, `migrations/0003_commands.sql`,
`migrations/0004_reliability.sql`) have each been applied only locally,
not to the remote database (Phase 8A adds no new migration). Telegram
bot creation, all four Secret registrations, the remote `0002`/`0003`/
`0004` migrations, the production admin/chat bootstrap, Worker
deployment, and webhook registration remain Phase 8B actions — nine
independent approvals (see `docs/operations.md`, "External action
approval matrix"); do not perform any of them without its own explicit
go-ahead. See `docs/implementation-plan.md` for the authoritative
status.

## Always read before working

- `docs/implementation-plan.md`
- `docs/project-rules.md`
- `docs/security-and-privacy.md`
- `docs/architecture.md`

## Commands

- `npm run check` — format:check + lint + typecheck + test (run this
  before considering any change done)
- `npm run dev` — run the Worker locally
- `npm run test` — tests only
- See `README.md` for the full script list.

## Before starting work

Check `git status` and the current branch, and confirm which phase of
`docs/implementation-plan.md` is actually in progress before writing
code.

## Before finishing work

Run `npm run check`; confirm no Secret, message text, or personal data
leaked into anything committed; confirm the change stayed within one
implementation-plan phase.

## Hard constraints

- Never write a Secret (API key, bot token, webhook secret, admin secret)
  into source, docs, config, or a commit — see
  `docs/security-and-privacy.md`.
- Never persist conversation text or full OpenAI prompts anywhere — see
  `docs/security-and-privacy.md` and `docs/data-model.md`.
- Never make a real change to an external service (Cloudflare deploy,
  Secret registration, remote D1 migration apply, production admin/chat
  bootstrap, Telegram bot creation, Telegram webhook registration)
  without explicit human approval, per action — these are called out
  per-phase in `docs/implementation-plan.md` and as separate approval
  units in `docs/operations.md`.
- Never implement beyond the current implementation-plan phase in one
  change.

Everything else — coding conventions, folder responsibilities, layering
rules — lives in `docs/project-rules.md`. Don't duplicate it here; read
it there.
