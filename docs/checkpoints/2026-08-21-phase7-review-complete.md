# Phase 7 review-complete checkpoint — 2026-08-21

This checkpoint records the repository state after Phase 7 implementation and independent review, immediately before Phase 8 begins.

## Verified state

- Phase 0–7: Completed.
- Phase 7 independent review: Passed.
- Phase 8 (Deployment preparation): Not started.
- Reviewed Phase 7 commit: `0ea8eec8dc9740c13d5f28da63498b1be025bade` (`feat: harden reliability and security`).
- GitHub Actions run `32446076396`: `completed` / `success`.
- CI verification on the Phase 7 commit: format, lint, typecheck, and test all green.
- Test result: 26 test files, 538 tests passed.

## Phase 7 reliability/security verified

- Concurrent dedupe reservation for identical `update_id` values was verified to admit exactly one winner without introducing an in-memory/global mutex.
- Per-chat inbound handled-update limit is enforced after dedupe reservation, so duplicate Telegram redeliveries do not double-consume quota.
- Per-chat OpenAI attempt burst limit is enforced per real HTTP attempt, including retries.
- Global daily OpenAI usage ceiling is enforced per real HTTP attempt on a UTC-day basis.
- Rate/usage counters use atomic D1 `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` statements and bounded row cardinality.
- Rate-limit/usage-limit safe failures return HTTP 200 and keep the dedupe reservation; transient D1/upstream failures retain the existing 500 + release semantics where retry is useful.
- Structured logging uses an allowlisted schema and does not expose source/translated text, prompts, raw upstream responses, Secret values, raw error messages, or stack traces.
- Prompt-injection-shaped and SQL-injection-shaped inputs are covered by security regression tests.
- The Phase 6 `/disable` post-mutation reply-failure dedupe exception remains intact.

## Configured initial limits

- `MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE=60`
- `MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE=20`
- `MAX_OPENAI_ATTEMPTS_PER_DAY=300`

These are non-secret family-scale initial values and remain tunable through non-secret Worker configuration.

## Deferred / not performed

- Remote `0002_speaker_memory.sql` migration: not applied.
- Remote `0003_commands.sql` migration: not applied.
- Remote `0004_reliability.sql` migration: not applied.
- Telegram bot creation: not performed.
- Cloudflare Secret registration: not performed.
- Worker deployment: not performed.
- Telegram webhook registration: not performed.
- Production initial admin bootstrap: not performed.
- Real OpenAI API call: not performed.
- Real Telegram API call: not performed.
- Real family profile/message data: not stored in the repository.

## Phase 8 boundary

Phase 8 is the next phase and is the first phase that owns deployment preparation and the previously deferred external setup actions.

Preparation work may be implemented and documented without performing external changes. The following real actions require separate explicit approval and must not be bundled together by implication:

1. Create the real Telegram bot through BotFather.
2. Register `OPENAI_API_KEY` as a Cloudflare Secret.
3. Register `TELEGRAM_BOT_TOKEN` as a Cloudflare Secret.
4. Register `TELEGRAM_WEBHOOK_SECRET` as a Cloudflare Secret.
5. Register `SETUP_ADMIN_SECRET` as a Cloudflare Secret.
6. Apply pending D1 migrations to the real remote database (`0002`, `0003`, `0004`).
7. Bootstrap the first real bot admin if the approved design requires writing a real Telegram user ID.
8. Deploy the Worker.
9. Register the Telegram webhook.

Approval of one external action does not authorize any of the others.

Phase 8 must continue to follow `docs/project-rules.md`, `docs/security-and-privacy.md`, and `docs/implementation-plan.md`: direct-to-`main`, no force push, no Secret values committed or echoed, no real family data in the repository, local verification before external changes, and `npm run check` green before completion.
