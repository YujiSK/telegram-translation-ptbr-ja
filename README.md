# telegram-translation-ptbr-ja

A Telegram bot for Japanese ↔ Brazilian Portuguese translation in a family group chat, with speaker-specific tone/preferences, short correction memory, command controls, dedupe, rate/usage safeguards, and privacy-first logging.

## Current status

**Phases 0–8B are complete. Phase 9 pilot started and is currently paused for the Phase 9.1 provider redesign. Phase 9.1A (provider abstraction + Workers AI routine path) is implemented and tested locally/in CI, but has not been deployed to production.**

The real Telegram bot, Cloudflare Worker, remote D1 database, production Secrets, initial admin/chat bootstrap, and Telegram webhook are live, still running the pre-Phase-9.1A code. A real `/status` command succeeds end to end in the pilot family group.

After Telegram Group Privacy was disabled and the bot was removed/re-added, ordinary group messages also reached the Worker. The then-current OpenAI-only translation path ended in a `TransientUpstreamError`, so no translation reply was posted. A separate OpenAI `/v1/models` request returned HTTP 200, confirming that the configured key itself was valid.

The product decision is not to rely on paid OpenAI for routine family traffic. The accepted architecture and its first implementation slice are documented in:

- [`docs/decisions/0002-multi-provider-translation-routing.md`](docs/decisions/0002-multi-provider-translation-routing.md)
- [`docs/phase9-provider-plan.md`](docs/phase9-provider-plan.md)
- [`docs/checkpoints/2026-08-25-phase8b-live-provider-redesign.md`](docs/checkpoints/2026-08-25-phase8b-live-provider-redesign.md)

## Provider architecture

Phase 9.1A implements a vendor-independent provider router
(`src/infrastructure/translation/{provider.ts,router.ts}`) and a
Cloudflare Workers AI routine-translation adapter
(`src/infrastructure/workers-ai/`), local/CI-only — **no production
deploy of this code has happened yet.** `TRANSLATION_PROVIDER` selects
exactly one provider per message; there is no automatic fallback between
providers:

```text
Telegram group
    ↓ webhook
Cloudflare Worker
    ├─ deterministic policy: Secret check / commands / allowlist / dedupe / limits
    ├─ D1 speaker-memory read
    ↓
TRANSLATION_PROVIDER=workers-ai (implemented, now the default)
    ├─ high confidence ─────▶ Telegram reply
    └─ needsEscalation=true ─▶ ignored:escalation-unavailable (no reply; no fallback call)

TRANSLATION_PROVIDER=openai (implemented, legacy/compatibility mode only)
    └─▶ Telegram reply, unchanged from Phase 4/5

Not implemented by this task: Gemini escalation (Phase 9.1B), DeepL
```

Provider roles:

- **Cloudflare Workers AI (implemented, Phase 9.1A):** routine
  translation/inference target, called via the `AI` Worker binding
  (`env.AI.run()`), model `@cf/zai-org/glm-4.7-flash` set through the
  `WORKERS_AI_MODEL` config var — never hard-coded. When the model
  reports `needsEscalation: true`, the router throws
  `EscalationRequiredError` (200, no reply, dedupe kept) rather than
  calling any other provider. Local dev inference against the real
  binding may consume real Workers AI free-allocation quota; every
  automated test injects a fake binding instead, so `npm run check`
  never performs a real `env.AI.run()` call.
- **Gemini 3.5 Flash Lite:** escalation target — **not implemented by
  this task; deferred to Phase 9.1B.** The project dashboard observed on
  2026-08-25 shows **15 RPM / 250K TPM / 500 RPD** on the free tier.
  These values are operational observations and must not be hard-coded.
- **DeepL:** optional translation-specific fallback or benchmark — **not
  implemented; deferred**, and only after the actual account's API
  entitlement/quota and data-processing terms are confirmed.
- **OpenAI (implemented, legacy/compatibility mode):** the original
  Phase 4/5 implementation, selected via `TRANSLATION_PROVIDER=openai`.
  Routine traffic should not incur OpenAI spend — `workers-ai` is now the
  default.

## Existing implemented behavior

The deployed code already includes:

- `GET /health`
- `POST /telegram/webhook`
- `POST /admin/bootstrap`
- Telegram webhook Secret verification
- allowed-chat gating
- update-ID dedupe
- JA / PT-BR / other-language translation contract
- single replied-to-message context
- speaker memory scoped to `(chat_id, user_id)`
- explicit tone/emoji preferences and short correction memory
- `/help`, `/status`, `/profile`, `/remember`, `/forget`, `/forgetme`, `/correct`
- admin-only `/enable`, `/disable`
- per-chat inbound rate limiting
- OpenAI-attempt limits from the current Phase 7 implementation (only consumed by `TRANSLATION_PROVIDER=openai`; Workers AI mode does not touch these counters)
- a vendor-independent translation-provider router (Phase 9.1A) with a Workers AI routine adapter and a legacy OpenAI adapter, each called exclusively — no automatic fallback between them
- structured logs that exclude message text, translations, prompts, raw provider responses, Secrets, and raw error messages

The command path is completely separate from translation: **commands never invoke an AI provider, regardless of `TRANSLATION_PROVIDER`.**

## Phase 9.1 rules

The provider redesign must preserve these invariants:

1. `domain/` and `application/` remain vendor-independent.
2. A normal message must not call every configured provider; escalation/fallback is bounded and testable. **(Phase 9.1A: enforced — each router mode calls exactly one provider; an escalation-required Workers AI candidate never triggers an OpenAI call.)**
3. At most one replied-to message is used as context. No full conversation history is fetched or persisted.
4. D1 never stores family message bodies.
5. Speaker-memory priority remains explicit preference over observed style, per axis.
6. A successful Telegram reply must never be duplicated because a later best-effort write fails.
7. Provider quota/cost data is operational configuration, not a domain constant.
8. New provider credentials/bindings/deploys are separate external actions and require explicit approval. **(Phase 9.1A added the `AI` Worker binding to source and config only — it has not been deployed.)**
9. Gemini Free Tier privacy/data-treatment implications must be reviewed before live family-message escalation is enabled. **(Not applicable yet — Gemini is not implemented.)**
10. DeepL availability must be verified from the actual API account before production dependency. **(Not applicable yet — DeepL is not implemented.)**

## Privacy

Conversation text is never persisted. D1 stores only the minimum metadata needed for speaker memory and operation: low-risk style/preferences/corrections plus ID-level bookkeeping.

No inferred personality, health, political, religious, or other sensitive profiling is allowed.

Secrets and real Telegram identifiers must never be committed to this public repository.

See [`docs/security-and-privacy.md`](docs/security-and-privacy.md).

## Technology

- Cloudflare Workers + TypeScript
- Cloudflare D1 (`DB` binding)
- Cloudflare Workers AI (`AI` binding) — routine translation provider (Phase 9.1A, default; `@cf/zai-org/glm-4.7-flash`)
- Telegram Bot API
- Legacy/compatibility translation provider: OpenAI Responses API (`gpt-4o-mini`), selected via `TRANSLATION_PROVIDER=openai`
- Planned escalation provider (not implemented): Gemini 3.5 Flash Lite
- Optional provider (not implemented): DeepL API

## Local development

Requirements: Node.js 22+ and npm.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run check
npm run dev
```

`.dev.vars` is gitignored. Never write live credentials into `.dev.vars.example`.

Useful scripts:

| Script                 | Purpose                           |
| ---------------------- | --------------------------------- |
| `npm run dev`          | Local Worker with Wrangler        |
| `npm run deploy`       | Deploy Worker                     |
| `npm run test`         | Vitest in Workers runtime         |
| `npm run typecheck`    | TypeScript check                  |
| `npm run lint`         | ESLint                            |
| `npm run format:check` | Prettier check                    |
| `npm run check`        | format + lint + typecheck + tests |
| `npm run cf-typegen`   | Regenerate Worker binding types   |

## Current production Secret names

Names only; values are never committed. Currently registered/deployed
Secrets (the live Worker predates Phase 9.1A and still requires
`OPENAI_API_KEY`):

```text
OPENAI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
SETUP_ADMIN_SECRET
```

**Phase 9.1A note:** `TRANSLATION_PROVIDER=workers-ai` mode uses the `AI`
Worker binding (`wrangler.jsonc`), not an API key — no new Secret is
required for it. `OPENAI_API_KEY` is now required only when
`TRANSLATION_PROVIDER=openai` (legacy mode) is selected; the command path
never requires any AI-provider Secret or binding in either mode.

Potential future additions if Gemini/DeepL are implemented (Phase 9.1B or
later), **not registered and not implemented by this documentation
update**:

```text
GEMINI_API_KEY
DEEPL_AUTH_KEY   # only if DeepL is selected after entitlement verification
```

## Deployment state

Phase 8B activation is complete, running the pre-Phase-9.1A code:

- Telegram bot: live
- remote D1 migrations through `0004`: applied
- Worker: deployed
- production bootstrap: complete
- webhook: registered
- `/status`: live smoke check passed

**Phase 9.1A (provider router + Workers AI adapter) has been implemented
and tested locally/in CI only — it has not been deployed.** No
`wrangler deploy` was run as part of that work; the production Worker
still runs the OpenAI-only Phase 4/5 translation path until a separately
approved deploy happens.

The translation pilot is paused until Phase 9.1 replaces/generalizes the OpenAI-only provider path.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — detailed implemented architecture; some historical OpenAI-specific sections remain relevant to the currently deployed code
- [`docs/decisions/0002-multi-provider-translation-routing.md`](docs/decisions/0002-multi-provider-translation-routing.md) — accepted provider-routing decision
- [`docs/phase9-provider-plan.md`](docs/phase9-provider-plan.md) — next implementation slice and completion criteria
- [`docs/security-and-privacy.md`](docs/security-and-privacy.md) — security/privacy policy
- [`docs/data-model.md`](docs/data-model.md) — D1 schema and storage rules
- [`docs/operations.md`](docs/operations.md) — deployment/operations runbook
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — original phased implementation history
- [`docs/checkpoints/2026-08-25-phase8b-live-provider-redesign.md`](docs/checkpoints/2026-08-25-phase8b-live-provider-redesign.md) — live deployment/pilot checkpoint

## Git workflow

This repository currently develops directly on `main`. Before code changes, follow [`docs/project-rules.md`](docs/project-rules.md): start clean, keep vendor types at infrastructure boundaries, run `npm run check`, commit only green changes, and never force-push.
