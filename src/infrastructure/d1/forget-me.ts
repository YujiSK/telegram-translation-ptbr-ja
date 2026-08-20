import { runD1Query } from "./row-validation";

/**
 * Deletes every row Phase 6's `/forgetme confirm` is documented to remove
 * — `speaker_profiles`, `speaker_preferences`, `translation_corrections`,
 * all scoped to a single `(chat_id, user_id)` — as one atomic operation.
 * Per Cloudflare's D1 documentation
 * (https://developers.cloudflare.com/d1/worker-api/d1-database/#batch):
 * "Batched statements are SQL transactions. If a statement in the
 * sequence fails, then an error is returned for that specific statement,
 * and it aborts or rolls back the entire sequence." `db.batch()` is
 * therefore the correct primitive for an all-or-nothing multi-table
 * delete — see docs/data-model.md, "`/forgetme` scope".
 *
 * Deliberately does **not** touch `allowed_chats`, `processed_updates`,
 * or `bot_admins` — none of those are per-user data (docs/data-model.md)
 * — and never touches another user's or another chat's rows, since every
 * statement is scoped by both `chat_id` and `user_id`.
 */
export async function forgetSpeakerData(
  db: D1Database,
  chatId: number,
  userId: number,
): Promise<void> {
  await runD1Query(() =>
    db.batch([
      db
        .prepare("DELETE FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2")
        .bind(chatId, userId),
      db
        .prepare("DELETE FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2")
        .bind(chatId, userId),
      db
        .prepare("DELETE FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2")
        .bind(chatId, userId),
    ]),
  );
}
