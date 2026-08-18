import type { Language } from "../../domain/language";
import type { EmojiUsage, StyleTone } from "../../domain/speaker-memory";
import {
  invalidD1Row,
  isNonEmptyString,
  isRecord,
  isSafeInteger,
  runD1Query,
} from "./row-validation";

export interface SpeakerProfile {
  readonly chatId: number;
  readonly userId: number;
  readonly displayName: string;
  readonly primaryLanguage: Language | null;
  /** The single latest auto-observed tone — never a history. See docs/data-model.md. */
  readonly observedTone: StyleTone | null;
  readonly observedEmojiUsage: EmojiUsage | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpeakerProfileInput {
  readonly chatId: number;
  readonly userId: number;
  readonly displayName: string;
  readonly primaryLanguage?: Language | null;
}

/** Phase 5 write path for the auto-observed style columns — see docs/implementation-plan.md Phase 5, Stage I. */
export interface ObservedSpeakerStyleInput {
  readonly chatId: number;
  readonly userId: number;
  readonly displayName: string;
  readonly primaryLanguage: Language;
  readonly observedTone: StyleTone;
  readonly observedEmojiUsage: EmojiUsage;
}

function isLanguageOrNull(value: unknown): value is Language | null {
  return value === null || value === "ja" || value === "pt-br" || value === "other";
}

function isStyleToneOrNull(value: unknown): value is StyleTone | null {
  return value === null || value === "casual" || value === "neutral" || value === "formal";
}

function isEmojiUsageOrNull(value: unknown): value is EmojiUsage | null {
  return value === null || value === "none" || value === "light" || value === "frequent";
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
    !isStyleToneOrNull(row.observed_tone) ||
    !isEmojiUsageOrNull(row.observed_emoji_usage) ||
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
    observedTone: row.observed_tone,
    observedEmojiUsage: row.observed_emoji_usage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSpeakerProfile(
  db: D1Database,
  chatId: number,
  userId: number,
): Promise<SpeakerProfile | null> {
  const row = await runD1Query(() =>
    db
      .prepare(
        "SELECT chat_id, user_id, display_name, primary_language, observed_tone, observed_emoji_usage, created_at, updated_at FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2 LIMIT 1",
      )
      .bind(chatId, userId)
      .first(),
  );

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

/**
 * Phase 5 write path: records the single latest auto-observed style
 * signal from a successful translation, together with the identity
 * fields it was observed alongside. Always writes all four fields
 * together (never a partial update) — the only caller is the
 * post-translation write step in `src/application/translate-and-reply.ts`,
 * which only calls this when it has all four values in hand, so a full
 * overwrite is exactly "keep the latest observed value, not a history"
 * (docs/data-model.md) rather than a risk of silently clearing data a
 * partial-update caller forgot to pass.
 */
export async function upsertObservedSpeakerStyle(
  db: D1Database,
  input: ObservedSpeakerStyleInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language, observed_tone, observed_emoji_usage)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET
         display_name = excluded.display_name,
         primary_language = excluded.primary_language,
         observed_tone = excluded.observed_tone,
         observed_emoji_usage = excluded.observed_emoji_usage,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      input.chatId,
      input.userId,
      input.displayName,
      input.primaryLanguage,
      input.observedTone,
      input.observedEmojiUsage,
    )
    .run();
}
