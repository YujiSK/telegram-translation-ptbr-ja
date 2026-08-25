# telegram-translation-ptbr-ja

A Telegram bot for Japanese ↔ Brazilian Portuguese translation in a family group chat, with speaker-specific tone/preferences, short correction memory, command controls, dedupe, rate/usage safeguards, and privacy-first logging.

## Current status

**Phases 0–8B are complete. Phase 9 pilot started and is currently paused for the Phase 9.1 provider redesign. Phase 9.1A (provider abstraction + Workers AI routine path) and Phase 9.1B (Gemini semantic escalation) are implemented and tested locally/in CI, but neither has been deployed to production, and Gemini escalation is additionally disabled by default even once deployed.**

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
(`src/infrastructure/workers-ai/`); Phase 9.1B adds a Gemini
semantic-escalation adapter (`src/infrastructure/gemini/`). Both phases
are local/CI-only — **no production deploy of this code has happened
yet, and Gemini escalation is additionally disabled by default even
once it is.** `TRANSLATION_PROVIDER` selects exactly one router mode per
message; within `workers-ai` mode, at most 2 logical providers are ever
called (Workers AI, then optionally Gemini) — never a runtime fan-out:

```text
Telegram group
    ↓ webhook
Cloudflare Worker
    ├─ deterministic policy: Secret check / commands / allowlist / dedupe / limits
    ├─ D1 speaker-memory read
    ↓
TRANSLATION_PROVIDER=workers-ai (implemented, now the default)
    ├─ high confidence ──────────────────────────▶ Telegram reply
    └─ needsEscalation=true
             ├─ GEMINI_ESCALATION_ENABLED=false (default) ─▶ ignored:escalation-unavailable (no reply)
             └─ GEMINI_ESCALATION_ENABLED=true  ───▶ Gemini (original request, once) ─▶ Telegram reply

TRANSLATION_PROVIDER=openai (implemented, legacy/compatibility mode only)
    └─▶ Telegram reply, unchanged from Phase 4/5

Not implemented by this task: DeepL
```

Provider roles:

- **Cloudflare Workers AI (implemented, Phase 9.1A; review-hardened):**
  routine translation/inference target, called via the `AI` Worker
  binding (`env.AI.run()`), model `@cf/zai-org/glm-4.7-flash` set through
  the `WORKERS_AI_MODEL` config var — never hard-coded. The
  request/response contract (Structured Outputs JSON Schema shape,
  `choices[0].message.content` envelope, the `"developer"` message role)
  is checked against this repo's actual generated Cloudflare types
  (`worker-configuration.d.ts`), not assumed from OpenAI compatibility —
  aligned to the Cloudflare generated/direct-binding contract and covered
  by automated tests; a live pilot against a real Workers AI call is
  still pending a separately approved deployment. When the model reports
  `needsEscalation: true`, the router either calls Gemini (if configured
  — see below) or throws `EscalationRequiredError` (200, no reply,
  dedupe kept) — never any other provider. An ambiguous or unrecognized
  call-layer failure defaults to transient/retryable rather than
  permanent, so a genuine transient Workers AI blip never permanently
  drops a message — only a positively identified deterministic
  (config/request) failure keeps the dedupe reservation. Local dev
  inference against the real binding may consume real Workers AI
  free-allocation quota; every automated test injects a fake binding
  instead, so `npm run check` never performs a real `env.AI.run()` call.
- **Gemini 3.5 Flash Lite (implemented, Phase 9.1B; disabled by
  default):** semantic-escalation target only — called exactly once,
  with the original `TranslationRequest`, only when Workers AI's own
  structured output reports `needsEscalation: true`; never called as a
  fallback for a Workers AI infrastructure failure. `GEMINI_ESCALATION_ENABLED=false`
  is the current default (`wrangler.jsonc`); `GEMINI_API_KEY` is not
  registered. App-side attempt ceilings
  (`MAX_GEMINI_ATTEMPTS_PER_MINUTE=12`, `MAX_GEMINI_ATTEMPTS_PER_DAY=450`)
  sit below the project dashboard's observed **15 RPM / 250K TPM / 500
  RPD** free-tier quota on 2026-08-25 — operational observations, not
  guarantees, and not hard-coded. `store: false` is force-set on every
  request unconditionally; no conversation state, `previous_interaction_id`,
  streaming, or tools are used. The exact Interactions API request/
  response contract used is a documented best-effort interpretation of
  the operational facts supplied when this task was specified — outbound
  access to `ai.google.dev` was blocked in the implementation
  environment, so it could not be re-verified against live Google
  documentation; see `src/infrastructure/gemini/client.ts`. Live
  escalation against real family messages additionally requires an
  explicit Gemini Free Tier data-treatment decision, separate from the
  code being implemented.
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
- a vendor-independent translation-provider router (Phase 9.1A) with a Workers AI routine adapter, a Gemini semantic-escalation adapter (Phase 9.1B, disabled by default), and a legacy OpenAI adapter, each called exclusively — no automatic fallback between them
- structured logs that exclude message text, translations, prompts, raw provider responses, Secrets, and raw error messages

The command path is completely separate from translation: **commands never invoke an AI provider, regardless of `TRANSLATION_PROVIDER`.**

## Phase 9.1 rules

The provider redesign must preserve these invariants:

1. `domain/` and `application/` remain vendor-independent.
2. A normal message must not call every configured provider; escalation/fallback is bounded and testable. **(Enforced — `workers-ai` mode calls at most 2 providers per message (Workers AI, then optionally Gemini); a Workers AI infrastructure failure never reaches Gemini or OpenAI; a Gemini failure never falls through to OpenAI.)**
3. At most one replied-to message is used as context. No full conversation history is fetched or persisted.
4. D1 never stores family message bodies.
5. Speaker-memory priority remains explicit preference over observed style, per axis.
6. A successful Telegram reply must never be duplicated because a later best-effort write fails.
7. Provider quota/cost data is operational configuration, not a domain constant.
8. New provider credentials/bindings/deploys are separate external actions and require explicit approval. **(Phase 9.1A/9.1B added the `AI` Worker binding and the Gemini adapter to source and config only — neither has been deployed, and `GEMINI_API_KEY` is not registered.)**
9. Gemini Free Tier privacy/data-treatment implications must be reviewed before live family-message escalation is enabled. **(Phase 9.1B: `store: false` is enforced in code, but the actual go/no-go privacy decision for live escalation has not been made — `GEMINI_ESCALATION_ENABLED=false` by default.)**
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
- Gemini Interactions API (`gemini-3.5-flash-lite`) — semantic-escalation provider (Phase 9.1B, implemented but disabled by default)
- Telegram Bot API
- Legacy/compatibility translation provider: OpenAI Responses API (`gpt-4o-mini`), selected via `TRANSLATION_PROVIDER=openai`
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

**Phase 9.1B note:** `GEMINI_API_KEY` is the runtime Secret name the
Gemini semantic-escalation adapter reads (only when
`GEMINI_ESCALATION_ENABLED=true`, and only lazily — a routine,
non-escalating Workers AI translation never requires it). It is
**implemented in source, but not registered** — live escalation also
requires a separate Free Tier data-treatment decision and a deploy, per
"Phase 9.1 rules" above.

```text
GEMINI_API_KEY
```

Potential future addition if DeepL is implemented, **not registered and
not implemented**:

```text
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

**Phase 9.1A (provider router + Workers AI adapter) and Phase 9.1B
(Gemini semantic-escalation adapter) have been implemented and tested
locally/in CI only — neither has been deployed.** No `wrangler deploy`
was run as part of either task; the production Worker still runs the
OpenAI-only Phase 4/5 translation path until a separately approved
deploy happens. Gemini escalation is additionally disabled by default
(`GEMINI_ESCALATION_ENABLED=false`) even once such a deploy happens —
enabling it live requires its own separate approval.

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
