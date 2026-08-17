import type { TranslationTargetLanguage } from "../../domain/language";
import type { TranslationCorrection } from "../../domain/speaker-memory";
import { invalidD1Row, isNonEmptyString, isRecord } from "./row-validation";

export interface UpsertTranslationCorrectionInput {
  readonly chatId: number;
  readonly userId: number;
  readonly sourceLanguage: TranslationTargetLanguage;
  readonly targetLanguage: TranslationTargetLanguage;
  readonly sourceTerm: string;
  readonly targetTerm: string;
}

function isTargetLanguage(value: unknown): value is TranslationTargetLanguage {
  return value === "ja" || value === "pt-br";
}

function parseCorrectionRow(row: unknown): TranslationCorrection {
  if (
    !isRecord(row) ||
    !isTargetLanguage(row.source_language) ||
    !isTargetLanguage(row.target_language) ||
    !isNonEmptyString(row.source_term) ||
    !isNonEmptyString(row.target_term)
  ) {
    throw invalidD1Row("translation correction");
  }
  return {
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    sourceTerm: row.source_term,
    targetTerm: row.target_term,
  };
}

/**
 * All corrections for a `(chat_id, user_id)`, optionally narrowed to one
 * language direction. Ordered deterministically (most recently updated
 * first, then `source_term`) so that capping/selection downstream — see
 * `src/domain/speaker-memory.ts` `selectApplicableCorrections` — is
 * reproducible. Never filters by message content: that comparison
 * happens in a pure domain function, not in SQL, so message text never
 * has to pass through this repository or be sent to D1.
 */
export async function listTranslationCorrections(
  db: D1Database,
  chatId: number,
  userId: number,
  direction?: {
    readonly sourceLanguage: TranslationTargetLanguage;
    readonly targetLanguage: TranslationTargetLanguage;
  },
): Promise<TranslationCorrection[]> {
  const statement =
    direction === undefined
      ? db
          .prepare(
            "SELECT source_language, target_language, source_term, target_term FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC, source_term ASC",
          )
          .bind(chatId, userId)
      : db
          .prepare(
            "SELECT source_language, target_language, source_term, target_term FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2 AND source_language = ?3 AND target_language = ?4 ORDER BY updated_at DESC, source_term ASC",
          )
          .bind(chatId, userId, direction.sourceLanguage, direction.targetLanguage);

  const result = await statement.all();
  return result.results.map(parseCorrectionRow);
}

/**
 * Insert-or-update a single correction, keyed on the full composite
 * primary key (`migrations/0002_speaker_memory.sql`) — re-submitting the
 * same `(chat_id, user_id, source_language, target_language, source_term)`
 * simply updates `target_term`. An invalid language direction or an
 * empty/too-long term is rejected by the schema's `CHECK` constraints at
 * the SQL boundary, not pre-validated here.
 */
export async function upsertTranslationCorrection(
  db: D1Database,
  input: UpsertTranslationCorrectionInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (chat_id, user_id, source_language, target_language, source_term) DO UPDATE SET
         target_term = excluded.target_term,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      input.chatId,
      input.userId,
      input.sourceLanguage,
      input.targetLanguage,
      input.sourceTerm,
      input.targetTerm,
    )
    .run();
}
