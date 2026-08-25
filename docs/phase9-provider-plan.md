# Phase 9.1 — Multi-provider translation plan

Status: **Phase 9.1A (provider abstraction + Workers AI routine path)
implemented and tested locally/in CI — not deployed; review-hardened
(see "Phase 9.1A review hardening" below). Phase 9.1B (Gemini semantic
escalation) implemented and tested locally/in CI — not deployed; live
escalation remains disabled by default and requires separate
approvals before enabling (see "Phase 9.1B implementation record"
below). DeepL remains accepted design, not started.**

This file is the current working plan for the provider transition discovered during the first live Phase 9 pilot. If an older document still says Phase 8B is pending or that the Worker/webhook is not deployed, the 2026-08-25 checkpoint and this plan are the newer operational record.

## Phase 9.1A implementation record

**Implemented (this task):** `src/infrastructure/translation/{provider.ts,router.ts}`
(`createTranslationRouter`, `TranslationProvider`,
`ProviderTranslationCandidate` with a fixed-enum `EscalationReason` — no
floating-point confidence score), `src/infrastructure/workers-ai/{client.ts,translate.ts}`
(the Workers AI adapter, calling `env.AI.run()` via the narrow
`WorkersAiBinding` interface, with `AbortSignal`-based timeout and
best-effort Cloudflare-documented error-code classification), and
`src/prompts/{translation-shared.ts,translation-workers-ai.ts}` (shared
prompt content with the existing OpenAI prompt, plus the Workers AI JSON
Schema extending the v1 schema with `needsEscalation`/`escalationReason`).
`TRANSLATION_PROVIDER` (`workers-ai` | `openai`) and `WORKERS_AI_MODEL`
are new non-secret `wrangler.jsonc` vars; `OPENAI_MODEL` is retained,
required only in `openai` mode. `workers-ai` is now the default and the
live production Worker's config target once deployed, but **no deploy
happened as part of this task** — see `README.md`, "Deployment state".

**Explicitly not implemented by this task, per its own scope:** Gemini
3.5 Flash Lite escalation (Phase 9.1B), DeepL, and any production
deployment of this code. When `needsEscalation` is true, the router
throws `EscalationRequiredError` (200, outcome
`ignored:escalation-unavailable`, dedupe reservation kept, no reply) —
there is no escalation target to call yet. `TranslationRouterMode` calls
exactly one provider per message; there is no automatic Workers AI →
OpenAI fallback, satisfying the "bounded fan-out" rule below without
Gemini existing yet.

**Test/mock discipline:** every automated test (`test/infrastructure/workers-ai/`,
`test/infrastructure/translation/`, `test/prompts/translation-workers-ai.test.ts`,
`test/handlers/telegram-webhook-workers-ai.test.ts`) injects a fake
`WorkersAiBinding` — `npm run check` never performs a real `env.AI.run()`
call. `vitest.config.ts` sets `remoteBindings: false` so the test pool
itself never attempts a live Cloudflare connection for the `AI` binding
either. A real local-dev Workers AI inference (`npm run dev`, manual use)
may consume real free-allocation quota; this is a known, accepted
operational cost of local development, not something CI incurs.

## Phase 9.1A review hardening

A targeted review pass (separate task, same phase) checked the Workers
AI adapter against this repo's actual generated Cloudflare types
(`worker-configuration.d.ts`, `Base_Ai_Cf_Zai_Org_Glm_4_7_Flash` and its
`ChatCompletionsMessagesInput`/`ChatCompletionsOutput` contract) rather
than an OpenAI-compatibility assumption, and re-evaluated the Workers AI
call-layer error-classification policy:

- **Direct-binding request/response contract:** confirmed correct as
  originally implemented — `response_format: { type: "json_schema",
json_schema: { name, schema, strict } }` and a response envelope of
  `choices[0].message.content` both match the generated
  `ResponseFormatJSONSchema`/`ChatCompletionsOutput` types exactly. This
  is now type-checked, not just manually verified: `src/infrastructure/workers-ai/translate.ts`
  annotates the request's `response_format` value with the generated
  `ResponseFormatJSONSchema` type, so `npm run typecheck` fails if the
  contract ever drifts. See `docs/architecture.md`, "Workers AI adapter".
- **Message role:** `"developer"` confirmed correct and kept — the
  generated `ChatCompletionMessageParam` type explicitly lists
  `DeveloperMessage` as a supported direct-binding role for this model,
  so this was never an OpenAI-compatibility assumption. Documented with
  a citing comment and a dedicated regression test in
  `test/prompts/translation-workers-ai.test.ts`.
- **Call-layer error classification (the actual behavior change):**
  `classifyWorkersAiError` (`src/infrastructure/workers-ai/client.ts`)
  used to default an unrecognized failure to permanent (fail closed).
  That risked permanently dropping a message on a genuine transient
  binding/network blip that didn't happen to mention a known HTTP-
  equivalent code. The policy is now inverted: only a positively
  identified deterministic signal (a documented permanent code, or
  wording like "invalid model"/"unauthorized"/"model not found") is
  permanent; every other call-layer failure — including a completely
  unrecognized shape — is transient, so a Telegram redelivery can retry
  it. A **malformed but successfully-returned** model response is a
  separate, still-permanent code path (`translate.ts`'s `malformed()`
  helper) and is unaffected by this change — validation failures are
  never made retryable.
- Live production validation of this contract still requires a
  separately approved deployment — this hardening pass verified the
  adapter against generated types and automated tests only, aligned to
  Cloudflare's documented/generated direct-binding contract, not a real
  Workers AI call.

## Phase 9.1B implementation record

**Implemented (this task):** Gemini 3.5 Flash Lite as the **semantic
escalation** provider for a Workers AI `needsEscalation: true` candidate
— `src/infrastructure/gemini/{client.ts,translate.ts}` (a fetch-based
Interactions API client, no SDK — see "No Gemini SDK" below) and
`src/prompts/translation-gemini.ts` (reuses `translation-shared.ts`'s
provider-neutral semantics and `translation-v1.ts`'s
`TRANSLATION_JSON_SCHEMA` directly, since Gemini's output contract has
no escalation concept of its own). `src/infrastructure/translation/router.ts`
now calls Gemini — with the **original** `TranslationRequest`, never
Workers AI's provisional translation or reasoning — only when a `gemini`
boundary is actually supplied to it; "is `gemini` configured" is the
router's sole signal for "is escalation available," so the router itself
never reads config directly (docs/architecture.md, "Translation provider
router"). New non-secret config: `GEMINI_ESCALATION_ENABLED` (strict
`"true"`/`"false"`, required only in `workers-ai` mode),
`GEMINI_MODEL`/`MAX_GEMINI_ATTEMPTS_PER_MINUTE`/`MAX_GEMINI_ATTEMPTS_PER_DAY`
(required only when escalation is enabled) — all added to
`src/config/app-config.ts`'s `AppConfig` (never to the command path,
which still never calls `validateAppConfig` at all). `GEMINI_API_KEY`
is deliberately **not** part of `AppConfig` — it is a Secret, read
directly from `env` only inside the webhook's `workers-ai`-mode wiring,
and only actually checked lazily (inside the Gemini attempt-budget
reservation closure, itself only invoked when Workers AI actually
requests escalation) — so a routine, non-escalating Workers AI
translation never requires it, even with escalation enabled but Gemini
setup incomplete.

**New D1 schema:** `migrations/0005_provider_usage.sql` adds
`provider_usage_counters`, a generic analog of Phase 7's
`rate_limit_counters` for Gemini's global (not per-chat) minute/day
attempt budget — see `docs/data-model.md`. The existing OpenAI-specific
`rate_limit_counters`/`openai_daily_usage` tables are untouched.

**Bounded fan-out, unchanged in spirit from Phase 9.1A:** for
`workers-ai` mode, at most 2 logical providers are ever called per
message (Workers AI alone, or Workers AI then Gemini) — a Workers AI
transient/permanent/malformed failure never reaches Gemini (the router
only reads `needsEscalation` from a candidate Workers AI actually
returned successfully); a Gemini failure never falls through to OpenAI;
`openai` mode is completely unaffected and still calls OpenAI only.

**Budget-exhausted / misconfigured escalation is still a safe, no-reply
outcome**, not an error: when Workers AI requests escalation but Gemini
is disabled, its Secret is missing, or its app-side budget is exhausted,
the webhook responds 200 `ignored:escalation-unavailable` (dedupe
reservation kept) — Gemini is never called, and OpenAI is never used as
a substitute.

**Explicitly not implemented, per this task's own scope:** DeepL, any
third `TRANSLATION_PROVIDER` mode for Gemini, and any production
deployment/Secret registration/remote migration. Live Gemini escalation
requires three separate future approvals before it can actually run
against family messages: `GEMINI_API_KEY` registration, an explicit
acceptance of Gemini Free Tier's data-treatment terms (see "Gemini Free
Tier privacy boundary" below — `store: false` alone is not that
acceptance), and a separately approved deploy. None of the three
happened as part of this task.

**Test/mock discipline:** every automated test
(`test/infrastructure/gemini/`, `test/infrastructure/d1/provider-usage-counters.test.ts`,
`test/infrastructure/translation/router.test.ts`,
`test/prompts/translation-gemini.test.ts`,
`test/handlers/telegram-webhook-gemini.test.ts`) injects a fake `fetch`
or D1 spy — `npm run check` never performs a real Gemini, Workers AI, or
OpenAI API call. The exact Interactions API request/response contract
used (endpoint, `system_instruction`/`input` as plain strings,
`response_format`, `steps[].content[].text` extraction) is this task's
best-effort interpretation of the operational facts supplied when the
task was prepared — outbound access to `ai.google.dev` was blocked in
this implementation environment, so it could not be re-verified against
live Google documentation; re-verification is required before any live
Gemini call is made. See `src/infrastructure/gemini/client.ts`'s module
doc comment for the full detail.

## Goal

Run the family translation bot primarily within free or very low-cost allowances, while preserving higher-quality handling for difficult context and keeping the application/domain layers vendor-independent.

## Target routing

```text
Telegram message
    ↓
Deterministic Worker policy
    ├─ command / disabled / duplicate / too long / untargeted safe exit
    ↓
D1 speaker-memory read
    ↓
Workers AI routine provider
    ├─ high confidence → validated translation → Telegram reply
    └─ low confidence / complex context
                 ↓
        Gemini 3.5 Flash Lite
                 ↓
        validated translation → Telegram reply

Optional failure/benchmark path: DeepL
Emergency compatibility path: OpenAI, disabled by default
```

## Provider roles

### Cloudflare Workers AI

Primary routine path.

Responsibilities:

- Japanese / Brazilian-Portuguese / other-language decision when model assistance is actually needed.
- Routine JA↔PT-BR translation.
- Low-risk style signals needed by the existing speaker-memory flow.
- Internal confidence / `needsEscalation` decision.

Why primary:

- Existing Worker already runs on Cloudflare.
- The free allowance renews daily, which matches daily conversation traffic better than relying only on a monthly pool.
- No additional external API key is required for the Worker-native binding.

The exact model is an implementation/pilot decision. Do not hard-code a model into domain types.

### Gemini 3.5 Flash Lite

**Implemented (Phase 9.1B), disabled by default; not live.** Escalation
provider only — called by `src/infrastructure/translation/router.ts`
when Workers AI's structured output itself reports `needsEscalation:
true` (one of the six fixed `EscalationReason` values: ambiguous
context, meaningful mixed-language text, correction-sensitive rendering,
a style-preference/message-tone conflict, or general low confidence).
Never called for an infrastructure/availability failure of Workers AI
itself — see `docs/architecture.md`, "Semantic escalation vs.
infrastructure failure".

App-side attempt ceilings (`MAX_GEMINI_ATTEMPTS_PER_MINUTE=12`,
`MAX_GEMINI_ATTEMPTS_PER_DAY=450`) are configured below the observed
project free-tier quota on 2026-08-25:

- 15 RPM
- 250K TPM
- 500 RPD

These values come from the project's Google AI Studio dashboard. They are not permanent product guarantees and must not be hard-coded. Operational checks should read the current project quota before tuning or broader rollout. `GEMINI_ESCALATION_ENABLED=false` is the current default (`wrangler.jsonc`) — live escalation requires separate `GEMINI_API_KEY` registration, an explicit Free Tier data-treatment acceptance, and a separately approved deploy (see "Phase 9.1B implementation record" above).

### DeepL

Optional translation-specific fallback or quality comparator.

Do not assume API availability merely because an older DeepL account exists. Before integration:

1. confirm the actual API product/plan on the account;
2. confirm the current character quota and reset/billing behavior;
3. confirm data-processing terms for family-message content;
4. decide whether DeepL is failure fallback, benchmark-only, or an explicit translation mode.

DeepL should not force a second model call on every routine message solely to recover language/style metadata.

### OpenAI

Keep the existing implementation temporarily for rollback/compatibility, but make it disabled by default once the router lands.

Routine pilot/production traffic must not use OpenAI unless explicitly enabled. Enabling it is both a cost decision and an external operational decision.

## Application contract

Preserve the existing vendor-independent concepts:

- `TranslationRequest`
- `TranslationOutcome`
- `translate-and-reply` orchestration
- speaker-memory resolution

Add provider adapters and a router rather than teaching application code about Workers AI, Gemini, DeepL, or OpenAI wire formats.

**Implemented shape (Phase 9.1A)**, in
`src/infrastructure/translation/provider.ts` — infrastructure-only, never
imported by `domain/` or `application/`:

```ts
interface ProviderTranslationCandidate {
  outcome: TranslationOutcome;
  needsEscalation: boolean;
  escalationReason: EscalationReason; // fixed enum, "none" when needsEscalation is false
}
```

This differs from the original planning shape above in one deliberate
way: there is no floating-point `confidence` field. The model reports a
boolean `needsEscalation` plus a fixed-enum `escalationReason` directly
(part of the same structured-output contract as the translation itself),
rather than a numeric score the router would have to threshold — this
avoids inventing an arbitrary confidence cutoff and keeps the value
easy to log safely (an enum, never a raw number derived from unvalidated
model output).

## Bounded fan-out policy

A message must never call all configured providers by default.

The router must define and test:

- maximum logical providers per message;
- maximum HTTP/model attempts per provider;
- which error classes permit fallback;
- which confidence/complexity conditions permit escalation;
- when fallback is forbidden because a reply may already have been sent.

The existing dedupe rule remains central: once a translation reply has succeeded, later best-effort failures must never trigger a duplicate reply.

## Provider-aware usage controls

Phase 7 currently contains OpenAI-specific attempt counters and limits. Phase 9.1 should generalize usage accounting enough to observe and cap the new routing plan without losing the existing protections.

Minimum observability, without message content:

- selected provider;
- outcome class;
- escalation yes/no;
- attempt count;
- latency;
- provider-specific budget/quota bucket where available;
- normalized error class/service.

Do not log prompts, source messages, translated text, correction terms, display names, raw provider responses, API keys, or Telegram Secrets.

## Privacy policy

No provider receives more context than the current design already permits:

- current source message;
- at most one replied-to message;
- resolved low-risk speaker-memory hints/corrections relevant to that message.

Never send stored conversation history, Telegram IDs, bot tokens, webhook/admin Secrets, or unrelated D1 rows.

Gemini Free Tier data-treatment implications must be explicitly reviewed before live escalation is enabled for family messages. A free quota is not automatically a privacy approval.

DeepL data-processing terms must likewise be confirmed for the actual API plan before live fallback is enabled.

## External setup boundary

Phase 8B approvals do not automatically authorize Phase 9.1 provider setup.

Potential new external actions include:

- adding the Workers AI binding/configuration;
- creating/registering `GEMINI_API_KEY`;
- creating/registering `DEEPL_AUTH_KEY` if DeepL is actually selected;
- deploying the provider-router version of the Worker;
- enabling Gemini/DeepL/OpenAI fallbacks in production config.

Each external mutation/credential registration remains separately approved.

## Implementation sequence

1. ~~Refactor translation-provider interface/router with the existing OpenAI adapter still passing tests.~~ **Done (Phase 9.1A).**
2. ~~Add Workers AI adapter and structured validation.~~ **Done (Phase 9.1A).**
3. ~~Add bounded escalation metadata/policy.~~ **Done (Phase 9.1A) — escalation is detected and routed to `EscalationRequiredError`; Phase 9.1B then added the actual escalation target.**
4. ~~Add Gemini 3.5 Flash Lite adapter.~~ **Done (Phase 9.1B) — implemented and tested locally/in CI only; `GEMINI_ESCALATION_ENABLED=false` by default, so it is not live.**
5. ~~Generalize provider usage/rate accounting and structured logs.~~ **Done (Phase 9.1B) — `provider_usage_counters` (D1), `provider`/`escalationReason`/`limitType` fixed-enum log fields.**
6. ~~Add provider-routing tests covering routine, escalation, transient failure, permanent malformed response, and no-fan-out behavior.~~ **Done (Phase 9.1B) — see `docs/phase9-provider-plan.md`, "Phase 9.1B implementation record".**
7. ~~Review privacy/security changes.~~ **Done (Phase 9.1B) — `store: false` enforced unconditionally by the client, no conversation state, no raw response/API-key logging; a live Free Tier data-treatment decision is still pending, see step 9.**
8. ~~Run `npm run check` and CI.~~ **Done (Phase 9.1B).**
9. Separately approve/register any new provider credentials/bindings. **Not done — `GEMINI_API_KEY` is not registered.**
10. Deploy the router (with Gemini escalation, if approved). **Not done.**
11. Resume live pilot with JA→PT-BR, PT-BR→JA, untargeted-language, speaker-memory, and at least one escalation case. **Not done — pending step 9/10.**
12. Only after pilot evidence, decide whether DeepL or OpenAI fallback should be live at all. **Not started.**

## Completion criteria

Phase 9.1 is complete when:

- automated tests and CI are green; **— met (Workers AI: Phase 9.1A; Gemini: Phase 9.1B).**
- routine messages can complete through Workers AI; **— met, locally/in CI.**
- a controlled difficult case escalates to Gemini and succeeds; **— met against mocked contract tests only (Phase 9.1B); not yet demonstrated against a real Gemini call.**
- provider fan-out/attempt limits are demonstrably bounded; **— met, tested directly (router.test.ts, "maximum logical providers per message is 2").**
- provider usage is observable without sensitive-text logging; **— met.**
- privacy review for live Gemini escalation is recorded; **— the code-level `store: false`/no-conversation-state design is recorded (Phase 9.1B), but the actual go/no-go privacy decision to enable it against real family messages has not been made.**
- DeepL entitlement is either verified and explicitly integrated, or documented as deferred; **— documented as deferred, still not started.**
- OpenAI routine usage is disabled by default; **— met (`workers-ai` is the default `TRANSLATION_PROVIDER`).**
- resumed pilot results are recorded with a go/no-go recommendation for broader use. **— not reached; no deploy has happened.**
