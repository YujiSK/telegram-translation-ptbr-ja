import { invalidD1Row, isRecord, runD1Query } from "./row-validation";

export async function isChatAllowed(db: D1Database, chatId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1 LIMIT 1")
    .bind(chatId)
    .first();

  if (row === null) {
    return false;
  }
  if (!isRecord(row) || (row.enabled !== 0 && row.enabled !== 1)) {
    throw invalidD1Row("allowed chat");
  }
  return row.enabled === 1;
}

/**
 * The three states a chat can be in, distinguished (unlike `isChatAllowed`,
 * which collapses "row missing" and "row exists but disabled" into a
 * single `false`) so the webhook can apply Phase 6's `/enable` exception:
 * a *known but disabled* chat still routes `/enable` to admin
 * authorization, while a chat with no `allowed_chats` row at all never
 * does — see docs/architecture.md, "Command routing and chat state".
 */
export type AllowedChatState = "missing" | "disabled" | "enabled";

export async function getAllowedChatState(
  db: D1Database,
  chatId: number,
): Promise<AllowedChatState> {
  const row = await runD1Query(() =>
    db.prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1 LIMIT 1").bind(chatId).first(),
  );

  if (row === null) {
    return "missing";
  }
  if (!isRecord(row) || (row.enabled !== 0 && row.enabled !== 1)) {
    throw invalidD1Row("allowed chat");
  }
  return row.enabled === 1 ? "enabled" : "disabled";
}

/**
 * Flips the soft `enabled` flag for a chat that already has an
 * `allowed_chats` row — never inserts a new row, so this can never be
 * used to self-allowlist an unknown chat (callers must check
 * `getAllowedChatState` first; see `/enable`'s "unknown chat" rule in
 * docs/implementation-plan.md Phase 6).
 */
export async function setAllowedChatEnabled(
  db: D1Database,
  chatId: number,
  enabled: boolean,
): Promise<void> {
  await runD1Query(() =>
    db
      .prepare(
        "UPDATE allowed_chats SET enabled = ?2, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?1",
      )
      .bind(chatId, enabled ? 1 : 0)
      .run(),
  );
}
