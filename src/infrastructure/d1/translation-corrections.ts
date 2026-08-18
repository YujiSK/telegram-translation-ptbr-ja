import type { TranslationTargetLanguage } from "../../domain/language";
import type { TranslationCorrection } from "../../domain/speaker-memory";
import { invalidD1Row, isNonEmptyString, isRecord, runD1Query } from "./row-validation";

export interface UpsertTranslationCorrectionInput {
  readonly chatId: number;
  readonly userId: number;
  readonly sourceLanguage: TranslationTargetLanguage;
  readonly targetLanguage: TranslationTargetLanguage;
  readonly sourceTerm: string;
  readonly targetTerm: string;
}

/** Matches the `CHECK (length(...) <= 100)` constraint in `migrations/0002_speaker_memory.sql`. */
const MAX_CORRECTION_TERM_LENGTH = 100;

function isTargetLanguage(value: unknown): value is TranslationTargetLanguage {
  return value === "ja" || value === "pt-br";
}

/** ja<->pt-br only — same-language pairs and "other" are never a valid correction direction. */
function isValidDirection(
  sourceLanguage: TranslationTargetLanguage,
  targetLanguage: TranslationTargetLanguage,
): boolean {
  return (
    (sourceLanguage === "ja" && targetLanguage === "pt-br") ||
    (sourceLanguage === "pt-br" && targetLanguage === "ja")
  );
}

function isValidTerm(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= MAX_CORRECTION_TERM_LENGTH;
}

/**
 * Validates a raw D1 row as defense-in-depth on top of the schema's own
 * `CHECK` constraints (direction, term length) — see
 * `migrations/0002_speaker_memory.sql` and docs/implementation-plan.md
 * Phase 5 review, Issue 3-B. Exported for direct boundary-validation unit
 * tests as well as internal use.
 */
export function parseCorrectionRow(row: unknown): TranslationCorrection {
  if (
    !isRecord(row) ||
    !isTargetLanguage(row.source_language) ||
    !isTargetLanguage(row.target_language) ||
    !isValidDirection(row.source_language, row.target_language) ||
    !isValidTerm(row.source_term) ||
    !isValidTerm(row.target_term)
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
 * language direction. Ordered fully deterministically — most recently
 * updated first, then `source_language`, `target_language`, and
 * `source_term` as stable tie-breakers, since two corrections in
 * opposite directions can otherwise share both `updated_at` and
 * `source_term` (see docs/implementation-plan.md Phase 5 review, Issue 4)
 * — so that capping/selection downstream — see
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
  const orderBy =
    "ORDER BY updated_at DESC, source_language ASC, target_language ASC, source_term ASC";

  // `.prepare()`/`.bind()` are constructed *inside* the `runD1Query`
  // callback (not before it), so a failure from either — not just from
  // the final `.all()` — is also classified as transient.
  const result = await runD1Query(() => {
    const statement =
      direction === undefined
        ? db
            .prepare(
              `SELECT source_language, target_language, source_term, target_term FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2 ${orderBy}`,
            )
            .bind(chatId, userId)
        : db
            .prepare(
              `SELECT source_language, target_language, source_term, target_term FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2 AND source_language = ?3 AND target_language = ?4 ${orderBy}`,
            )
            .bind(chatId, userId, direction.sourceLanguage, direction.targetLanguage);
    return statement.all();
  });
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
