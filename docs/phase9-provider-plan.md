# Phase 9.1 — Multi-provider translation plan

Status: **Accepted design; implementation not started.**

This file is the current working plan for the provider transition discovered during the first live Phase 9 pilot. If an older document still says Phase 8B is pending or that the Worker/webhook is not deployed, the 2026-08-25 checkpoint and this plan are the newer operational record.

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

Possible infrastructure-only result from the routine provider:

```ts
interface ProviderCandidate {
  outcome: TranslationOutcome;
  confidence: number;
  needsEscalation: boolean;
}
```

This is a planning shape, not a required public domain type. Confidence/escalation metadata should stay inside routing infrastructure unless a domain-level need is demonstrated.

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

1. Refactor translation-provider interface/router with the existing OpenAI adapter still passing tests.
2. Add Workers AI adapter and structured validation.
3. Add bounded escalation metadata/policy.
4. Add Gemini 3.5 Flash Lite adapter.
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
