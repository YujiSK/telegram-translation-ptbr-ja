/**
 * Language detection is implemented in Phase 4 (OpenAI). This module only
 * defines the vocabulary so other Phase 1 types can reference it
 * type-safely.
 */

export type Language = "ja" | "pt-br" | "other";

/** The subset of `Language` the bot actually translates between. */
export type TranslationTargetLanguage = Exclude<Language, "other">;

export function isTranslationTargetLanguage(
  language: Language,
): language is TranslationTargetLanguage {
  return language === "ja" || language === "pt-br";
}

export function oppositeTranslationTarget(
  language: TranslationTargetLanguage,
): TranslationTargetLanguage {
  return language === "ja" ? "pt-br" : "ja";
}
