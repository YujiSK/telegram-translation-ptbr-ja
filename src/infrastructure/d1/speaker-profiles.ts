import type { Language } from "../../domain/language";
import { invalidD1Row, isNonEmptyString, isRecord, isSafeInteger } from "./row-validation";

export interface SpeakerProfile {
  readonly chatId: number;
  readonly userId: number;
  readonly displayName: string;
  readonly primaryLanguage: Language | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpeakerProfileInput {
  readonly chatId: number;
  readonly userId: number;
  readonly displayName: string;
  readonly primaryLanguage?: Language | null;
}

function isLanguageOrNull(value: unknown): value is Language | null {
  return value === null || value === "ja" || value === "pt-br" || value === "other";
}

function parseSpeakerProfile(row: unknown): SpeakerProfile {
  if (
    !isRecord(row) ||
    !isSafeInteger(row.chat_id) ||
    row.chat_id === 0 ||
    !isSafeInteger(row.user_id) ||
    row.user_id <= 0 ||
    !isNonEmptyString(row.display_name) ||
    !isLanguageOrNull(row.primary_language) ||
    !isNonEmptyString(row.created_at) ||
    !isNonEmptyString(row.updated_at)
  ) {
    throw invalidD1Row("speaker profile");
  }

  return {
    chatId: row.chat_id,
    userId: row.user_id,
    displayName: row.display_name,
    primaryLanguage: row.primary_language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSpeakerProfile(
  db: D1Database,
  chatId: number,
  userId: number,
): Promise<SpeakerProfile | null> {
  const row = await db
    .prepare(
      "SELECT chat_id, user_id, display_name, primary_language, created_at, updated_at FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2 LIMIT 1",
    )
    .bind(chatId, userId)
    .first();

  return row === null ? null : parseSpeakerProfile(row);
}

export async function upsertSpeakerProfile(
  db: D1Database,
  profile: SpeakerProfileInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET
         display_name = excluded.display_name,
         primary_language = excluded.primary_language,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(profile.chatId, profile.userId, profile.displayName, profile.primaryLanguage ?? null)
    .run();
}
