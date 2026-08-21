-- Migration number: 0004 	 2026-08-21T03:39:35.000Z

-- Phase 7 (reliability and security). See docs/data-model.md and
-- docs/architecture.md for the full rationale.
--
-- `rate_limit_counters` backs the per-chat inbound handled-update limit
-- and the per-chat OpenAI attempt burst limit. One row per
-- (scope_type, scope_id) — never one row per request — so the table
-- never grows unbounded: a window rollover overwrites `window_id` and
-- resets `request_count` in place (see
-- `src/infrastructure/d1/reliability-counters.ts`), it never inserts a
-- new row. `scope_id` is a Telegram chat ID, never message content.
CREATE TABLE rate_limit_counters (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('chat_updates', 'chat_openai')),
  scope_id INTEGER NOT NULL,
  window_id INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_type, scope_id)
);

-- `openai_daily_usage` backs the global daily OpenAI attempt ceiling.
-- Deliberately a singleton table (one row, forced by the CHECK on the
-- primary key) — there is exactly one global counter, not one per chat
-- or per day, so a day rollover overwrites `day_id` and resets
-- `attempt_count` in place instead of accumulating rows.
CREATE TABLE openai_daily_usage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  day_id INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
