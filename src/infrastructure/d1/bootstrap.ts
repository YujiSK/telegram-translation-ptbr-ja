import { runD1Query } from "./row-validation";

/**
 * Phase 8A production-bootstrap mutation: registers the first real bot
 * admin and the first real allowlisted chat as one atomic operation, so
 * a deploy is never left half-bootstrapped (an admin with no chat to
 * administer, or an enabled chat with no admin able to `/disable` it).
 * Per Cloudflare's D1 documentation
 * (https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
 * `db.batch()` runs its statements as a single SQL transaction that rolls
 * back entirely if any statement fails — the same primitive
 * `forget-me.ts` uses for `/forgetme confirm`'s multi-table delete.
 *
 * Idempotent by design, so re-running this endpoint with the same
 * `(adminUserId, chatId)` (e.g. a retried request) is always safe:
 * - `bot_admins`: `INSERT ... ON CONFLICT (user_id) DO NOTHING` — a
 *   second insert for an already-registered admin is a no-op, never a
 *   constraint-violation error.
 * - `allowed_chats`: `INSERT ... ON CONFLICT (chat_id) DO UPDATE SET
 *   enabled = 1, ...` — a brand-new chat is inserted enabled; a
 *   pre-existing chat (including one an admin had previously `/disable`d)
 *   is unconditionally re-enabled, since bootstrapping a chat is an
 *   explicit statement of intent that it should be active.
 *
 * Deliberately touches only `bot_admins` and `allowed_chats` — never
 * `speaker_profiles`, `speaker_preferences`, `translation_corrections`,
 * `processed_updates`, or the Phase 7 reliability-counter tables. This is
 * a pure authenticated D1 setup operation, not a speaker- or
 * message-processing one.
 */
export async function bootstrapAdminAndChat(
  db: D1Database,
  adminUserId: number,
  chatId: number,
): Promise<void> {
  await runD1Query(() =>
    db.batch([
      db
        .prepare("INSERT INTO bot_admins (user_id) VALUES (?1) ON CONFLICT (user_id) DO NOTHING")
        .bind(adminUserId),
      db
        .prepare(
          "INSERT INTO allowed_chats (chat_id, enabled) VALUES (?1, 1) ON CONFLICT (chat_id) DO UPDATE SET enabled = 1, updated_at = CURRENT_TIMESTAMP",
        )
        .bind(chatId),
    ]),
  );
}
