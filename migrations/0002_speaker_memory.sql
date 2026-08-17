-- Migration number: 0002 	 2026-08-17T02:37:11.919Z

-- Phase 5 (speaker memory). See docs/data-model.md for the full rationale
-- behind each table/column below. `speaker_profiles` keeps its Phase 2
-- `PRIMARY KEY (chat_id, user_id)`; these two columns hold only the
-- *latest* auto-observed style signal from the most recent successful
-- translation (see src/domain/speaker-memory.ts) — never a history, never
-- a score, never free text.

ALTER TABLE speaker_profiles ADD COLUMN observed_tone TEXT
  CHECK (observed_tone IN ('casual', 'neutral', 'formal'));

ALTER TABLE speaker_profiles ADD COLUMN observed_emoji_usage TEXT
  CHECK (observed_emoji_usage IN ('none', 'light', 'frequent'));

-- Explicit, user-set translation style preferences. Fixed-enum
-- key/value pairs only (never free text) — the CHECK below pins each key
-- to its own allowed value set so an invalid combination can never be
-- written. Populated by a future Phase 6 `/remember`/`/forget`; Phase 5
-- only reads/writes rows a test inserts directly.
CREATE TABLE speaker_preferences (
  chat_id INTEGER NOT NULL CHECK (chat_id <> 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  preference_key TEXT NOT NULL,
  preference_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id, preference_key),
  CHECK (
    (preference_key = 'tone' AND preference_value IN ('casual', 'neutral', 'formal'))
    OR
    (preference_key = 'emoji_usage' AND preference_value IN ('none', 'light', 'frequent'))
  )
);

-- User-submitted short term/phrase corrections, scoped to a single
-- (chat_id, user_id) — never shared with other users or other chats
-- automatically. Only short terms are stored, never a full message or a
-- full translation; 100 characters is a conservative ceiling for a name,
-- nickname, or short fixed phrase (see docs/data-model.md for why this
-- number, and docs/implementation-plan.md Phase 5 for how it's chosen).
CREATE TABLE translation_corrections (
  chat_id INTEGER NOT NULL CHECK (chat_id <> 0),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  source_term TEXT NOT NULL
    CHECK (length(trim(source_term)) > 0 AND length(source_term) <= 100),
  target_term TEXT NOT NULL
    CHECK (length(trim(target_term)) > 0 AND length(target_term) <= 100),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id, source_language, target_language, source_term),
  CHECK (
    (source_language = 'ja' AND target_language = 'pt-br')
    OR
    (source_language = 'pt-br' AND target_language = 'ja')
  )
);
