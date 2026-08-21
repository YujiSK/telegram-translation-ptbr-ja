import { invalidD1Row, isRecord, isSafeInteger, runD1Query } from "./row-validation";

/**
 * Phase 7 rate/usage counters (`migrations/0004_reliability.sql`). Both
 * tables hold exactly one row per counter — never one row per request —
 * so a window rollover overwrites the bucket ID and resets the count in
 * place via a single atomic `INSERT ... ON CONFLICT ... DO UPDATE ...
 * RETURNING` statement, confirmed against local D1
 * (https://developers.cloudflare.com/d1/reference/migrations/). There is
 * no read-modify-write race: the increment-or-reset decision and the
 * write happen in one SQL statement, and the statement itself returns
 * the post-write count so the caller never needs a second query to
 * check it. A blocked request (count already over the limit) still
 * increments the counter — the reset only happens on the next window,
 * which naturally bounds it.
 *
 * `windowId`/`dayId` are computed by the caller
 * (`src/shared/time-windows.ts`) from an explicit timestamp, never
 * `Date.now()` inside this module — see docs/architecture.md, "Rate
 * limiting and usage ceiling placement".
 */

export type RateLimitScopeType = "chat_updates" | "chat_openai";

/** Shared by both counter tables: validates the `RETURNING` row's count column and returns it. */
function parseReturnedCount(row: unknown, countColumn: string): number {
  if (!isRecord(row)) {
    throw invalidD1Row("rate limit counter");
  }
  const count = row[countColumn];
  if (!isSafeInteger(count) || count < 0) {
    throw invalidD1Row("rate limit counter");
  }
  return count;
}

const CHAT_COUNTER_UPSERT = `
  INSERT INTO rate_limit_counters (scope_type, scope_id, window_id, request_count)
  VALUES (?1, ?2, ?3, 1)
  ON CONFLICT (scope_type, scope_id) DO UPDATE SET
    request_count = CASE WHEN rate_limit_counters.window_id = excluded.window_id
                          THEN rate_limit_counters.request_count + 1
                          ELSE 1 END,
    window_id = excluded.window_id,
    updated_at = CURRENT_TIMESTAMP
  RETURNING request_count
`;

/**
 * Atomically increments (or resets, on a new minute window) the counter
 * for one `(scopeType, chatId)` pair and returns the resulting count —
 * the caller compares it against its own configured limit. Never reads
 * message content; `chatId` is the only identifying value involved.
 */
async function consumeChatCounter(
  db: D1Database,
  scopeType: RateLimitScopeType,
  chatId: number,
  windowId: number,
): Promise<number> {
  const row = await runD1Query(() =>
    db.prepare(CHAT_COUNTER_UPSERT).bind(scopeType, chatId, windowId).first(),
  );
  return parseReturnedCount(row, "request_count");
}

/**
 * Consumes one unit of the per-chat inbound handled-update budget for
 * the current minute window. Returns `true` when the resulting count is
 * within `limit` (allowed), `false` when it exceeds it (the request
 * should be dropped with `ignored:rate-limited` — see
 * `src/handlers/telegram-webhook.ts`). Applies to both the command and
 * translation paths.
 */
export async function consumeChatHandledUpdateLimit(
  db: D1Database,
  chatId: number,
  windowId: number,
  limit: number,
): Promise<boolean> {
  const count = await consumeChatCounter(db, "chat_updates", chatId, windowId);
  return count <= limit;
}

/**
 * Consumes one unit of the per-chat OpenAI attempt burst budget for the
 * current minute window — called once per HTTP attempt (including
 * retries), never once per logical translation. Returns `true` when
 * allowed, `false` when the chat has exceeded its per-minute attempt
 * burst.
 */
export async function consumeChatOpenAiAttemptLimit(
  db: D1Database,
  chatId: number,
  windowId: number,
  limit: number,
): Promise<boolean> {
  const count = await consumeChatCounter(db, "chat_openai", chatId, windowId);
  return count <= limit;
}

const DAILY_USAGE_UPSERT = `
  INSERT INTO openai_daily_usage (singleton, day_id, attempt_count)
  VALUES (1, ?1, 1)
  ON CONFLICT (singleton) DO UPDATE SET
    attempt_count = CASE WHEN openai_daily_usage.day_id = excluded.day_id
                          THEN openai_daily_usage.attempt_count + 1
                          ELSE 1 END,
    day_id = excluded.day_id,
    updated_at = CURRENT_TIMESTAMP
  RETURNING attempt_count
`;

/**
 * Consumes one unit of the global daily OpenAI attempt ceiling — called
 * once per HTTP attempt, after the per-chat burst check already passed
 * (see docs/architecture.md, "Rate limiting and usage ceiling
 * placement" for the ordering rationale). Returns `true` when allowed,
 * `false` when the whole bot has exceeded its daily attempt budget for
 * the current UTC day.
 */
export async function consumeDailyOpenAiAttemptLimit(
  db: D1Database,
  dayId: number,
  limit: number,
): Promise<boolean> {
  const row = await runD1Query(() => db.prepare(DAILY_USAGE_UPSERT).bind(dayId).first());
  const count = parseReturnedCount(row, "attempt_count");
  return count <= limit;
}
