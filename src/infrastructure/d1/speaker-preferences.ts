import type {
  EmojiUsage,
  ExplicitSpeakerPreferences,
  StyleTone,
} from "../../domain/speaker-memory";
import { invalidD1Row, isNonEmptyString, isRecord } from "./row-validation";

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

interface ParsedPreferenceRow {
  readonly key: SpeakerPreferenceKey;
  readonly value: string;
}

function parsePreferenceRow(row: unknown): ParsedPreferenceRow {
  if (
    !isRecord(row) ||
    !isPreferenceKey(row.preference_key) ||
    !isNonEmptyString(row.preference_value)
  ) {
    throw invalidD1Row("speaker preference");
  }
  return { key: row.preference_key, value: row.preference_value };
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
  const result = await db
    .prepare(
      "SELECT preference_key, preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2",
    )
    .bind(chatId, userId)
    .all();

  const preferences: { tone?: StyleTone; emojiUsage?: EmojiUsage } = {};
  for (const raw of result.results) {
    const row = parsePreferenceRow(raw);
    if (row.key === "tone" && isStyleTone(row.value)) {
      preferences.tone = row.value;
    } else if (row.key === "emoji_usage" && isEmojiUsage(row.value)) {
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
  const row = await db
    .prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = ?3 LIMIT 1",
    )
    .bind(chatId, userId, key)
    .first();

  if (row === null) {
    return null;
  }
  if (!isRecord(row) || !isNonEmptyString(row.preference_value)) {
    throw invalidD1Row("speaker preference");
  }
  return row.preference_value;
}

/**
 * Insert-or-update a single preference. An invalid key/value combination
 * is rejected by the `CHECK` constraint in `migrations/0002_speaker_memory.sql`
 * at the SQL boundary, not pre-validated here — consistent with how
 * `primary_language` is enforced in `speaker_profiles`
 * (see `upsertSpeakerProfile`).
 */
export async function upsertSpeakerPreference(
  db: D1Database,
  input: UpsertSpeakerPreferenceInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (chat_id, user_id, preference_key) DO UPDATE SET
         preference_value = excluded.preference_value,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(input.chatId, input.userId, input.key, input.value)
    .run();
}
