# Phase 9.1 — Multi-provider translation plan

Status: **Phase 9.1A (provider abstraction + Workers AI routine path)
implemented and tested locally/in CI — not deployed; review-hardened
(see "Phase 9.1A review hardening" below). Gemini escalation (Phase
9.1B) and DeepL remain accepted design, not started.**

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

Escalation provider only.

Use when Workers AI reports low confidence or the router recognizes a bounded complexity condition such as context-sensitive wording, ambiguous short phrases, or speaker-memory-sensitive rendering.

Observed project free-tier quota on 2026-08-25:

- 15 RPM
- 250K TPM
- 500 RPD

These values come from the project's Google AI Studio dashboard. They are not permanent product guarantees and must not be hard-coded. Operational checks should read the current project quota before tuning or broader rollout.

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
3. ~~Add bounded escalation metadata/policy.~~ **Done (Phase 9.1A) — escalation is detected and routed to `EscalationRequiredError`; no escalation target exists yet (step 4 below).**
4. Add Gemini 3.5 Flash Lite adapter. **Not started (Phase 9.1B).**
5. Generalize provider usage/rate accounting and structured logs.
6. Add provider-routing tests covering routine, escalation, transient failure, permanent malformed response, and no-fan-out behavior.
7. Review privacy/security changes.
8. Run `npm run check` and CI.
9. Separately approve/register any new provider credentials/bindings.
10. Deploy the router.
11. Resume live pilot with JA→PT-BR, PT-BR→JA, untargeted-language, speaker-memory, and at least one escalation case.
12. Only after pilot evidence, decide whether DeepL or OpenAI fallback should be live at all.

## Completion criteria

Phase 9.1 is complete when:

- automated tests and CI are green;
- routine messages can complete through Workers AI;
- a controlled difficult case escalates to Gemini and succeeds;
- provider fan-out/attempt limits are demonstrably bounded;
- provider usage is observable without sensitive-text logging;
- privacy review for live Gemini escalation is recorded;
- DeepL entitlement is either verified and explicitly integrated, or documented as deferred;
- OpenAI routine usage is disabled by default;
- resumed pilot results are recorded with a go/no-go recommendation for broader use.
