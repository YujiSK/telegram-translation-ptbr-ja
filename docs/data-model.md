# Data Model

Status: **Phase 2 local subset implemented.** `migrations/0001_initial.sql`
creates `allowed_chats`, `processed_updates`, and `speaker_profiles` for
local development and tests. No remote D1 database exists yet. The other
tables remain plans for the later phases that own their behavior.

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
  nullable primary language, `created_at`, `updated_at`
- **Deferred low-risk fields:** emoji usage and casual/formal signals are
  not added until Phase 4/5 defines the Structured Output and memory
  behavior that owns them.
- **Must not store:** any inferred personality, health, political,
  religious, or relationship-status data; conversation content
- **Retention:** until the user issues `/forgetme` or an admin removes
  them (scoped to the `(chat_id, user_id)` row(s) that command affects)
- **Index candidates:** primary key lookup on `(chat_id, user_id)`;
  possibly a secondary index on `chat_id` alone for per-chat listing
- **Implemented constraint:** the first migration declares
  `PRIMARY KEY (chat_id, user_id)` to match the confirmed scope above.

## `speaker_preferences`

**Implementation status:** deferred to Phase 5/6. Its keys and command
semantics remain open, so the Phase 2 migration intentionally does not
freeze a premature schema.

**Purpose:** Explicit, user- or admin-set translation preferences that
always take priority over auto-derived features from `speaker_profiles`
(see `docs/security-and-privacy.md` — explicit settings outrank inferred
ones).

- **Planned primary key:** `(chat_id, user_id, preference_key)` or a
  surrogate `id` with a unique constraint on that triple
- **May store:** preference key/value pairs (e.g., target tone), who set
  it (`self` vs. admin `user_id`), `created_at`, `updated_at`
- **Must not store:** free-text explanations beyond what `/remember`
  explicitly captures as a setting value
- **Retention:** until removed via `/forget` (single key) or `/forgetme`
  (all of a user's data)
- **Index candidates:** primary key / unique constraint above
- **Open questions:** fixed enum of preference keys vs. free-form
  key/value; how `/remember` vs. `/forget` map to key granularity

## `translation_corrections`

**Implementation status:** deferred to Phase 5/6, where correction scope,
conflict resolution, and removal behavior are defined.

**Purpose:** User-submitted correction dictionary from `/correct`, applied
to future translations (e.g., preferred renderings of names, in-jokes).

- **Planned primary key:** surrogate `id`, unique on
  `(chat_id, source_text, target_language)` or similar
- **May store:** the corrected term/phrase pair, language direction,
  which user submitted it, `created_at`, `updated_at`
- **Must not store:** the full original message the correction came from
  — only the specific term/phrase pair being corrected
- **Retention:** until removed (mechanism TBD — likely `/forget` extended
  to cover corrections, or a dedicated command; **open question**)
- **Index candidates:** lookup by `chat_id` + source term at translation
  time
- **Open questions:** whether corrections are per-chat or per-user;
  removal command/UX; how conflicting corrections are resolved

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

## Migration policy

The first migration is `migrations/0001_initial.sql`. Future migrations
are created with:

```sh
npx wrangler d1 migrations create <database-name> <description>
```

This creates a numbered `.sql` file per Cloudflare's D1 migration workflow
(https://developers.cloudflare.com/d1/reference/migrations/). Migrations
are applied with `wrangler d1 migrations apply` (`--local` for local dev,
`--remote` for the deployed database) — not run manually against
production.
