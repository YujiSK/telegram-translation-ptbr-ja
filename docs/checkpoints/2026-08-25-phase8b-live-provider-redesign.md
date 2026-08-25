# 2026-08-25 — Phase 8B live activation and provider-redesign checkpoint

This checkpoint records the first real deployment/pilot state without storing any real Secret, Telegram user ID, Telegram chat ID, or family message text.

## Phase 8B completed

- Telegram bot created and added to the pilot family group.
- Four original Cloudflare production Secrets registered; values are not recorded here.
- Remote D1 migrations `0002_speaker_memory.sql`, `0003_commands.sql`, and `0004_reliability.sql` applied successfully.
- Worker deployed and `GET /health` returned HTTP 200.
- Production admin/chat bootstrap returned `bootstrap-complete`; read-only D1 verification showed one admin and one enabled chat.
- Telegram webhook registered to the deployed `/telegram/webhook` route with `allowed_updates=["message"]`; `getWebhookInfo` showed zero pending updates and no webhook error.
- Live `/status` command succeeded end to end.

## Telegram Group Privacy finding

Initially commands reached the bot while ordinary group messages did not. `getMe` confirmed the bot was allowed to read all group messages, but the Group Privacy change had not effectively applied to the existing group membership.

After Group Privacy was disabled in BotFather and the bot was removed/re-added to the group, ordinary messages reached the Worker.

## First live translation finding

The first observed ordinary-message translation reached the Worker and entered the translation path, but the structured Worker log ended with:

- `outcome`: `internal_error`
- error class: `TransientUpstreamError`
- service: `openai`
- Worker response: HTTP 500

No translation reply was posted.

A separate local OpenAI `GET /v1/models` check using the configured API key returned HTTP 200, so the key itself was valid. The live failure therefore remains specific to the translation request/provider path rather than simple key authentication.

## Product decision

Do not continue the pilot by paying for routine OpenAI traffic. Adopt the provider direction recorded in ADR 0002:

**Workers AI routine → Gemini 3.5 Flash Lite escalation → optional DeepL fallback/benchmark → OpenAI disabled-by-default emergency fallback.**

The Google AI Studio project dashboard observed on 2026-08-25 shows Gemini 3.5 Flash Lite free-tier limits of **15 RPM / 250K TPM / 500 RPD**. These are operational observations and may change.

## Current phase state

- Phases 0–8B: complete.
- Phase 9 pilot: started, then paused.
- Next implementation slice: Phase 9.1 multi-provider translation router.
- Broader pilot traffic: wait until Phase 9.1 is implemented, reviewed, deployed, and smoke-tested.
