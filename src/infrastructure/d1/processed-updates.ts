import { PermanentUpstreamError } from "../../shared/errors";
import { invalidD1Row, isRecord } from "./row-validation";

export async function hasProcessedUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM processed_updates WHERE update_id = ?1 LIMIT 1")
    .bind(updateId)
    .first();

  if (row === null) {
    return false;
  }
  if (!isRecord(row) || row.found !== 1) {
    throw invalidD1Row("processed update");
  }
  return true;
}

/** Atomically records an update. Returns false when its unique ID already exists. */
export async function recordUpdateIfNew(db: D1Database, updateId: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?1)")
    .bind(updateId)
    .run();

  if (result.meta.changes === 1) {
    return true;
  }
  if (result.meta.changes === 0) {
    return false;
  }
  throw new PermanentUpstreamError("D1 returned an invalid processed-update change count", "d1");
}
