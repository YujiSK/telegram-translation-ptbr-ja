-- Migration number: 0005 	 2026-08-25T09:04:04.922Z

-- Phase 9.1B (Gemini semantic escalation). See docs/data-model.md and
-- docs/architecture.md for the full rationale.
--
-- `provider_usage_counters` is a generic, provider-aware analog of
-- `rate_limit_counters` (migrations/0004_reliability.sql) — deliberately
-- a new table, not a rewrite of the existing OpenAI-specific
-- `rate_limit_counters`/`openai_daily_usage` tables, which remain
-- unchanged and still back the legacy OpenAI attempt limits. One row per
-- (provider, scope_type, scope_id) — never one row per request — so a
-- window rollover overwrites `window_id` and resets `attempt_count` in
-- place (src/infrastructure/d1/provider-usage-counters.ts), exactly like
-- the Phase 7 counter tables. `provider`/`scope_type` are both tightly
-- CHECK-constrained to the values Phase 9.1B actually uses — 'gemini'
-- and the two global (not per-chat) scopes for its minute/day attempt
-- ceilings; extending either CHECK is a future migration, not a
-- speculative allowance now. `scope_id` is always 0 for a global scope —
-- there is no per-chat Gemini budget in this phase.
CREATE TABLE provider_usage_counters (
  provider TEXT NOT NULL CHECK (provider IN ('gemini')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global_minute', 'global_day')),
  scope_id INTEGER NOT NULL,
  window_id INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, scope_type, scope_id)
);
