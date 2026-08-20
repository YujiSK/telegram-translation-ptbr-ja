import type {
  EmojiUsage,
  ExplicitSpeakerPreferences,
  StyleTone,
} from "../../domain/speaker-memory";
import { invalidD1Row, isNonEmptyString, isRecord, runD1Query } from "./row-validation";

/**
 * Fixed enum of allowed preference keys — see `migrations/0002_speaker_memory.sql`,
 * which enforces the matching key/value pairing with a SQLite `CHECK`.
 * No free-form key or value is ever accepted here or at the schema level.
 */
export type SpeakerPreferenceKey = "tone" | "emoji_usage";

export interface UpsertSpeakerPreferenceInput {
  readonly chatId: number;
  readonly userId: number;
  readonly key: SpeakerPreferenceKey;
  readonly value: string;
}

function isPreferenceKey(value: unknown): value is SpeakerPreferenceKey {
  return value === "tone" || value === "emoji_usage";
}

function isStyleTone(value: string): value is StyleTone {
  return value === "casual" || value === "neutral" || value === "formal";
}

function isEmojiUsage(value: string): value is EmojiUsage {
  return value === "none" || value === "light" || value === "frequent";
}

/**
 * The row's key and its value, narrowed together so a value can never be
 * paired with a key it doesn't belong to — see docs/implementation-plan.md
 * Phase 5 review, Issue 3-A. A row whose `preference_value` is a
 * non-empty string but not a member of *its own* `preference_key`'s enum
 * (e.g. `tone = "super-formal"`, or a `tone` row carrying an
 * `emoji_usage` value) is rejected here, never silently ignored — this
 * is defense-in-depth on top of the schema's own `CHECK` constraint
 * (`migrations/0002_speaker_memory.sql`), not a replacement for it.
 */
export type ParsedPreferenceRow =
  | { readonly key: "tone"; readonly value: StyleTone }
  | { readonly key: "emoji_usage"; readonly value: EmojiUsage };

/** Exported for direct boundary-validation unit tests as well as internal use. */
export function parsePreferenceRow(row: unknown): ParsedPreferenceRow {
  if (
    !isRecord(row) ||
    !isPreferenceKey(row.preference_key) ||
    !isNonEmptyString(row.preference_value)
  ) {
    throw invalidD1Row("speaker preference");
  }

  const key = row.preference_key;
  const value = row.preference_value;
  if (key === "tone") {
    if (!isStyleTone(value)) {
      throw invalidD1Row("speaker preference");
    }
    return { key: "tone", value };
  }

  if (!isEmojiUsage(value)) {
    throw invalidD1Row("speaker preference");
  }
  return { key: "emoji_usage", value };
}

/**
 * All of a speaker's explicit preferences, mapped into the fixed domain
 * shape (never a raw key/value list) — an unset preference is simply
 * absent from the result, never guessed. Scoped strictly to
 * `(chat_id, user_id)`; never merged across chats or users.
 */
export async function getSpeakerPreferences(
  db: D1Database,
  chatId: number,
  userId: number,
): Promise<ExplicitSpeakerPreferences> {
  const result = await runD1Query(() =>
    db
      .prepare(
        "SELECT preference_key, preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2",
      )
      .bind(chatId, userId)
      .all(),
  );

  const preferences: { tone?: StyleTone; emojiUsage?: EmojiUsage } = {};
  for (const raw of result.results) {
    const row = parsePreferenceRow(raw);
    if (row.key === "tone") {
      preferences.tone = row.value;
    } else {
      preferences.emojiUsage = row.value;
    }
  }
  return preferences;
}

/** A single preference's raw stored value, or null if the speaker never set it. */
export async function getSpeakerPreference(
  db: D1Database,
  chatId: number,
  userId: number,
  key: SpeakerPreferenceKey,
): Promise<string | null> {
  const row = await runD1Query(() =>
    db
      .prepare(
        "SELECT preference_key, preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = ?3 LIMIT 1",
      )
      .bind(chatId, userId, key)
      .first(),
  );

  if (row === null) {
    return null;
  }
  return parsePreferenceRow(row).value;
}

/**
 * Insert-or-update a single preference. An invalid key/value combination
 * is rejected by the `CHECK` constraint in `migrations/0002_speaker_memory.sql`
 * at the SQL boundary, not pre-validated here — consistent with how
 * `primary_language` is enforced in `speaker_profiles`
 * (see `upsertSpeakerProfile`). The only caller in normal operation is
 * Phase 6's `/remember`, whose parser (`src/commands/parse-command.ts`)
 * already rejects an invalid key/value before this is ever called, so a
 * real `CHECK` violation here is not expected. Wrapped in `runD1Query` so
 * a genuine D1 outage during a command mutation is classified as
 * `TransientUpstreamError` — see docs/architecture.md, "Command D1 error
 * classification and dedupe" (Phase 6).
 */
export async function upsertSpeakerPreference(
  db: D1Database,
  input: UpsertSpeakerPreferenceInput,
): Promise<void> {
  await runD1Query(() =>
    db
      .prepare(
        `INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (chat_id, user_id, preference_key) DO UPDATE SET
           preference_value = excluded.preference_value,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(input.chatId, input.userId, input.key, input.value)
      .run(),
  );
}

/**
 * Removes one explicit preference, used by Phase 6's `/forget tone` /
 * `/forget emoji_usage`. Idempotent: deleting a preference that was never
 * set (or already removed) is a normal no-op, never an error — matches
 * `releaseProcessedUpdate`'s "returns whether a row was actually removed"
 * shape in `src/infrastructure/d1/processed-updates.ts`, so a Telegram
 * redelivery of the same `/forget` can safely repeat this call.
 */
export async function deleteSpeakerPreference(
  db: D1Database,
  chatId: number,
  userId: number,
  key: SpeakerPreferenceKey,
): Promise<void> {
  await runD1Query(() =>
    db
      .prepare(
        "DELETE FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = ?3",
      )
      .bind(chatId, userId, key)
      .run(),
  );
}
