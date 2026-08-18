# Data Model

Status: **Phase 2 and Phase 5 schema implemented.**
`migrations/0001_initial.sql` creates `allowed_chats`, `processed_updates`,
and `speaker_profiles` for local development and tests. The remote D1
database is provisioned and configured, and `0001_initial.sql` was
applied remotely on 2026-08-14. `migrations/0002_speaker_memory.sql`
(Phase 5) adds `observed_tone`/`observed_emoji_usage` to
`speaker_profiles` and creates `speaker_preferences` and
`translation_corrections` — verified with
`wrangler d1 migrations apply --local` and by the Workers Vitest test
suite (`test/infrastructure/d1/{repositories,speaker-memory-repositories}.test.ts`),
but **not** applied to the remote database (that's Phase 8). The
remaining tables below stay plans for the later phases that own their
behavior.

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
(`migrations/0002_speaker_memory.sql`); the `/remember`/`/forget` command
surface that writes to it in normal operation is deferred to Phase 6 —
Phase 5's own tests insert/read rows directly. Explicit preferences
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
- **Retention:** until removed via `/forget` (single key) or `/forgetme`
  (all of a user's data) — both Phase 6.
- **Index candidates:** primary key lookup above (small table).

## `translation_corrections`

**Implementation status:** Phase 5 schema implemented
(`migrations/0002_speaker_memory.sql`); the `/correct` command that
writes to it in normal operation is deferred to Phase 6 — Phase 5's own
tests insert/read rows directly, using only synthetic term pairs.

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
- **Retention:** until removed (mechanism TBD — likely `/forget` extended
  to cover corrections, or a dedicated command; **open question**, Phase 6).
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
- **Deferred decision:** retention window and cleanup mechanism belong to
  Phase 7 reliability work; D1 has no native TTL.

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

**Implementation status:** deferred to the command/operations phases;
the allowlist soft flag covers Phase 2's enable-state requirement.

**Purpose:** Small key/value operational settings not tied to a specific
chat or user (e.g., global enable/disable switch, schema/version
markers).

- **Planned primary key:** `setting_key`
- **May store:** key, value, `updated_at`, updated-by admin user ID
- **Must not store:** Secrets (Secrets never go in D1 — see
  `docs/security-and-privacy.md`)
- **Retention:** indefinite (operational config)
- **Index candidates:** primary key lookup only
- **Open questions:** whether per-chat `/enable` and `/disable` belong
  here or fully in `allowed_chats.enabled`

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
  correction-specific removal mechanism) are deferred to Phase 6 — Phase
  5 only implements the read/write repository functions Phase 6's
  commands will call.
- **Reliability/observability hardening** (e.g. making a swallowed
  observed-profile-write failure operator-visible, retention policies)
  is deferred to Phase 7 — see `docs/architecture.md`, "Speaker memory
  read/write ordering".

## Migration policy

The first migration is `migrations/0001_initial.sql`; the second is
`migrations/0002_speaker_memory.sql` (Phase 5). Future migrations are
created with:

```sh
npx wrangler d1 migrations create <database-name> <description>
```

This creates a numbered `.sql` file per Cloudflare's D1 migration workflow
(https://developers.cloudflare.com/d1/reference/migrations/). Migrations
are applied with `wrangler d1 migrations apply` (`--local` for local dev,
`--remote` for the deployed database) — not run manually against
production. `0002_speaker_memory.sql` has been applied and tested with
`--local` only; a `--remote` apply requires the same explicit approval as
any other Phase 8 action.
