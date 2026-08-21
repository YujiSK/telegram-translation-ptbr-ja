# Implementation Plan

**Current phase: Phase 7 completed; Phase 8A (deployment preparation)
completed — every external action deferred to Phase 8B, pending its own
separate approval; Phase 8 as a whole is not Completed. Phase 9 not
started.** OpenAI
translation local implementation: Completed. Structured Outputs mock
tests: Completed. Telegram reply orchestration mock tests: Completed.
Speaker Memory local schema: Completed. Memory repository: Completed.
Effective memory resolution: Completed. Prompt v2: Completed. Mock/local
D1 tests: Completed. Command surface (`/help`, `/status`, `/profile`,
`/remember`, `/forget`, `/forgetme`, `/correct`, `/enable`, `/disable`):
Completed, local schema (`migrations/0003_commands.sql`, `bot_admins`)
and mock/local D1 tests only. Reliability/security hardening (concurrent
dedupe verification, per-chat inbound rate limit, per-chat and global
daily OpenAI attempt limits, structured logging, security regression
tests): Completed, local schema (`migrations/0004_reliability.sql`,
`rate_limit_counters`, `openai_daily_usage`) and mock/local D1 tests
only. Remote `0002_speaker_memory.sql`, `0003_commands.sql`, and
`0004_reliability.sql` migrations: Pending until Phase 8B. Deployment
preparation (production bootstrap endpoint `POST /admin/bootstrap`,
deployment/migration/Secret-registration/webhook-registration runbooks,
external-action approval matrix): Completed (Phase 8A), local schema
unchanged (no new migration — see `migrations/0004_reliability.sql`
above) and mock/local D1 tests only. Real family profile data: Not
stored (only synthetic fixtures exist in tests). Real OpenAI/Telegram
API test: Not performed (all Phase 4/5/6/7/8A tests use a mocked
OpenAI/Telegram HTTP response, per design). Telegram Bot creation,
Cloudflare Secret registration, remote D1 migrations, production
admin/chat bootstrap, Worker deployment, and Telegram webhook
registration: all Pending Phase 8B, each requiring its own separate
approval — see Phase 3, Phase 4, Phase 5, Phase 6, Phase 7, and Phase 8
below.

Rule for every phase (see `docs/project-rules.md` rules 13–14): implement
one phase at a time, verify with `npm run check` before moving to the
next, and stop at the phase's stopping point until a human explicitly
says to continue. Do not start Phase N+1 work while Phase N is open.

Each phase below lists: purpose, what gets implemented, prerequisites,
completion criteria, tests, manual work for Yuji, and the stopping point
before the next phase.

---

## Phase 0 — Foundation

**Status: completed.**

- **目的 (Purpose):** Stand up project conventions, documentation, tooling,
  and a minimal deployable-shape Worker, with nothing product-specific
  implemented yet.
- **実装内容 (Implementation):** Project rules and docs (this file,
  `architecture.md`, `data-model.md`, `security-and-privacy.md`,
  `operations.md`, ADR 0001), `README.md`, `CLAUDE.md`, `AGENTS.md`, the
  `telegram-translation-project` Claude Skill, a minimal `src/index.ts`
  (`GET /health` + 404), test/lint/format/typecheck tooling, and CI.
- **前提条件 (Prerequisites):** Empty repository (confirmed at the start
  of this work).
- **完了条件 (Completion criteria):** All Phase 0 files exist; `npm run
check` passes; no Secrets present anywhere in the repo; CI config
  exists and mirrors `npm run check`; no D1 migration, Telegram, or
  OpenAI integration exists yet.
- **テスト (Tests):** `GET /health` returns 200 with the documented JSON
  body; unknown paths return 404; tests run inside the Workers runtime
  (`@cloudflare/vitest-pool-workers`), not plain Node; no network calls
  occur during tests.
- **Yujiによる手動作業 (Manual work for Yuji):** Review and merge this
  foundation; nothing external to set up yet (no Cloudflare/Telegram/
  OpenAI accounts required for Phase 0 itself, though having them ready
  before Phase 8–9 will help).
- **次フェーズへ進む前の停止点 (Stop before next phase):** Stop after
  Phase 0 is verified complete. Do not begin Phase 1 without an explicit
  go-ahead.

---

## Phase 1 — Domain and configuration

**Status: completed.** Implemented as `src/domain/{language,speaker,translation,telegram-update}.ts`,
`src/shared/errors.ts`, `src/config/app-config.ts`, and
`src/infrastructure/telegram/parse-update.ts`, with tests under the
mirrored `test/` paths. `npm run check` is green; see the commit that
introduced this status line for the exact diff.

- **目的:** Establish the vendor-independent type vocabulary and
  configuration validation the rest of the app will build on.
- **実装内容:** `domain/` types (e.g., detected language, translation
  request/result shapes, speaker identity shape used internally);
  `config/` module that reads and validates non-secret configuration
  (fails fast on missing/invalid config rather than defaulting silently);
  a shared error-type hierarchy (`shared/` or `domain/`, TBD in-phase) for
  distinguishing validation errors, upstream-service errors, and
  transient/retryable errors; a converter from raw Telegram Update JSON
  into an internal, minimal, validated type (no D1/OpenAI/Telegram client
  calls involved yet — pure parsing).
- **前提条件:** Phase 0 complete and verified.
- **完了条件:** Domain types compile with no dependency on
  `infrastructure/*`; config validation has unit tests for both valid and
  invalid input; Telegram Update conversion has unit tests covering at
  least one text message and one non-text/unsupported update shape;
  `npm run check` green.
- **テスト:** Unit tests only (Vitest, Workers runtime pool) — no real
  Telegram/OpenAI/D1 calls, since none of those integrations exist yet.
- **Yujiによる手動作業:** None required yet.
- **次フェーズへ進む前の停止点:** Stop once domain/config/error types and
  the Update converter are implemented and tested. Confirm before moving
  to D1.

---

## Phase 2 — D1

**Status: completed.** The first migration contains
`allowed_chats`, `processed_updates`, and `speaker_profiles`; the D1
repositories and Workers-runtime tests are implemented. The remote D1 resource
exists, its real `database_id` is configured, and `0001_initial.sql` has been
applied remotely. No Worker has been deployed.

- **目的:** Stand up the actual database and the repository layer that
  reads/writes it, per `docs/data-model.md`.
- **実装内容:** First D1 migration, covering the Phase 2-ready subset in
  `docs/data-model.md`; `infrastructure/d1/` repository functions for: allowlist
  lookup, `processed_updates` check/record (dedupe), and speaker-profile
  read/write. All queries parameterized (`docs/project-rules.md` rule 3).
  D1 binding (`DB`) added to `wrangler.jsonc` for the first time; local
  dev uses `--local` D1.
- **前提条件:** Phase 1 complete; a Cloudflare account with D1 access
  available (Yuji — see manual work below) for creating the actual
  database resource, even though this phase's local dev/tests can run
  against local D1 without it.
- **完了条件:** Migration applies cleanly locally (`wrangler d1
migrations apply --local`); repository functions have tests using local
  D1 via the Workers Vitest integration; no SQL is string-interpolated;
  `npm run check` green.
- **テスト:** Vitest tests against local D1 (`applyD1Migrations` in a test
  setup file, per Cloudflare's Vitest+D1 integration pattern) — covering
  allowlist hit/miss, dedupe hit/miss, and profile read/write round-trip.
- **Yujiによる手動作業:** Completed — Yuji created the actual D1 database,
  supplied its non-secret database name and ID, and explicitly applied
  `0001_initial.sql` remotely with Wrangler.
- **次フェーズへ進む前の停止点:** Reached. Migration + repository layer are
  implemented and tested locally, and the real `database_id` is wired in.
  Stop here and obtain explicit confirmation before starting Telegram
  integration. The separately approved remote migration was completed on
  2026-08-14.

---

## Phase 3 — Telegram

**Status: completed.** The webhook boundary (`POST /telegram/webhook`),
Secret verification, allowlist/dedupe wiring, and a mockable
`sendMessage` client are implemented as `src/handlers/telegram-webhook.ts`,
`src/infrastructure/telegram/{webhook-secret,client,send-message}.ts`,
and `src/env.d.ts`, with tests under the mirrored `test/` paths,
`npm run check` green, and CI green. That is Phase 3's full scope —
creating the Telegram bot (BotFather), registering
`TELEGRAM_WEBHOOK_SECRET`/`TELEGRAM_BOT_TOKEN` as real Cloudflare
Secrets, deploying the Worker, and registering the Telegram webhook are
**not** part of Phase 3's completion criteria. Those four external,
human-approved actions belong to Phase 8 (see below) and were correctly
not performed here.

- **目的:** Receive and validate real Telegram webhook traffic, and be
  able to post a reply — without any translation logic yet.
- **実装内容:** `handlers/` webhook entry point; Secret verification via
  `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`
  (reject before any other processing); text extraction from the Update
  (reusing Phase 1's converter); `infrastructure/telegram/` Bot API
  client (typed, timeout-bound); reply-posting capability (used later by
  Phase 4, but built and tested here against a stubbed/mocked Bot API).
- **前提条件:** Phase 2 complete (dedupe/allowlist available to gate
  processing).
- **完了条件:** Webhook handler rejects requests with a missing/incorrect
  Secret header; valid requests are parsed and deduped via Phase 2's
  repository; Bot API client has a bounded timeout and typed
  request/response; `npm run check` green. The webhook is **not**
  registered with Telegram yet (that's Phase 8) — this phase only makes
  the endpoint correct in isolation.
- **テスト:** Unit/integration tests using mocked/fetch-intercepted
  Telegram API responses — no live Telegram account traffic. Cases:
  correct Secret accepted, wrong/missing Secret rejected, duplicate
  `update_id` short-circuited, non-allowlisted chat ignored.
- **Yujiによる手動作業:** Create the Telegram bot via BotFather and
  obtain its token, for use starting in this phase's local testing
  (`.dev.vars`, never committed). Provide a real chat ID for later
  allowlisting (used starting Phase 8/9, but convenient to gather now).
- **次フェーズへ進む前の停止点:** Stop once webhook verification, parsing,
  dedupe, and a working (but not-yet-registered) Bot API client are
  implemented and tested. Confirm before adding OpenAI.

---

## Phase 4 — OpenAI translation

**Status: completed.** OpenAI translation local implementation:
Completed. Structured Outputs mock tests: Completed. Telegram reply
orchestration mock tests: Completed. Implemented as
`src/prompts/translation-v1.ts` (versioned prompt + strict Structured
Outputs JSON Schema), `src/infrastructure/openai/{client,translate}.ts`
(Responses API call with timeout + capped transient-only retry, response
validation, and domain conversion), `src/application/translate-and-reply.ts`
(the translate-then-reply use case), the webhook integration in
`src/handlers/telegram-webhook.ts` (length check, Secret-presence check,
and the dedupe-reservation-release policy for transient failures — see
`docs/architecture.md`, "Dedupe and retry after a transient failure"),
and the non-secret `ENVIRONMENT`/`OPENAI_MODEL`/
`MAX_TRANSLATABLE_MESSAGE_LENGTH` vars in `wrangler.jsonc`, with tests
under the mirrored `test/` paths, `npm run check` green, and CI green.
Real OpenAI API test: Not performed — every test uses a mocked OpenAI
HTTP response, by design (no live OpenAI spend in CI or in this local
implementation work). Speaker memory: Not started (Phase 5). Telegram
Bot creation, Secret registration, Worker deployment, and Telegram
webhook registration remain Pending until Phase 8, unchanged from Phase 3.

- **目的:** Implement the actual translation capability: one OpenAI
  request per message, producing language detection + translation +
  low-risk style features.
- **実装内容:** `infrastructure/openai/` Responses API client with
  Structured Outputs (a single JSON-schema-constrained call that performs
  language detection and translation together — no separate
  detection-only call); `prompts/` versioned prompt template(s) for
  JA↔PT-BR translation, tone/emoji/name preservation, and
  skip-if-untargeted-language behavior; timeout + limited retry (network
  failure/429/5xx only, capped attempts, per `docs/project-rules.md`
  rules 6–8); output validation that rejects — and never retries or
  posts — a response with a JSON parse failure or a schema mismatch,
  since validation/parsing failures are never retried (rule 7).
- **前提条件:** Phase 3 complete (so a real message can flow in and a
  reply can flow out once this phase wires them together).
- **完了条件:** A JA input and a PT-BR input each produce a correctly
  targeted translation via the Structured Outputs schema in tests; a
  third-language input is correctly classified as "don't translate";
  timeout and retry-cap behavior is exercised by tests (e.g., simulated
  slow/failing responses); no raw prompt or message text is logged;
  `npm run check` green.
- **テスト:** Unit/integration tests against a mocked OpenAI HTTP
  response (no live OpenAI spend in CI). Cases: JA→PT-BR, PT-BR→JA,
  untargeted-language skip, malformed-response handling, timeout
  handling, retry-cap exhaustion.
- **Yujiによる手動作業:** Provide an OpenAI API key for local
  `.dev.vars` testing (never committed); be aware this phase's local
  testing may incur small real OpenAI costs if tests are run against the
  live API rather than mocks (tests are designed to use mocks — live
  testing is optional and manual).
- **次フェーズへ進む前の停止点:** Stop once translation end-to-end
  (Telegram in → OpenAI → Telegram reply out) works in local/dev testing
  with mocked or manually-triggered live calls. Confirm before speaker
  memory.

---

## Phase 5 — Speaker memory

**Status: completed.** Speaker Memory local schema: Completed (`migrations/0002_speaker_memory.sql`,
applied and verified locally with `wrangler d1 migrations apply --local`
— not applied remotely). Memory repository: Completed
(`src/infrastructure/d1/{speaker-profiles,speaker-preferences,translation-corrections}.ts`).
Effective memory resolution: Completed (`src/domain/speaker-memory.ts`,
independently unit-tested — explicit-over-observed priority,
`selectApplicableCorrections`). Prompt v2: Completed
(`src/prompts/translation-v2.ts`, `translation-v1.ts` untouched and still
independently tested). Mock/local D1 tests: Completed, `npm run check`
green and CI green. Webhook integration
(`src/handlers/telegram-webhook.ts`, `src/application/translate-and-reply.ts`):
memory read before the OpenAI call, observed-style write best-effort
after a successful Telegram reply — see `docs/architecture.md`. No real
family profile data exists anywhere in this repository; every fixture
used in tests is an obviously synthetic ID/term. No real OpenAI/Telegram
API call has been made.

- **目的:** Make translations reflect stored, per-speaker
  preferences/style, with explicit settings always overriding
  auto-derived ones.
- **実装内容:** Read path: resolve a speaker's effective settings by
  merging `speaker_profiles` (auto-derived, low-risk) with
  `speaker_preferences` (explicit) and `translation_corrections`,
  explicit-always-wins, before building the OpenAI prompt; write path:
  update `speaker_profiles`' low-risk auto-derived fields from the same
  OpenAI response that already extracts them (Phase 4), without a second
  API call; memory-priority logic isolated so it's independently testable
  (see `docs/security-and-privacy.md` — explicit over inferred).
- **前提条件:** Phase 4 complete.
- **完了条件:** A speaker with an explicit preference gets that
  preference honored even when auto-derived signals would suggest
  otherwise (tested explicitly); a speaker with no explicit preference
  falls back to auto-derived style; corrections from
  `translation_corrections` are applied when present; `npm run check`
  green.
- **テスト:** Unit tests for the merge/priority function in isolation
  (no live services needed), plus integration tests confirming the
  merged settings actually reach the OpenAI prompt construction step.
- **Yujiによる手動作業:** None beyond ongoing review.
- **次フェーズへ進む前の停止点:** Stop once memory read/write and
  priority resolution are implemented and tested. Confirm before adding
  commands.

---

## Phase 6 — Commands

**Status: completed.** All nine commands (`/help`, `/status`, `/profile`,
`/remember`, `/forget`, `/forgetme`, `/correct`, and admin-only
`/enable`/`/disable`) are implemented as a pure parser
(`src/commands/parse-command.ts`, `src/commands/types.ts`), pure
plain-text response builders (`src/commands/responses.ts`), and a
boundary-injected orchestration use case
(`src/application/execute-command.ts`) wired into the webhook handler
(`src/handlers/telegram-webhook.ts`) alongside — and completely separate
from — the Phase 4/5 translation flow: a command message never reaches
OpenAI, the message-length check, or the speaker-memory read/write path.
Admin authorization is a new local-only `bot_admins` table
(`migrations/0003_commands.sql`), read via
`src/infrastructure/d1/bot-admins.ts`; the three-state chat lookup
(`getAllowedChatState`) and `setAllowedChatEnabled` in
`src/infrastructure/d1/allowed-chats.ts` implement the "`/enable`
exception on a disabled-but-known chat, never on an unknown chat" rule.
`/forgetme confirm` deletes `speaker_profiles`, `speaker_preferences`,
and `translation_corrections` for the caller's `(chat_id, user_id)` as
one atomic `db.batch()` (`src/infrastructure/d1/forget-me.ts`). All D1
mutations reachable from a command are idempotent and wrapped in
`runD1Query` for the same transient/permanent classification Phase 5
established for reads, so the dedupe-reservation release policy extends
correctly to command failures — see docs/architecture.md. `npm run
check` green (423 tests) and CI green. The remote `0003_commands.sql`
migration has **not** been applied — verified with `--local` only, same
as `0002_speaker_memory.sql` (Phase 8).

**Review hardening (post-completion, same phase):** an independent
review found two edge cases, both fixed without changing Phase 6's
scope or design — `npm run check` green (439 tests) and CI green:

1. `/disable`'s Telegram reply failing _after_ its D1 mutation already
   succeeded used to release the dedupe reservation like any other
   command, but a redelivery could never actually reach the command path
   again (the chat is disabled now, and the webhook drops every update
   for a disabled chat except a valid `/enable`) — so the reservation is
   now kept instead, specifically for that one case (`/enable` and every
   other command are unaffected). See docs/architecture.md, "`/disable`
   reply-failure dedupe exception".
2. `/help`, `/status`, `/profile`, `/enable`, and `/disable` used to
   silently ignore a trailing argument (e.g. `/enable garbage` parsed as
   a valid `/enable`); they now reject it as a `usage-error`, which also
   closes a gap where such an argument could otherwise have been
   misread as a valid `/enable` by the disabled-chat exception. See
   `src/commands/parse-command.ts`.

- **目的:** Implement the Telegram command surface for status, profile
  management, memory management, and admin control.
- **実装内容:** `commands/` implementations for `/status`, `/profile`,
  `/remember`, `/forget`, `/forgetme`, `/correct`, `/help`, and
  admin-only `/enable` / `/disable` (with the authorization check from
  `docs/security-and-privacy.md`); command dispatch wired into the
  webhook handler from Phase 3.
- **前提条件:** Phase 5 complete (commands operate on the same
  profile/preference/correction tables).
- **完了条件:** Each command has at least one success-path and one
  failure/authorization-denied-path test (where applicable); `/forgetme`
  actually removes the documented rows (`docs/data-model.md`); `/enable`
  and `/disable` are rejected for non-admin callers; `npm run check`
  green.
- **テスト:** Integration tests per command against local D1 and mocked
  Telegram/OpenAI as needed. No live external calls in CI.
- **Yujiによる手動作業:** Decide/provide the concrete admin
  identification mechanism if it requires a real Telegram user ID (e.g.,
  Yuji's own ID as the initial admin) — **deferred to Phase 8**: Phase 6
  implements only the runtime `bot_admins` read path and local-only
  schema; registering the first real admin row (and any
  `SETUP_ADMIN_SECRET`-gated bootstrap route) is Phase 8 work, per
  docs/security-and-privacy.md.
- **次フェーズへ進む前の停止点:** Reached. All listed commands are
  implemented and tested. Confirm before the reliability/security
  hardening phase.

---

## Phase 7 — Reliability and security

**Status: completed.** Concurrent dedupe correctness under simultaneous
delivery is verified with a repository-level `Promise.all` test asserting
exactly one successful reservation for a shared `update_id`
(`test/infrastructure/d1/repositories.test.ts`) — no application-side
mutex is used (that would not work across Cloudflare isolates); D1's own
atomic `INSERT`/`PRIMARY KEY` conflict is the sole correctness mechanism,
unchanged from Phase 2/3. Rate limiting and cost control are implemented
entirely on the existing D1 `DB` binding (no new Cloudflare Rate Limiting
binding or other remote service this phase): a per-chat inbound
handled-update limit (`MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE`, default
60/minute, checked after dedupe so a Telegram redelivery is never
double-counted), a per-chat OpenAI attempt burst limit
(`MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE`, default 20/minute), and a
global daily OpenAI attempt ceiling (`MAX_OPENAI_ATTEMPTS_PER_DAY`,
default 300/UTC day) — all three new non-secret `wrangler.jsonc` vars,
validated by a dedicated `validateReliabilityConfig()`
(`src/config/reliability-config.ts`) kept separate from
`validateAppConfig()` so the command path still never depends on OpenAI
translation config, preserving the Phase 6 property. Both limits count
real OpenAI HTTP attempts (including internal client retries), not
logical translation requests, via an injectable `beforeAttempt` guard on
`callOpenAiResponses` (`src/infrastructure/openai/client.ts`) — the
webhook builds the D1-backed closure so `infrastructure/openai` never
imports D1 directly. New local-only migration
`migrations/0004_reliability.sql` adds `rate_limit_counters` (one row per
`(scope_type, scope_id)`, reset in place on window rollover — never grows
unbounded) and singleton `openai_daily_usage`; both use an atomic
UPSERT-with-`RETURNING` statement so increment/reset is a single SQL
statement, verified against local D1
(`test/infrastructure/d1/reliability-counters.test.ts`). Exceeding a
limit responds 200 with `ignored:rate-limited` or `ignored:usage-limit`
and **keeps** the dedupe reservation (via new `RateLimitExceededError`/
`UsageLimitExceededError`, safe control-flow signals distinct from
`TransientUpstreamError`), so a redelivery is a plain duplicate instead of
repeating work. Structured logging
(`src/shared/structured-log.ts`) funnels every webhook request's single
final outcome through one allowlisted-field logger — message text,
translated text, full command text, correction terms, display names,
prompts, raw OpenAI/Telegram responses, Secrets, and raw
`Error.message`/stack traces are never logged; `classifyError()` extracts
only `error.name` and, for upstream errors, `service`. A new security
regression suite
(`test/handlers/telegram-webhook-security.test.ts`) covers the threat
table in `docs/security-and-privacy.md`: prompt-injection-shaped message
text (reaches OpenAI only as user-content data, never becomes a command),
a SQL-injection-shaped `/correct` term (safely parameterized, schema and
other rows untouched), sensitive-data-at-rest (no message/translated-text/
raw-response column anywhere in the local D1 schema, including the new
migration), log-based leak (captured `console.log` output never contains
synthetic message/Secret/error text), and unauthorized-chat access
creating no rate-limit counter row. The Phase 6 review-fix `/disable`
mutation-succeeded-then-reply-fails-transiently ⇒ 500 + dedupe-kept
behavior is unchanged (its dedicated regression test still passes). `npm
run check` green (538 tests) and CI green. Remote application of
`migrations/0004_reliability.sql`, and all deploy/setup actions, remain
Pending until Phase 8, unchanged from Phase 6.

- **目的:** Harden the bot for real (if small-scale) production traffic:
  dedupe correctness under load, rate/usage limits, structured logging,
  and a security-focused test pass.
- **実装内容:** Confirm/extend duplicate-update-processing prevention
  under concurrent delivery; rate limiting (per-chat and/or global) and a
  usage/cost ceiling for OpenAI calls (`docs/security-and-privacy.md`);
  structured logging with the log-minimization rules from
  `docs/security-and-privacy.md` (no message text, no Secrets); explicit
  error classification (validation vs. transient vs. permanent) feeding
  consistent retry/no-retry behavior; a security-focused test pass
  covering the threat list in `docs/security-and-privacy.md`.
- **前提条件:** Phase 6 complete.
- **完了条件:** Rate limit and usage ceiling are enforced and tested
  (including the "safe failure" behavior when exceeded); structured logs
  contain no message text or Secrets (verified by test/inspection); the
  security test pass covers each row of the threat table in
  `docs/security-and-privacy.md`; `npm run check` green.
- **テスト:** Unit tests for rate-limit/usage-ceiling logic; targeted
  security tests (e.g., forged webhook Secret, SQL-injection-shaped
  input, oversized/malformed payloads) — all still without live external
  spend.
- **Yujiによる手動作業:** Decide concrete rate-limit/usage-ceiling
  numbers appropriate for a family-scale deployment (this is a product
  decision, not a technical one). Initial values (60/20/300) were chosen
  as family-scale-appropriate safe defaults without real production usage
  data; tune them after the Phase 9 pilot via the non-secret
  `wrangler.jsonc` vars — no code change needed.
- **次フェーズへ進む前の停止点:** Reached. Rate limiting, usage ceiling,
  structured logging, and the security regression pass are implemented
  and tested. Confirm before deployment preparation.

---

## Phase 8 — Deployment preparation

**This is the phase that owns the nine external actions deferred since
Phase 3** (see `docs/operations.md`, "External action approval matrix",
units A–I: Telegram bot creation; registering
`OPENAI_API_KEY`/`TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`/
`SETUP_ADMIN_SECRET` as real Cloudflare Secrets — four separate units;
applying the pending remote D1 migrations; the production admin/chat
bootstrap; deploying the Worker; and registering the Telegram webhook).
None of them happen automatically just because Phase 8 starts — each one
is still a separate, explicit-approval action per `CLAUDE.md`. Phase 8 is
split into two sub-phases, tracked separately because their risk profile
is completely different: **Phase 8A** (preparation — code, tests, and
runbooks only, zero external side effects) and **Phase 8B** (the nine
external actions themselves, each performed only after its own separate
approval).

**Phase 8A status: completed.** Implemented as
`src/handlers/admin-bootstrap.ts` (the `POST /admin/bootstrap`
production-bootstrap endpoint, routed in `src/index.ts` completely
separately from `/telegram/webhook`), composed from three new modules:
`src/infrastructure/admin/setup-secret.ts` (the `X-Setup-Admin-Secret`
header check, `SETUP_ADMIN_SECRET`-gated, fail-closed before any body
read or D1 access), `src/domain/bootstrap.ts` (the pure
`adminUserId`/`chatId` request parser), and
`src/infrastructure/d1/bootstrap.ts` (`bootstrapAdminAndChat`, one
atomic idempotent `db.batch()` upsert into the existing `bot_admins` and
`allowed_chats` tables — no new migration). The Telegram webhook Secret
check's timing-safe comparison was factored out into
`src/shared/secret-compare.ts` so both Secret checks share one audited
implementation. `docs/operations.md` is now the deployment runbook's
canonical source: the external-action approval matrix, first-deployment
ordering, Telegram bot creation steps, a per-Secret registration runbook
(source/registration/verification/rotation/revoke for each of the four
Secrets), the Secret-generation requirements (values not yet generated),
the remote-migration runbook (plus rollback/backup-check guidance), the
Worker-deployment runbook (predeploy checklist), real-Telegram-ID
acquisition guidance, the bootstrap-call procedure, the webhook
-registration runbook (a documented manual operator `setWebhook` call,
not a second runtime endpoint — see `docs/security-and-privacy.md`,
"Webhook registration strategy", for why no such endpoint was built),
post-deploy smoke checks, an emergency-stop procedure, and the
auto-deploy non-decision (not implemented before the Phase 9 pilot).
`npm run check` green (583 tests) and CI green. **Zero external side
effects performed:** no real Telegram bot, no real Secret, no remote D1
mutation, no real admin/chat ID, no Worker deploy, no webhook
registration — every runbook command in `docs/operations.md` uses only
`<PLACEHOLDER>` values.

- **目的:** Make the project ready to deploy, and — once each step is
  separately approved — perform the deferred external setup: bot
  creation, Secret registration, remote migrations, production
  admin/chat bootstrap, Worker deployment, and webhook registration.
- **実装内容 (Phase 8A, completed):** the `POST /admin/bootstrap`
  endpoint and its tests (local D1 only); the full deployment runbook in
  `docs/operations.md`; the external-action approval matrix; the
  Secret-registration and Secret-generation runbooks (commands
  documented, no real value generated or registered); the remote
  D1 migration-apply runbook (commands documented, `--remote` not run);
  the webhook-registration design decision (manual operator call, no new
  runtime endpoint). **実装内容 (Phase 8B, not started):** only after
  explicit approval for each individual action — create the Telegram
  bot, run `wrangler secret put` for each of the four Secrets, run
  `wrangler d1 migrations apply --remote` for `0002`/`0003`/`0004`, call
  the deployed `/admin/bootstrap` with real IDs, run `wrangler deploy`,
  and register the Telegram webhook.
- **前提条件:** Phase 7 complete (Phase 8A); Phase 8A complete plus each
  individual action's own separate approval (Phase 8B, per action).
- **完了条件 (Phase 8A, reached):** a documented, reviewed runbook exists
  for every Phase 8B step; the bootstrap endpoint is implemented and
  tested against local D1; `npm run check` green; no external action
  performed. **完了条件 (Phase 8B, not reached):** the bot exists, all
  four Secrets are registered, the three pending migrations are applied
  remotely, the production admin/chat is bootstrapped, the Worker is
  deployed, and the webhook is registered — each performed only after
  its own explicit separate approval, per `CLAUDE.md`.
- **テスト:** The bootstrap endpoint gets the same unit/integration test
  treatment as prior phases' endpoints, run against local D1 only
  (`test/domain/bootstrap.test.ts`,
  `test/infrastructure/admin/setup-secret.test.ts`,
  `test/infrastructure/d1/bootstrap.test.ts`,
  `test/handlers/admin-bootstrap.test.ts`) — never against a real deploy.
- **Yujiによる手動作業:** Approve each of the nine Phase 8B external
  actions individually (bot creation, each of the four Secrets, the
  remote migrations, the production bootstrap call, the deploy, the
  webhook registration) — these are exactly the "external service
  changes" that require explicit approval per `CLAUDE.md`; approving one
  does not imply approval for any other, even where "First deployment
  order" in `docs/operations.md` lists them in a specific sequence.
- **次フェーズへ進む前の停止点:** Phase 8A reached and stopped here, as
  instructed. Stop before any real `wrangler deploy` to production, any
  real `wrangler secret put`, any real `wrangler d1 migrations apply
--remote`, any real call to the deployed `/admin/bootstrap`, and any
  real Telegram webhook registration — all Phase 8B, all requiring
  Yuji's explicit go-ahead per action, granted separately from this
  plan.

---

## Phase 9 — Pilot

- **目的:** Validate the bot with real (but limited) usage before calling
  it production-ready.
- **実装内容:** Enable the bot for a single, limited family group;
  exercise a set of prepared JA↔PT-BR test cases; assess translation
  quality subjectively (tone, name/emoji preservation) and objectively
  where possible; measure actual OpenAI cost against expectations;
  compare translation quality/behavior with and without speaker memory
  enabled, to confirm Phase 5 is actually adding value; produce a
  go/no-go recommendation for broader "production" use.
- **前提条件:** Phase 8 complete (both 8A and 8B), and Yuji has explicitly approved and
  performed the real deploy + webhook registration.
- **完了条件:** Pilot test cases run and results recorded; cost figures
  captured; a written go/no-go recommendation exists.
- **テスト:** Manual, real-world usage in the pilot group — this phase is
  itself the test, on top of all automated tests from prior phases
  remaining green.
- **Yujiによる手動作業:** Select the pilot group; participate in and
  observe real usage; make the final go/no-go call.
- **次フェーズへ進む前の停止点:** This is the last phase in this plan.
  Any work beyond pilot validation (broader rollout, new features) is a
  new planning cycle, not an automatic continuation.
