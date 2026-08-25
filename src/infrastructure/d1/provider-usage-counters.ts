import { invalidD1Row, isRecord, isSafeInteger, runD1Query } from "./row-validation";

/**
 * Phase 9.1B provider-aware usage counters
 * (`migrations/0005_provider_usage.sql`). Generic across providers by
 * design, but only `gemini` exists yet — see
 * `docs/phase9-provider-plan.md`, "Provider-aware usage control". One
 * row per `(provider, scope_type, scope_id)`, never one row per
 * request, mirroring the exact atomic UPSERT-with-`RETURNING` pattern
 * `src/infrastructure/d1/reliability-counters.ts` established for the
 * OpenAI-specific counters — a window rollover overwrites `window_id`
 * and resets `attempt_count` in place, in one SQL statement, so there is
 * no read-modify-write race.
 *
 * `windowId`/`dayId` are computed by the caller
 * (`src/shared/time-windows.ts`) from an explicit timestamp, never
 * `Date.now()` inside this module. Both current scopes are global (not
 * per-chat) — `scopeId` is always `0` — since Phase 9.1B's Gemini
 * budget is a whole-bot ceiling, not a per-chat one (see
 * `docs/phase9-provider-plan.md` for the rationale).
 */

const GLOBAL_SCOPE_ID = 0;

function parseReturnedAttemptCount(row: unknown): number {
  if (!isRecord(row)) {
    throw invalidD1Row("provider usage counter");
  }
  const count = row.attempt_count;
  if (!isSafeInteger(count) || count < 0) {
    throw invalidD1Row("provider usage counter");
  }
  return count;
}

const PROVIDER_COUNTER_UPSERT = `
  INSERT INTO provider_usage_counters (provider, scope_type, scope_id, window_id, attempt_count)
  VALUES (?1, ?2, ?3, ?4, 1)
  ON CONFLICT (provider, scope_type, scope_id) DO UPDATE SET
    attempt_count = CASE WHEN provider_usage_counters.window_id = excluded.window_id
                          THEN provider_usage_counters.attempt_count + 1
                          ELSE 1 END,
    window_id = excluded.window_id,
    updated_at = CURRENT_TIMESTAMP
  RETURNING attempt_count
`;

async function consumeGlobalProviderCounter(
  db: D1Database,
  provider: "gemini",
  scopeType: "global_minute" | "global_day",
  windowId: number,
): Promise<number> {
  const row = await runD1Query(() =>
    db
      .prepare(PROVIDER_COUNTER_UPSERT)
      .bind(provider, scopeType, GLOBAL_SCOPE_ID, windowId)
      .first(),
  );
  return parseReturnedAttemptCount(row);
}

/**
 * Consumes one unit of the global Gemini attempt budget for the current
 * minute window — called once immediately before the single Gemini HTTP
 * attempt a semantic escalation makes (Phase 9.1B never retries within a
 * request). Returns `true` when the resulting count is within `limit`
 * (allowed), `false` when it exceeds it (the escalation should be
 * dropped as a safe, accepted no-reply outcome — see
 * `src/infrastructure/translation/router.ts`).
 */
export async function consumeGeminiMinuteAttemptLimit(
  db: D1Database,
  windowId: number,
  limit: number,
): Promise<boolean> {
  const count = await consumeGlobalProviderCounter(db, "gemini", "global_minute", windowId);
  return count <= limit;
}

/**
 * Consumes one unit of the global daily Gemini attempt ceiling — called
 * once per Gemini attempt, after the minute check already passed
 * (mirrors the OpenAI chat-minute-then-daily ordering in
 * `src/infrastructure/d1/reliability-counters.ts`). Returns `true` when
 * allowed, `false` when the whole bot has exceeded its daily Gemini
 * attempt budget for the current UTC day.
 */
export async function consumeGeminiDailyAttemptLimit(
  db: D1Database,
  dayId: number,
  limit: number,
): Promise<boolean> {
  const count = await consumeGlobalProviderCounter(db, "gemini", "global_day", dayId);
  return count <= limit;
}
