# CLAUDE.md

## Project

A Cloudflare Workers + TypeScript Telegram bot that translates between
Japanese and Brazilian Portuguese in a family group, backed by Cloudflare
D1 for speaker memory. See `README.md` for the full picture.

## Current phase

**Phase 2 completed.** The local migration/repositories/tests and remote D1
binding configuration are complete. `0001_initial.sql` has been applied to the
remote D1 database. Do not start Phase 3 without an explicit go-ahead. See
`docs/implementation-plan.md` for the authoritative status.

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
  Secret registration, D1 resource creation, Telegram webhook
  registration) without explicit human approval — these are called out
  per-phase in `docs/implementation-plan.md`.
- Never implement beyond the current implementation-plan phase in one
  change.

Everything else — coding conventions, folder responsibilities, layering
rules — lives in `docs/project-rules.md`. Don't duplicate it here; read
it there.
