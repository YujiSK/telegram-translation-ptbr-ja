import { invalidD1Row, isRecord, runD1Query } from "./row-validation";

/**
 * Runtime authority for `/enable`/`/disable` admin authorization
 * (`migrations/0003_commands.sql`) — a fixed allowlist of Telegram user
 * IDs, populated only by a direct D1 insert. There is no production
 * bootstrap route in Phase 6: registering the first real admin row (and
 * any future `SETUP_ADMIN_SECRET`-gated bootstrap endpoint) is Phase 8
 * work — see docs/security-and-privacy.md, "Admin command authorization".
 */
export async function isBotAdmin(db: D1Database, userId: number): Promise<boolean> {
  const row = await runD1Query(() =>
    db.prepare("SELECT 1 AS found FROM bot_admins WHERE user_id = ?1 LIMIT 1").bind(userId).first(),
  );

  if (row === null) {
    return false;
  }
  if (!isRecord(row) || row.found !== 1) {
    throw invalidD1Row("bot admin");
  }
  return true;
}
