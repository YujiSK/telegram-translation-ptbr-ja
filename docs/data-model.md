# Data Model

Status: **Phase 2, Phase 5, Phase 6, Phase 7, and Phase 9.1B schema
implemented locally; Phase 8B applied migrations `0001`–`0004` to the
remote database (see README.md, "Deployment state").**
`migrations/0001_initial.sql` creates `allowed_chats`, `processed_updates`,
and `speaker_profiles`. `migrations/0002_speaker_memory.sql` (Phase 5)
adds `observed_tone`/`observed_emoji_usage` to `speaker_profiles` and
creates `speaker_preferences` and `translation_corrections`;
`migrations/0003_commands.sql` (Phase 6) creates `bot_admins`;
`migrations/0004_reliability.sql` (Phase 7) creates
`rate_limit_counters` and `openai_daily_usage`; `migrations/0005_provider_usage.sql`
(Phase 9.1B) creates `provider_usage_counters`. All five are verified
with `wrangler d1 migrations apply --local` and by the Workers Vitest
test suite
(`test/infrastructure/d1/{repositories,speaker-memory-repositories,bot-admins,forget-me,reliability-counters,provider-usage-counters}.test.ts`).
`0001`–`0004` were applied to the remote database during Phase 8B;
`0005_provider_usage.sql` (Phase 9.1B) has **not** been applied remotely
— it exists in source and is verified locally/in CI only, per that
task's explicit scope (no external side effect authorized). Applying it
remotely requires the same explicit approval as any other external
action (see `docs/operations.md`).

**No message content anywhere in this schema, confirmed through Phase
7 and re-verified for Phase 9.1B's addition:** neither
`rate_limit_counters`, `openai_daily_usage`, nor `provider_usage_counters`
— nor any table added in any migration — stores a message body, a
translated string, a full prompt, or a raw provider response.
`rate_limit_counters.scope_id` is a Telegram chat ID (an identifier, not
content); `provider_usage_counters.scope_id` is always `0` (a global
scope, not even a chat ID); every other column in these tables is a
provider/scope/window/day identifier, a count, or a timestamp. This is
asserted directly by `test/handlers/telegram-webhook-security.test.ts`,
which inspects every table's live `CREATE TABLE` schema in `sqlite_master`
and fails if any
table gains a column shaped like message/translation/response content.

General privacy rule for every table below: **never store message text,
full OpenAI prompts, or Secrets.** See `docs/security-and-privacy.md` for
the full allow/deny list.

## `allowed_chats`

**Purpose:** Which Telegram chats (groups) the bot is allowed to operate
in. Anything not listed here is ignored.

- **Planned primary key:** `chat_id` (Telegram chat ID)
- **Implemented columns:** `chat_id`, optional human-readable `label`,
  soft `enabled` flag, `created_at`, `updated_at`
- **Must not store:** chat message content, member lists
- **Retention:** kept until an admin disables/removes the chat
- **Index candidates:** primary key lookup only (small table, no
  secondary index expected)
- **Phase 2 decision:** disabling is a soft flag (`enabled = 0`) so the
  allowlist entry can be retained and re-enabled explicitly.
- **Phase 8A:** `POST /admin/bootstrap`
  (`src/infrastructure/d1/bootstrap.ts`) can insert the _first_ row for a
  chat that has none yet — the one sanctioned exception to "no command
  can self-allowlist an unknown chat" (docs/architecture.md, "Command
  routing and chat state"), since it is authenticated by
  `SETUP_ADMIN_SECRET`, not by anything reachable from Telegram. For a
  chat that already has a row, it unconditionally sets `enabled = 1`,
  including re-enabling a previously-`/disable`d chat.

## `speaker_profiles`

**Purpose:** Per-user identity and low-risk linguistic characteristics
used to make translations feel natural for that person.

- **Planned primary key:** `(chat_id, user_id)` composite — **confirmed**.
  A speaker's profile is scoped to a single Telegram group: the same
  person gets a separate profile row in each group the bot is enabled
  for. Profiles are never automatically shared or merged across chats —
  a style/preference learned in one family group has no effect on
  another group, even for the same Telegram user.
- **Implemented columns:** `chat_id`, Telegram `user_id`, display name,
  nullable primary language, nullable `observed_tone`, nullable
  `observed_emoji_usage`, `created_at`, `updated_at`
- **Implemented (Phase 5):** `observed_tone` (`casual`|`neutral`|`formal`)
  and `observed_emoji_usage` (`none`|`light`|`frequent`), added by
  `migrations/0002_speaker_memory.sql` as nullable columns with a SQLite
  `CHECK` constraint each. These hold only the **single latest**
  auto-observed style signal from the most recent successful
  translation — never a history, never a score, never free text. Written
  by `upsertObservedSpeakerStyle` (`src/infrastructure/d1/speaker-profiles.ts`)
  from the same OpenAI response that already produced the translation
  (Phase 4's `StyleSignals`), with no second API call.
- **Must not store:** any inferred personality, health, political,
  religious, or relationship-status data; conversation content
- **Retention:** until the user issues `/forgetme` or an admin removes
  them (scoped to the `(chat_id, user_id)` row(s) that command affects)
- **Index candidates:** primary key lookup on `(chat_id, user_id)`;
  possibly a secondary index on `chat_id` alone for per-chat listing
- **Implemented constraint:** the first migration declares
  `PRIMARY KEY (chat_id, user_id)` to match the confirmed scope above.

## `speaker_preferences`

**Implementation status:** Phase 5 schema implemented
(`migrations/0002_speaker_memory.sql`). **Implemented (Phase 6):** the
`/remember`/`/forget` command surface
(`src/commands/parse-command.ts`, `src/application/execute-command.ts`)
writes and deletes rows in normal operation —
`upsertSpeakerPreference`/`deleteSpeakerPreference` in
`src/infrastructure/d1/speaker-preferences.ts`. Explicit preferences
always take priority over auto-derived features from `speaker_profiles`
(see `docs/security-and-privacy.md` — explicit settings outrank inferred
ones).

- **Implemented primary key:** `(chat_id, user_id, preference_key)`.
- **Implemented columns:** `chat_id`, `user_id`, `preference_key`,
  `preference_value`, `created_at`, `updated_at`.
- **Implemented constraint — fixed enum, not free-form key/value:** a
  single SQLite `CHECK` pins each allowed `preference_key` to its own
  allowed `preference_value` set, so an invalid key or an
  invalid-for-that-key value can never be written:
  - `preference_key = 'tone'` → `preference_value` in `casual`|`neutral`|`formal`
  - `preference_key = 'emoji_usage'` → `preference_value` in `none`|`light`|`frequent`
- **Row-boundary validation:** `parsePreferenceRow` in
  `src/infrastructure/d1/speaker-preferences.ts` independently
  re-checks the same key→value pairing on every row read from D1, as
  defense-in-depth alongside the schema's own `CHECK` constraint — not a
  replacement for it (Phase 5 review, Issue 3-A).
- **Must not store:** free-text explanations, who set it (setter/admin
  identity) — deliberately not added in Phase 5 (privacy minimization);
  Phase 6 can add an audit field in its own migration if a concrete need
  arises.
- **Retention:** until removed via `/forget tone` / `/forget emoji_usage`
  (single key, `deleteSpeakerPreference` — idempotent, a no-op if the key
  was never set) or `/forgetme confirm` (all of a user's data in this
  chat, see `forgetSpeakerData` below) — both implemented in Phase 6.
- **Index candidates:** primary key lookup above (small table).

## `translation_corrections`

**Implementation status:** Phase 5 schema implemented
(`migrations/0002_speaker_memory.sql`). **Implemented (Phase 6):** the
`/correct` command writes rows in normal operation
(`upsertTranslationCorrection`), and `/forget correction <source_language>
<target_language> <source_term>` deletes one
(`deleteTranslationCorrection` — idempotent, a no-op if the correction
was never stored) — both in
`src/infrastructure/d1/translation-corrections.ts`.

**Purpose:** A short term/phrase correction dictionary — never a message
or translation archive — applied to future translations (e.g., preferred
renderings of names, in-jokes).

- **Implemented scope decision:** `(chat_id, user_id)` — a correction is
  private to the user who made it, within the chat it was made in. It is
  never shared with other users automatically, and never shared across
  chats, even for the same user.
- **Implemented primary key:**
  `(chat_id, user_id, source_language, target_language, source_term)`.
  Re-submitting the same source term in the same direction for the same
  `(chat_id, user_id)` updates `target_term` in place (upsert) rather
  than creating a second row — this is the schema's conflict-resolution
  mechanism; no separate merge logic exists.
- **Implemented columns:** `chat_id`, `user_id`, `source_language`,
  `target_language`, `source_term`, `target_term`, `created_at`,
  `updated_at`.
- **Implemented constraint — direction:** a `CHECK` allows only
  `ja → pt-br` or `pt-br → ja`; a same-language pair or an `other`
  direction is rejected at the SQL boundary.
- **Implemented constraint — term length:** `source_term` and
  `target_term` must each be non-empty after `trim()` and at most 100
  characters. 100 is a conservative ceiling for a name, nickname, or
  short fixed phrase — generous enough for real corrections, small
  enough to make storing an entire message here structurally impossible.
  If a future phase needs a different ceiling, change the `CHECK` in a
  new migration and document the reason there.
- **Must not store:** the full original message the correction came from
  — only the specific term/phrase pair being corrected.
- **Retention:** until removed via `/forget correction <source_language>
<target_language> <source_term>` (deletes one correction by its full
  composite key; idempotent — a no-op if it was never stored) or
  `/forgetme confirm` (all of a user's corrections in this chat). This
  closes the Phase 5 open question: no separate `/uncorrect` command was
  added — deletion is unified under `/forget`, per
  `docs/implementation-plan.md` Phase 6.
- **Index candidates:** the primary key above already supports the
  Phase 5 read pattern (all corrections for a `(chat_id, user_id)`,
  optionally filtered by direction, ordered by `updated_at DESC,
source_language ASC, target_language ASC, source_term ASC` — see
  `listTranslationCorrections` in
  `src/infrastructure/d1/translation-corrections.ts`). The extra
  tie-breaker columns beyond `updated_at DESC` make the ordering fully
  deterministic: two corrections in opposite directions can otherwise
  share both `updated_at` and `source_term`, which would make the
  20-item cap (`MAX_PROMPT_CORRECTIONS` in
  `src/domain/speaker-memory.ts`) select a non-reproducible subset at
  the boundary (Phase 5 review, Issue 4).
- **Row-boundary validation:** `parseCorrectionRow` in
  `src/infrastructure/d1/translation-corrections.ts` independently
  re-checks direction (`ja`↔`pt-br` only) and term length (non-empty,
  ≤100 chars) on every row read from D1, as defense-in-depth alongside
  the schema's own `CHECK` constraints — not a replacement for them
  (Phase 5 review, Issue 3-B).

## `processed_updates`

**Purpose:** Deduplication — Telegram may redeliver the same webhook
update; this table prevents double-processing.

- **Planned primary key:** `update_id` (Telegram's own ID)
- **May store:** `update_id`, `processed_at`
- **Must not store:** anything about the update's content
- **Retention:** time-boxed (e.g., a rolling window of N days), since
  Telegram redelivery windows are bounded — exact TTL is an **open
  question** for Phase 2/7
- **Index candidates:** primary key lookup only
- **Implemented columns:** `update_id` primary key and `processed_at`.
- **Deferred decision:** an explicit retention window/cleanup job was
  considered in Phase 7 but not implemented — this table's atomic
  `INSERT`-with-`PRIMARY KEY`-conflict is what Phase 7's concurrent
  dedupe verification exercises (see `docs/architecture.md`, "Concurrent
  dedupe correctness"), but pruning old rows remains an open question for
  a future phase; D1 has no native TTL.

## `rate_limit_counters`

**Implementation status:** Phase 7 schema implemented
(`migrations/0004_reliability.sql`); read/written via
`consumeChatHandledUpdateLimit`/`consumeChatOpenAiAttemptLimit` in
`src/infrastructure/d1/reliability-counters.ts`.

**Purpose:** Backs two independent per-chat rate limits — the inbound
handled-update limit and the OpenAI attempt burst limit (see
`docs/architecture.md`, "Rate limiting and usage ceilings") — using a
single small table instead of one row per request.

- **Implemented primary key:** `(scope_type, scope_id)` — one row per
  scope, never one row per request or per time window, so the table
  never grows unbounded. A window rollover overwrites the existing row's
  `window_id` and resets `request_count` in place.
- **Implemented columns:** `scope_type`, `scope_id` (a Telegram chat ID),
  `window_id` (an integer minute-bucket, `Math.floor(nowMs / 60_000)`,
  computed by `src/shared/time-windows.ts`), `request_count`,
  `updated_at`.
- **Implemented constraint:** `scope_type` is a fixed `CHECK` enum —
  `'chat_updates'` (the inbound handled-update limit) or `'chat_openai'`
  (the OpenAI attempt burst limit) — and `request_count >= 0`.
- **Must not store:** message content, command text, or anything beyond
  the chat ID, a window identifier, and a count.
- **Atomicity:** every read-and-increment is a single UPSERT-with-
  `RETURNING` SQL statement, never a separate read then write — see
  `docs/architecture.md`, "Atomic counter storage".
- **Retention:** indefinite, but bounded in size by design — at most one
  row per `(scope_type, scope_id)` pair ever exists, regardless of how
  many requests or how much time passes.
- **Index candidates:** primary key lookup only (small table, one row per
  active chat per scope).

## `openai_daily_usage`

**Implementation status:** Phase 7 schema implemented
(`migrations/0004_reliability.sql`); read/written via
`consumeDailyOpenAiAttemptLimit` in
`src/infrastructure/d1/reliability-counters.ts`.

**Purpose:** Backs the single global daily OpenAI attempt ceiling (see
`docs/architecture.md`, "Rate limiting and usage ceilings") — a
cost/runaway-usage guardrail shared across every chat, not a per-chat
limit.

- **Implemented primary key:** `singleton`, `CHECK (singleton = 1)` — by
  design there is exactly one row, ever; a day rollover overwrites
  `day_id` and resets `attempt_count` in place instead of inserting a
  new row.
- **Implemented columns:** `singleton`, `day_id` (an integer UTC-day
  bucket, `Math.floor(nowMs / 86_400_000)`, computed by
  `src/shared/time-windows.ts` — UTC, not local time, so there is no
  timezone dependency), `attempt_count`, `updated_at`.
  `attempt_count >= 0` is enforced by a `CHECK`.
- **Must not store:** anything beyond the day identifier and a count —
  no per-chat breakdown (that's what `rate_limit_counters`' `chat_openai`
  scope is for).
- **Atomicity:** same UPSERT-with-`RETURNING` pattern as
  `rate_limit_counters` — see `docs/architecture.md`, "Atomic counter
  storage".
- **Retention:** indefinite, but exactly one row, always.
- **Index candidates:** none needed (single-row table).

## `provider_usage_counters`

**Implementation status:** Phase 9.1B schema implemented
(`migrations/0005_provider_usage.sql`); read/written via
`consumeGeminiMinuteAttemptLimit`/`consumeGeminiDailyAttemptLimit` in
`src/infrastructure/d1/provider-usage-counters.ts`.

**Purpose:** A generic, provider-aware analog of `rate_limit_counters` —
backs the app-side Gemini semantic-escalation attempt ceilings (global
minute + global daily), deliberately a new table rather than a rewrite
of the OpenAI-specific `rate_limit_counters`/`openai_daily_usage` above,
which remain unchanged and still back the legacy OpenAI attempt limits
(see `docs/phase9-provider-plan.md`, "Why not rewrite existing OpenAI
tables").

- **Implemented primary key:** `(provider, scope_type, scope_id)` — one
  row per scope, never one row per request or per time window, exactly
  like `rate_limit_counters`. A window rollover overwrites the existing
  row's `window_id` and resets `attempt_count` in place.
- **Implemented columns:** `provider`, `scope_type`, `scope_id` (always
  `0` for the two global scopes Phase 9.1B uses — there is no per-chat
  Gemini budget in this phase), `window_id` (an integer minute- or
  day-bucket, computed by `src/shared/time-windows.ts`), `attempt_count`,
  `updated_at`.
- **Implemented constraint:** both `provider` and `scope_type` are
  tightly `CHECK`-constrained to the values Phase 9.1B actually uses —
  `provider IN ('gemini')`, `scope_type IN ('global_minute',
'global_day')` — and `attempt_count >= 0`. Extending either `CHECK` is
  a future migration, not a speculative allowance added now.
- **Must not store:** message content, prompts, or anything beyond the
  provider name, a scope/window identifier, and a count.
- **Atomicity:** the same UPSERT-with-`RETURNING` pattern as
  `rate_limit_counters`/`openai_daily_usage` — never a separate read
  then write.
- **Retention:** indefinite, but bounded in size by design — at most one
  row per `(provider, scope_type, scope_id)` combination Phase 9.1B
  actually uses (two rows total: `gemini`/`global_minute` and
  `gemini`/`global_day`), regardless of how many escalations or how much
  time passes.
- **Index candidates:** primary key lookup only (a two-row table for as
  long as Gemini remains the only provider with app-side budget
  tracking).

## `bot_admins`

**Implementation status:** Phase 6 schema implemented
(`migrations/0003_commands.sql`); read via `isBotAdmin` in
`src/infrastructure/d1/bot-admins.ts`.

**Purpose:** The runtime authority for `/enable`/`/disable` admin
authorization (see docs/security-and-privacy.md, "Admin command
authorization") — a fixed allowlist of Telegram user IDs, not tied to
any specific chat.

- **Implemented primary key:** `user_id` (Telegram user ID).
- **Implemented columns:** `user_id`, `created_at`.
- **Implemented constraint:** `CHECK (user_id > 0)`.
- **Must not store:** which chat granted admin status, a display name,
  or any other identifying detail beyond the bare Telegram user ID —
  this table exists purely as a yes/no authorization check.
- **Population:** Phase 6 implemented only the read path (`isBotAdmin`);
  no in-Telegram command writes this table (self-service admin grants
  would be a privilege-escalation risk — see "Retention" below). Phase 8A
  adds the one sanctioned write path: `bootstrapAdminAndChat`
  (`src/infrastructure/d1/bootstrap.ts`), reachable only through
  `POST /admin/bootstrap` — a `SETUP_ADMIN_SECRET`-gated endpoint
  entirely separate from the Telegram command surface (see
  docs/architecture.md, "Bootstrap endpoint"). Phase 8A implements and
  tests this write path against local D1 only; actually calling it
  against the remote database to register the first real admin row is
  Phase 8B work, requiring its own separate approval (approval unit G,
  docs/operations.md) — see docs/security-and-privacy.md for why the
  runtime authorization mechanism itself stays independent of
  `SETUP_ADMIN_SECRET`.
- **Retention:** indefinite until an operator removes a row directly
  (no in-bot command manages this table in Phase 6 — deliberately, since
  self-service admin grants would be a privilege-escalation risk).
- **Index candidates:** primary key lookup only (small table).

## `message_mappings`

**Implementation status:** deferred until a later phase establishes a
concrete edit/correction lookup use case.

**Purpose:** Maps an original Telegram message ID to the bot's translation
reply message ID, so future features (e.g., edits, corrections tied to a
specific translation) can locate the right message pair without storing
its text.

- **Planned primary key:** `(chat_id, source_message_id)`
- **May store:** `chat_id`, `source_message_id`, `bot_message_id`,
  detected source language, `created_at`
- **Must not store:** message text in either language
- **Retention:** time-boxed, similar rationale to `processed_updates`
  (**open question** on exact window)
- **Index candidates:** primary key lookup; possibly `bot_message_id` if
  reverse lookups are needed
- **Open questions:** retention window; whether detected language belongs
  here or is derivable elsewhere

## `bot_settings`

**Implementation status:** not implemented, and not currently planned —
**resolved (Phase 6):** `/enable`/`/disable` use `allowed_chats.enabled`
exclusively (`setAllowedChatEnabled` in
`src/infrastructure/d1/allowed-chats.ts`); no separate `bot_settings`
table was created for this. This section is kept only in case a future
phase needs global (not per-chat) key/value operational settings for an
unrelated reason.

**Purpose (if ever needed):** Small key/value operational settings not
tied to a specific chat or user (e.g., schema/version markers).

- **Planned primary key:** `setting_key`
- **May store:** key, value, `updated_at`, updated-by admin user ID
- **Must not store:** Secrets (Secrets never go in D1 — see
  `docs/security-and-privacy.md`)
- **Retention:** indefinite (operational config)
- **Index candidates:** primary key lookup only

## Phase 5 speaker-memory design decisions (summary)

Recorded here so they don't have to be re-derived from the migration or
code later:

- **`speaker_profiles` scope:** `(chat_id, user_id)` — unchanged since
  Phase 2, now also the scope for the auto-observed `observed_tone`/
  `observed_emoji_usage` columns.
- **`speaker_preferences` scope:** `(chat_id, user_id, preference_key)`
  — same per-chat, per-user scoping as `speaker_profiles`, plus the key.
- **`translation_corrections` scope:** `(chat_id, user_id)` — a
  correction is private to the user who made it, within one chat; never
  auto-shared across users or chats.
- **`speaker_preferences` keys are a fixed enum** (`tone`, `emoji_usage`
  today), each with its own fixed allowed-value enum, enforced by a
  SQLite `CHECK` — never a free-form key/value store.
- **`translation_corrections` holds only short term/phrase pairs** —
  never a full message or a full translation, enforced by a 100-character
  `CHECK` on both `source_term` and `target_term`.
- **Explicit preference always outranks observed style**, resolved
  per-axis (`tone`, `emojiUsage` independently) by
  `resolveEffectiveSpeakerMemory` in `src/domain/speaker-memory.ts` — see
  `docs/architecture.md`, "Key design constraints".
- **Corrections are a separate axis from style preference** — never
  merged into the same explicit-vs-observed priority resolution; applied
  only on a literal source-term match plus a matching language direction.
- **`observed_tone`/`observed_emoji_usage` hold only the latest
  observation, never a history** — each write via
  `upsertObservedSpeakerStyle` fully replaces the previous value; no
  observation-log table exists or is planned.
- **The Phase 5 migration (`0002_speaker_memory.sql`) has not been
  applied to the remote database** — only verified locally
  (`wrangler d1 migrations apply --local`) and by the Workers Vitest
  suite. Applying it remotely is a Phase 8 action.
- **Deletion commands** (`/forget`, `/forgetme`, and a
  correction-specific removal mechanism) were deferred to Phase 6 in
  Phase 5 — Phase 5 only implemented the read/write repository functions
  Phase 6's commands would call. **Implemented (Phase 6)** — see below.
- **Reliability/observability hardening:** Phase 7 added structured
  logging (`docs/architecture.md`, "Structured logging") and rate/usage
  limiting, but did not change the speaker-memory read/write
  success/failure semantics themselves, and retention policies for
  `processed_updates` remain an open question for a future phase — see
  `docs/architecture.md`, "Speaker memory read/write ordering".

## Phase 6 command-surface design decisions (summary)

Recorded here so they don't have to be re-derived from the migration or
code later:

- **`/forgetme` scope, confirmed:** `/forgetme confirm` deletes
  `speaker_profiles`, `speaker_preferences`, and
  `translation_corrections` rows for the caller's own `(chat_id,
user_id)` in the **current chat only** — never Telegram-wide, never
  another user's data (`forgetSpeakerData` in
  `src/infrastructure/d1/forget-me.ts`, atomic via `db.batch()`). Bare
  `/forgetme` (no `confirm`) deletes nothing — it only shows how to
  confirm, as an accidental-deletion guard.
- **`/forgetme` deliberately does not touch `processed_updates`** — that
  table holds no message content, only dedupe bookkeeping keyed by
  `update_id`, so it isn't "a user's data" in the sense `/forgetme`
  promises to delete.
- **`/forgetme` deliberately does not touch `allowed_chats` or
  `bot_admins`** — chat-level and admin-level state belongs to the chat
  and the bot operator, not to an individual user's own data.
- **Correction deletion, confirmed:** `/forget correction
<source_language> <target_language> <source_term>` deletes one
  correction by its full composite key. No separate `/uncorrect` command
  was added — this closes the Phase 5 open question by folding
  correction deletion into `/forget`'s existing grammar.
- **`bot_admins` scope:** global (by `user_id` alone, not per-chat) —
  an admin is an admin in every chat the bot operates in. There is no
  per-chat admin concept in Phase 6.
- **`allowed_chats` remains the sole enable/disable authority** — no
  `bot_settings` table was introduced; see the "resolved" note on
  `bot_settings` above.
- **The Phase 6 migration (`0003_commands.sql`) has not been applied to
  the remote database** — only verified locally
  (`wrangler d1 migrations apply --local`) and by the Workers Vitest
  suite. Applying it remotely is a Phase 8 action, same as
  `0002_speaker_memory.sql`.

## Phase 7 reliability-schema design decisions (summary)

Recorded here so they don't have to be re-derived from the migration or
code later:

- **`rate_limit_counters` is one table backing two independent scopes**
  (`chat_updates`, `chat_openai`), distinguished by `scope_type`, rather
  than two separate tables — both share the exact same
  one-row-per-scope/atomic-UPSERT shape, so a single table with a
  discriminator column was simpler than duplicating the schema and the
  repository logic.
- **Neither counter table ever grows per-request.** This was a hard
  requirement, not an optimization: a naive "insert one row per request"
  design would make both tables grow unboundedly for as long as the bot
  runs. The `PRIMARY KEY (scope_type, scope_id)` / singleton-`CHECK`
  design makes unbounded growth structurally impossible.
- **A blocked (rate-limited or usage-limited) request still increments
  its counter.** This was an explicit, accepted trade-off — the
  alternative (only counting allowed requests) would let a chat retry
  indefinitely within the same window without ever being counted against
  future windows, defeating the limit's purpose.
- **`openai_daily_usage` is global, not per-chat, by design** — it is a
  cost/runaway-usage ceiling for the whole bot, independent of
  `rate_limit_counters`' per-chat `chat_openai` scope, which exists to
  stop one chat from starving the others' share of the daily budget.
- **The Phase 7 migration (`0004_reliability.sql`) has not been applied
  to the remote database** — only verified locally
  (`wrangler d1 migrations apply --local`) and by the Workers Vitest
  suite. Applying it remotely is a Phase 8B action, same as
  `0002_speaker_memory.sql` and `0003_commands.sql`.

## Phase 8A bootstrap-endpoint design decisions (summary)

Recorded here so they don't have to be re-derived from the code later:

- **No new migration, deliberately.** `bootstrapAdminAndChat` writes only
  to `bot_admins` and `allowed_chats`, both already present since Phase
  2/6 — introducing a `0005_*.sql` migration for a feature that needs no
  new column or table would be schema churn for its own sake.
- **One atomic `db.batch()` covering both tables**, not two separate
  writes — an admin registered with no allowlisted chat to administer
  (or vice versa) would leave a deploy in a half-bootstrapped state; see
  docs/architecture.md, "Bootstrap endpoint".
- **Idempotent by construction, not by a pre-check.** The admin insert
  uses `ON CONFLICT (user_id) DO NOTHING` and the chat insert uses
  `ON CONFLICT (chat_id) DO UPDATE SET enabled = 1, ...` — repeating the
  exact same bootstrap request (e.g. an operator retry after an
  ambiguous network response) is always safe and never surfaces a
  constraint-violation error, without the handler needing a separate
  "does this already exist?" read first.
- **Re-enabling a pre-existing disabled chat is intentional, not an
  edge-case bug.** Bootstrapping a chat is itself an explicit statement
  that the chat should be active; if an operator wants a chat to stay
  disabled, they simply don't bootstrap it (or `/disable` it again
  afterward through the normal Telegram command path).
- **This endpoint's write path is local-only as of Phase 8A** — it has
  never been called against the remote database (or with a real
  `SETUP_ADMIN_SECRET`, real admin ID, or real chat ID); doing so is a
  Phase 8B action requiring its own separate approval.

## Phase 9.1B provider-usage-schema design decisions (summary)

Recorded here so they don't have to be re-derived from the migration or
code later:

- **A new table, not a rewrite of Phase 7's OpenAI-specific counters.**
  `rate_limit_counters`/`openai_daily_usage` keep backing the legacy
  OpenAI attempt limits unchanged; `provider_usage_counters` is a
  parallel, generic table for Gemini's app-side budget. Consolidating
  them is deferred to a future phase, only if it turns out to be
  worthwhile — not attempted now, per the task's own explicit scope.
- **Global scope only, no per-chat Gemini budget.** Unlike
  `rate_limit_counters`' per-chat `chat_openai` scope, Gemini's budget is
  a single whole-bot ceiling (mirroring `openai_daily_usage`'s
  single-row-global design) — Phase 9.1B has no product need for a
  per-chat Gemini limit yet.
- **`provider`/`scope_type` are tightly `CHECK`-constrained to only the
  values actually used**, not speculatively widened for hypothetical
  future providers or scopes — matching the same discipline
  `rate_limit_counters.scope_type`'s `CHECK` already established in
  Phase 7.
- **This migration (`0005_provider_usage.sql`) has not been applied to
  the remote database** — only verified locally
  (`wrangler d1 migrations apply --local`, plus a direct
  `wrangler d1 execute --local` check of the UPSERT statement) and by
  the Workers Vitest suite. Applying it remotely requires the same
  explicit approval as any other external action — see
  `docs/operations.md`.

## Migration policy

The first migration is `migrations/0001_initial.sql`; the second is
`migrations/0002_speaker_memory.sql` (Phase 5); the third is
`migrations/0003_commands.sql` (Phase 6); the fourth is
`migrations/0004_reliability.sql` (Phase 7); the fifth is
`migrations/0005_provider_usage.sql` (Phase 9.1B). Future migrations are
created with:

```sh
npx wrangler d1 migrations create <database-name> <description>
```

This creates a numbered `.sql` file per Cloudflare's D1 migration workflow
(https://developers.cloudflare.com/d1/reference/migrations/). Migrations
are applied with `wrangler d1 migrations apply` (`--local` for local dev,
`--remote` for the deployed database) — not run manually against
production. `0002_speaker_memory.sql`, `0003_commands.sql`,
`0004_reliability.sql`, and `0005_provider_usage.sql` have each been
applied and tested with `--local` only (in order, `0001` → `0002` →
`0003` → `0004` → `0005`, applying cleanly as a sequence); a `--remote`
apply requires the same explicit approval as any other external-action
approval unit (see `docs/operations.md`).
