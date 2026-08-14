# Implementation Plan

**Current phase: Phase 3 completed; Phase 4 not started.** The local
webhook boundary (Secret verification, parsing, allowlist/dedupe wiring)
and the mockable Telegram `sendMessage` client are implemented and
tested locally, with `npm run check` and CI green — that is Phase 3's
complete scope. Telegram Bot creation, Cloudflare Secret registration,
Worker deployment, and Telegram webhook registration are external,
human-approved actions that belong to **Phase 8**, not to Phase 3's
completion criteria — see Phase 3 and Phase 8 below.

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
  Yuji's own ID as the initial admin).
- **次フェーズへ進む前の停止点:** Stop once all listed commands are
  implemented and tested. Confirm before the reliability/security
  hardening phase.

---

## Phase 7 — Reliability and security

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
  decision, not a technical one).
- **次フェーズへ進む前の停止点:** Stop once reliability/security work is
  implemented and tested. Confirm before deployment preparation.

---

## Phase 8 — Deployment preparation

**This is the phase that owns the four external actions deferred since
Phase 3:** creating the Telegram bot (BotFather), registering
`OPENAI_API_KEY`/`TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`/
`SETUP_ADMIN_SECRET` as real Cloudflare Secrets, deploying the Worker,
and registering the Telegram webhook. None of them happen automatically
just because Phase 8 starts — each one is still a separate,
explicit-approval action per `CLAUDE.md`; Phase 8 is where they're
documented and, once approved individually, performed.

- **目的:** Make the project ready to deploy, and — once each step is
  separately approved — perform the deferred external setup: bot
  creation, Secret registration, Worker deployment, and webhook
  registration.
- **実装内容:** Finalize Cloudflare Binding configuration in
  `wrangler.jsonc` (D1, and anything else needed); document the exact
  Secret-registration steps (`wrangler secret put` for each of the four
  planned Secrets); document the D1 migration-apply procedure for a real
  (non-local) database; propose (design only, or implement if explicitly
  approved) a GitHub → Cloudflare auto-deploy workflow; design the
  webhook-setup step, gated behind `SETUP_ADMIN_SECRET`. Then, only after
  explicit approval for each individual action: create the Telegram bot,
  run `wrangler secret put` for each Secret, run `wrangler deploy`, and
  register the Telegram webhook.
- **前提条件:** Phase 7 complete.
- **完了条件:** A documented, reviewed runbook exists for every step
  above; the bot exists, all four Secrets are registered, the Worker is
  deployed, and the webhook is registered — each performed only after
  its own explicit separate approval, per `CLAUDE.md`.
- **テスト:** Any new endpoint (e.g., webhook-setup) gets the same
  unit/integration test treatment as prior phases, run against local
  dev before any real deploy.
- **Yujiによる手動作業:** Approve each external action individually
  (bot creation, each Secret, the deploy, the webhook registration) —
  these are exactly the "external service changes" that require
  explicit approval per `CLAUDE.md`; approving one does not imply
  approval for the others.
- **次フェーズへ進む前の停止点:** Stop before any real `wrangler deploy`
  to production, any real `wrangler secret put`, and any real Telegram
  webhook registration — all require Yuji's explicit go-ahead, granted
  separately from this plan.

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
- **前提条件:** Phase 8 complete, and Yuji has explicitly approved and
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
