import { AppError, PermanentUpstreamError, TransientUpstreamError } from "../../shared/errors";

export function invalidD1Row(entity: string): PermanentUpstreamError {
  return new PermanentUpstreamError(`D1 returned an invalid ${entity} row`, "d1");
}

/**
 * Wraps a raw D1 query (`.prepare(...).bind(...).first()/.all()`) so that
 * a query/runtime failure (network hiccup, D1 outage, timeout) is
 * classified as a `TransientUpstreamError` — distinct from a
 * malformed-row failure, which is thrown by the caller's own row parser
 * *after* this function returns successfully, and stays a
 * `PermanentUpstreamError` (see `invalidD1Row`). This distinction lets
 * the webhook's dedupe-reservation release logic
 * (`error instanceof TransientUpstreamError`) work correctly for a
 * speaker-memory read failure — see docs/architecture.md, "Speaker
 * memory read/write ordering".
 */
export async function runD1Query<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    // Defensive: a well-behaved `query()` never throws an AppError itself
    // (row parsing happens outside this wrapper), but if it ever does,
    // preserve its classification instead of silently reclassifying a
    // permanent failure as retryable.
    if (error instanceof AppError) {
      throw error;
    }
    throw new TransientUpstreamError("D1 query failed", "d1");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
