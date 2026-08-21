/**
 * Pure UTC time-bucket calculations for Phase 7's rate/usage counters
 * (`src/infrastructure/d1/reliability-counters.ts`). Deliberately takes
 * `nowMs` as an explicit parameter rather than calling `Date.now()`
 * internally, so callers (and their tests) can pass a fixed instant and
 * get fully deterministic bucket IDs — no hidden clock dependency, no
 * timezone dependency (epoch milliseconds are timezone-free; integer
 * division by a fixed-length window is therefore inherently UTC-based).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A minute-resolution window identifier — every instant within the same UTC minute maps to the same integer. */
export function minuteWindowId(nowMs: number): number {
  return Math.floor(nowMs / MINUTE_MS);
}

/** A day-resolution window identifier — every instant within the same UTC day maps to the same integer. */
export function utcDayId(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}
