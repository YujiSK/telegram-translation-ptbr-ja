import { invalidD1Row, isRecord } from "./row-validation";

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
