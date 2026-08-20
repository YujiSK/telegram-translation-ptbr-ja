-- Migration number: 0003 	 2026-08-20T09:25:01.000Z

-- Phase 6 (commands). See docs/data-model.md and docs/security-and-privacy.md
-- for the full rationale. `bot_admins` is the runtime authority for
-- `/enable`/`/disable` authorization — a fixed allowlist of Telegram user
-- IDs, populated only via direct D1 insert (test fixtures use synthetic
-- IDs only; production bootstrap of the first real admin row, and any
-- `SETUP_ADMIN_SECRET`-gated bootstrap route, is Phase 8 work, not this
-- migration).
CREATE TABLE bot_admins (
  user_id INTEGER PRIMARY KEY CHECK (user_id > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
