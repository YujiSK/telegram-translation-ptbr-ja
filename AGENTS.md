# AGENTS.md

This file lets any coding agent (Codex, Claude Code, etc.) work on this
repository under the same rules. The canonical rule set is
`docs/project-rules.md` — this file points there instead of duplicating
it, so the rules never drift out of sync between agents.

## What this project is

A Cloudflare Workers + TypeScript Telegram bot translating between
Japanese and Brazilian Portuguese for a family group, using Cloudflare D1
for speaker memory. See `README.md` for an overview and
`docs/architecture.md` for the design.

## Read first

1. `docs/implementation-plan.md` — find the current phase; work is scoped
   to one phase at a time.
2. `docs/project-rules.md` — the canonical coding/layering/security rules.
3. `docs/security-and-privacy.md` — what may and may not be stored,
   logged, or committed.
4. `docs/architecture.md` — system design and external-service
   boundaries.

## Commands

```sh
npm install
npm run check    # format:check + lint + typecheck + test — must be green before finishing
npm run dev      # run the Worker locally
```

## Non-negotiables (see `docs/project-rules.md` for the full list)

- No Secrets in source, docs, or config, ever.
- No conversation text or full OpenAI prompts persisted or logged.
- No implementation ahead of the current phase in
  `docs/implementation-plan.md`.
- No real Cloudflare/Telegram/OpenAI production changes (deploy, Secret
  registration, webhook registration) without explicit human approval.
- `npm run check` must pass before a change is considered done.

For anything not covered above — folder structure, layering rules, SQL
parameterization, retry/timeout policy, and so on — see
`docs/project-rules.md`. If this file and `docs/project-rules.md` ever
appear to disagree, `docs/project-rules.md` wins.
