# telegram-translation-ptbr-ja

A Telegram bot for Japanese ↔ Brazilian Portuguese translation in a family group chat, with speaker-specific tone/preferences, short correction memory, command controls, dedupe, rate/usage safeguards, and privacy-first logging.

## Current status

**Phases 0–8B are complete. Phase 9 pilot started and is currently paused for the Phase 9.1 provider redesign.**

The real Telegram bot, Cloudflare Worker, remote D1 database, production Secrets, initial admin/chat bootstrap, and Telegram webhook are live. A real `/status` command succeeds end to end in the pilot family group.

After Telegram Group Privacy was disabled and the bot was removed/re-added, ordinary group messages also reached the Worker. The current OpenAI-only translation path then ended in a `TransientUpstreamError`, so no translation reply was posted. A separate OpenAI `/v1/models` request returned HTTP 200, confirming that the configured key itself was valid.

The product decision is not to rely on paid OpenAI for routine family traffic. The accepted next architecture is documented in:

- [`docs/decisions/0002-multi-provider-translation-routing.md`](docs/decisions/0002-multi-provider-translation-routing.md)
- [`docs/phase9-provider-plan.md`](docs/phase9-provider-plan.md)
- [`docs/checkpoints/2026-08-25-phase8b-live-provider-redesign.md`](docs/checkpoints/2026-08-25-phase8b-live-provider-redesign.md)

## Target provider architecture

Current production code still contains the Phase 4/5 OpenAI translation implementation. The **accepted but not yet implemented** Phase 9.1 design is:

```text
Telegram group
    ↓ webhook
Cloudflare Worker
    ├─ deterministic policy: Secret check / commands / allowlist / dedupe / limits
    ├─ D1 speaker-memory read
    ↓
Workers AI                    routine path
    ├─ high confidence ─────▶ Telegram reply
    └─ low confidence / complex context
                  ↓
        Gemini 3.5 Flash Lite escalation
                  ↓
             Telegram reply

Optional: DeepL fallback / benchmark
Emergency compatibility: OpenAI, disabled by default
```

Provider roles:

- **Cloudflare Workers AI:** routine translation/inference target, using its daily-renewing allowance.
- **Gemini 3.5 Flash Lite:** escalation target. The project dashboard observed on 2026-08-25 shows **15 RPM / 250K TPM / 500 RPD** on the free tier. These values are operational observations and must not be hard-coded.
- **DeepL:** optional translation-specific fallback or benchmark, only after the actual account's API entitlement/quota and data-processing terms are confirmed.
- **OpenAI:** keep temporarily as a disabled-by-default emergency/rollback provider; routine traffic should not incur OpenAI spend.

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
- OpenAI-attempt limits from the current Phase 7 implementation
- structured logs that exclude message text, translations, prompts, raw provider responses, Secrets, and raw error messages

The command path is completely separate from translation: **commands never invoke an AI provider.**

## Phase 9.1 rules

The provider redesign must preserve these invariants:

1. `domain/` and `application/` remain vendor-independent.
2. A normal message must not call every configured provider; escalation/fallback is bounded and testable.
3. At most one replied-to message is used as context. No full conversation history is fetched or persisted.
4. D1 never stores family message bodies.
5. Speaker-memory priority remains explicit preference over observed style, per axis.
6. A successful Telegram reply must never be duplicated because a later best-effort write fails.
7. Provider quota/cost data is operational configuration, not a domain constant.
8. New provider credentials/bindings/deploys are separate external actions and require explicit approval.
9. Gemini Free Tier privacy/data-treatment implications must be reviewed before live family-message escalation is enabled.
10. DeepL availability must be verified from the actual API account before production dependency.

## Privacy

Conversation text is never persisted. D1 stores only the minimum metadata needed for speaker memory and operation: low-risk style/preferences/corrections plus ID-level bookkeeping.

No inferred personality, health, political, religious, or other sensitive profiling is allowed.

Secrets and real Telegram identifiers must never be committed to this public repository.

See [`docs/security-and-privacy.md`](docs/security-and-privacy.md).

## Technology

- Cloudflare Workers + TypeScript
- Cloudflare D1 (`DB` binding)
- Telegram Bot API
- Current translation implementation: OpenAI Responses API (`gpt-4o-mini`)
- Planned routine provider: Cloudflare Workers AI
- Planned escalation provider: Gemini 3.5 Flash Lite
- Optional provider: DeepL API

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

Names only; values are never committed:

```text
OPENAI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
SETUP_ADMIN_SECRET
```

Potential Phase 9.1 additions, **not yet registered by this documentation update**:

```text
GEMINI_API_KEY
DEEPL_AUTH_KEY   # only if DeepL is selected after entitlement verification
```

Workers AI should use a Worker binding rather than an API key where the implementation supports it.

## Deployment state

Phase 8B activation is complete:

- Telegram bot: live
- remote D1 migrations through `0004`: applied
- Worker: deployed
- production bootstrap: complete
- webhook: registered
- `/status`: live smoke check passed

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
