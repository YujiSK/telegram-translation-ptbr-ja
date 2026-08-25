# ADR 0002: Multi-provider translation routing

- **Status:** Accepted; implementation pending
- **Date:** 2026-08-25

## Context

The bot reached live Phase 9 traffic after Phase 8B activation. The Telegram bot, Cloudflare Worker, remote D1 schema, Secrets, bootstrap state, and webhook are live, and `/status` works end to end in the pilot family group.

After Telegram Group Privacy was disabled and the bot was removed/re-added to the group, ordinary messages also reached the Worker. The current OpenAI-only translation path then ended in a `TransientUpstreamError` and posted no translation reply.

The product goal is now to avoid routine paid OpenAI usage. Available/considered capacity includes Cloudflare Workers AI's daily-renewing free allowance, a Gemini project whose 2026-08-25 AI Studio dashboard shows Gemini 3.5 Flash Lite at **15 RPM / 250K TPM / 500 RPD**, and an existing DeepL account whose exact API entitlement still needs verification.

## Decision

Adopt a vendor-independent provider router while preserving the existing `TranslationRequest` / `TranslationOutcome` application contract.

Routing priority:

1. **Deterministic Worker policy first** — webhook verification, command routing, allowlist, dedupe, length/rate/usage checks, and any safe non-model logic.
2. **Cloudflare Workers AI for routine inference** — routine JA↔PT-BR translation, language/style output, and an internal confidence / `needsEscalation` decision.
3. **Gemini 3.5 Flash Lite for escalation** — only for low-confidence, context-sensitive, or otherwise harder cases.
4. **DeepL as an optional translation-specific fallback or benchmark** — only after the actual account's API plan/quota and data-processing terms are confirmed.
5. **OpenAI retained as a disabled-by-default emergency/compatibility fallback** — not part of routine operation.

Provider fan-out is bounded. A normal message must not call every configured provider. Escalation/fallback triggers and maximum attempts are explicit, testable policy.

## Invariants that remain unchanged

- Commands never invoke an AI provider.
- Only Japanese and Brazilian Portuguese are translated; other languages return a validated skip outcome.
- At most one replied-to message is used as context; no broader thread/history is fetched.
- Conversation text is never persisted in D1.
- Speaker memory remains scoped to `(chat_id, user_id)` and explicit preferences outrank observed style.
- Raw provider response types, raw errors, prompts, source text, and translated text do not leak into domain types or logs.
- A successful Telegram reply is never retried merely because a best-effort speaker-style write later fails.

## Quota and cost policy

Provider quotas are operational inputs, not domain constants.

- Gemini 3.5 Flash Lite's 15 RPM / 250K TPM / 500 RPD values are the project's observed free-tier limits on 2026-08-25. They may change and must be read from Google AI Studio before tuning or rollout.
- Workers AI's daily allowance should be treated as the routine inference budget and observed in provider-specific units.
- DeepL quota must be read from the actual account before it becomes a production dependency.
- OpenAI routine spend is disabled by policy. Enabling OpenAI is an explicit operational decision.

## Privacy consequence

Provider choice is also a privacy decision. The router may send only the current message, at most one replied-to message, and resolved low-risk speaker-memory hints. It must never send Telegram IDs, bot/webhook/admin Secrets, unrelated D1 rows, or stored conversation history.

Gemini Free Tier data-treatment implications must be reviewed and accepted before live family-message escalation is enabled. A quota dashboard value is not itself privacy approval.

## Consequences

- Add provider adapters plus a routing policy layer; keep application/domain types vendor-independent.
- Workers AI may return internal confidence/escalation metadata, but that metadata stays inside provider/router infrastructure unless the domain explicitly needs a normalized concept.
- Existing Phase 7 OpenAI-specific rate/usage naming will likely need to be generalized to provider-aware counters/budgets.
- Gemini and optional DeepL credentials/bindings are new external actions and require separate approval.
- Do not delete the existing OpenAI implementation until the replacement has passed the resumed pilot; retaining it lowers rollback risk without requiring routine use.

## Rejected alternatives

- **Gemini for every message:** simpler, but wastes the 500 RPD escalation budget and ignores Workers AI's daily allowance.
- **DeepL for every message plus a second model call for language/style:** translation-specialized, but often creates two calls and weakens the current single structured decision path.
- **Delete OpenAI immediately:** reduces code surface, but removes a tested rollback path before the new router completes pilot validation.
