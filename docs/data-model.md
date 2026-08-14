# Data Model

Status: **Planning only.** No D1 database, migration, or table exists yet.
This document defines the tables planned for Phase 2
(`docs/implementation-plan.md`). SQL migrations are created with
`wrangler d1 migrations create` once this schema is judged stable enough
to commit to — see "Migration policy" at the end of this document.

General privacy rule for every table below: **never store message text,
full OpenAI prompts, or Secrets.** See `docs/security-and-privacy.md` for
the full allow/deny list.

## `allowed_chats`

**Purpose:** Which Telegram chats (groups) the bot is allowed to operate
in. Anything not listed here is ignored.

- **Planned primary key:** `chat_id` (Telegram chat ID)
- **May store:** `chat_id`, a human-readable label, `enabled` flag,
  `created_at`, `updated_at`, the Telegram user ID of the admin who
  enabled it
- **Must not store:** chat message content, member lists
- **Retention:** kept until an admin disables/removes the chat
- **Index candidates:** primary key lookup only (small table, no
  secondary index expected)
- **Open questions:** whether disabling is a soft flag (`enabled = 0`) or
  a row delete; leaning soft-flag for auditability, to confirm in Phase 2

## `speaker_profiles`

**Purpose:** Per-user identity and low-risk linguistic characteristics
used to make translations feel natural for that person.

- **Planned primary key:** `(chat_id, user_id)` composite — **confirmed**.
  A speaker's profile is scoped to a single Telegram group: the same
  person gets a separate profile row in each group the bot is enabled
  for. Profiles are never automatically shared or merged across chats —
  a style/preference learned in one family group has no effect on
  another group, even for the same Telegram user.
- **May store:** `chat_id`, Telegram `user_id`, display name, primary
  language, emoji-usage tendency, casual/formal tendency (low-risk
  stylistic signals only), `created_at`, `updated_at`
- **Must not store:** any inferred personality, health, political,
  religious, or relationship-status data; conversation content
- **Retention:** until the user issues `/forgetme` or an admin removes
  them (scoped to the `(chat_id, user_id)` row(s) that command affects)
- **Index candidates:** primary key lookup on `(chat_id, user_id)`;
  possibly a secondary index on `chat_id` alone for per-chat listing
- **Open questions:** exact set of auto-derived low-risk features to
  track initially
- **Phase 2 note:** the first D1 migration must declare
  `PRIMARY KEY (chat_id, user_id)` on this table to match the confirmed
  scope above.

## `speaker_preferences`

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
- **Open questions:** retention window length; cleanup mechanism (D1 has
  no native TTL — likely a scheduled cleanup job in Phase 7)

## `message_mappings`

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

No `migrations/` directory or `.sql` file exists yet. When this schema is
finalized enough to implement (Phase 2), migrations will be created with:

```sh
npx wrangler d1 migrations create <database-name> <description>
```

This creates the `migrations/` directory and a numbered `.sql` file per
Cloudflare's D1 migration workflow
(https://developers.cloudflare.com/d1/reference/migrations/). Migrations
are applied with `wrangler d1 migrations apply` (`--local` for local dev,
`--remote` for the deployed database) — not run manually against
production.
