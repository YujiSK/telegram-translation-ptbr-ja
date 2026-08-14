---
name: telegram-translation-project
description: Use when working in this repository (telegram-translation-ptbr-ja) on the implementation plan, Telegram bot features, Cloudflare Workers changes, D1 schema/migrations, OpenAI translation logic, speaker memory, security review, deployment prep, or incident investigation. Enforces phase-by-phase work, verification before completion, and the project's security/privacy rules.
---

This skill governs how work happens in this repository. It applies to:
implementation-plan updates, Telegram bot feature work, Cloudflare
Workers changes, D1 schema/migration changes, OpenAI translation-logic
changes, speaker-memory changes, security review, deployment prep, and
incident investigation.

## Workflow

1. Run `git status` and note the current branch.
2. Open `docs/implementation-plan.md` and identify the current phase.
   Work is scoped to that phase only — never start the next phase's work
   in the same change.
3. Read the design/convention/security docs relevant to the change:
   `docs/architecture.md`, `docs/project-rules.md`,
   `docs/security-and-privacy.md`, and `docs/data-model.md` for anything
   touching storage.
4. Check current official documentation for anything version- or
   API-shape-sensitive before writing code: Cloudflare Workers/D1/Wrangler
   docs, the Telegram Bot API reference, and the OpenAI API docs. Don't
   rely on training-data memory for configuration keys, API shapes, or
   compatibility flags — they change.
5. State explicitly, before editing: what phase this is, what files will
   change, and what is deliberately out of scope for this change.
6. Implement exactly one implementation-plan phase's worth of work — no
   more.
7. Run `npm run format`, `npm run lint`, `npm run typecheck`, and
   `npm run test` (or `npm run check`, which runs all four).
8. Run `git diff --check` to catch whitespace/conflict-marker issues.
9. Re-read the diff specifically for: Secret values, Telegram message
   text, OpenAI prompt/response content, and any personal data beyond
   what `docs/data-model.md` allows.
10. Update `docs/implementation-plan.md` (mark the phase's progress) and
    any other doc the change affects, so docs and code never drift apart.
11. Report: what changed, verification results, and what remains
    undone — including the phase's explicit stopping point from
    `docs/implementation-plan.md`.
12. Stop before any real external-service action: Cloudflare deployment,
    Secret registration, D1 resource creation, or Telegram webhook
    registration. These require explicit human approval, per `CLAUDE.md`.

## Hard prohibitions

- Never display or commit a Secret value (`OPENAI_API_KEY`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SETUP_ADMIN_SECRET`,
  or any future one).
- Never log or persist conversation text — see
  `docs/security-and-privacy.md`.
- Never create a Cloudflare resource (Worker deploy, D1 database, KV/R2,
  etc.) without explicit approval.
- Never register or modify a Telegram webhook without explicit approval.
- Never perform a real production deploy without explicit approval.
- Never implement more than one implementation-plan phase in a single
  change.
- Never report a change as done without a passing `npm run check`.
- Never dismiss a failing test as unrelated — investigate it. If it's
  genuinely pre-existing and unrelated, say so explicitly and show the
  evidence (e.g., it also fails on the base branch), rather than silently
  ignoring it.

## Reference

- Canonical coding/layering rules: `docs/project-rules.md`.
- Phase definitions and completion criteria: `docs/implementation-plan.md`.
- Storage allow/deny list: `docs/data-model.md`.
- Security/privacy rules: `docs/security-and-privacy.md`.
- System design: `docs/architecture.md`.
- Operational procedures: `docs/operations.md`.
