# 0001: Cloudflare Workers + D1 as the runtime and storage foundation

## Status

Accepted

## Context

This project needs a runtime to receive Telegram webhook events, call
OpenAI for translation, and persist a small amount of per-speaker
metadata (see `docs/data-model.md`). Requirements that shaped the
decision:

- Public GitHub repository, with GitHub as the code host and eventual
  CI/CD trigger.
- Primary development happens in GitHub Codespaces or another browser-based
  environment — not a fixed local machine.
- Low operational overhead: this is a small family-scale project, not
  something that should require managing servers, containers, or a
  database cluster.
- Storage needs are small and simple (a handful of narrow tables — see
  `docs/data-model.md`), not a general-purpose document store or
  something needing a rich query/aggregation engine.
- No conversation history is persisted (see
  `docs/security-and-privacy.md`), which removes the case for anything
  built around large-document or event-stream storage.

## Decision

- **Cloudflare Workers** is the execution runtime for the bot.
- **Cloudflare D1** is the storage layer for speaker memory, allowlist,
  dedupe, and related metadata.
- **n8n** (cloud or self-hosted) is **not** used.
- **Firestore** is **not** used now, and is only reconsidered if the
  project later needs a real admin web UI or multi-app integration beyond
  what this Telegram bot does.

## Alternatives considered

### n8n Cloud

A hosted workflow-automation tool could implement the translate-and-reply
flow visually. Rejected because: the logic here (allowlisting, structured
OpenAI calls, per-speaker preference resolution, multiple slash commands)
is genuine application logic that benefits from real tests, types, and
version control at the code level — not a linear workflow. n8n Cloud also
adds a third-party runtime dependency and recurring cost outside
Cloudflare/GitHub/OpenAI, for no capability this project actually needs.

### Self-hosted n8n

Same logic-fit objection as n8n Cloud, plus it reintroduces exactly the
operational overhead (a server/container to keep running, patch, and pay
for) that Workers avoids. Rejected for the same reasons as n8n Cloud, with
the added downside of infrastructure maintenance.

### Firestore

A capable document database, but: it's a separate cloud provider from
GitHub/Cloudflare/OpenAI (more accounts, more credentials, more places
Secrets could leak), it's schema-flexible in a way this project doesn't
need (the data model is a handful of narrow relational tables — see
`docs/data-model.md`), and D1's Workers binding (in-process, no network
hop, no separate auth) fits the "small, low-overhead" requirement better
than a REST/SDK-based document store would. Deferred, not permanently
rejected: revisit if a future admin web UI or multi-app integration
outgrows what D1 + Workers comfortably provides.

### Telegram Serverless (Telegram's own serverless/bot hosting, where

applicable)

Rejected because it would couple the entire application's hosting to
Telegram specifically, whereas this project already needs to call OpenAI
and (eventually) Cloudflare-native storage. A Cloudflare Worker calling
out to the Telegram Bot API keeps the hosting layer vendor-neutral with
respect to Telegram, and keeps deployment/observability consistent with
the rest of the stack (GitHub → Cloudflare).

## Consequences

- The bot's runtime and storage both live inside Cloudflare's platform,
  which means one primary vendor to manage credentials and observability
  for, beyond GitHub (hosting) and OpenAI (translation).
- D1 access must go through Workers Bindings, not a REST client (see
  `docs/project-rules.md` rule 12) — this is a constraint the team must
  keep honoring as the codebase grows.
- D1's relational, SQLite-based model is a good fit for the current data
  model (`docs/data-model.md`) but would need reconsideration if future
  requirements introduce large-scale analytical queries or document-shaped
  data — not expected for this project's scope.
- Local development (`wrangler dev`, D1 local mode) works without a
  standing server, which supports the Codespaces-first workflow.
- No workflow-automation UI (n8n) exists for non-engineers on this
  project to modify bot behavior — all behavior changes go through code
  review, which is an intentional trade-off given the correctness and
  privacy requirements in `docs/security-and-privacy.md`.
