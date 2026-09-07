import type { TranslationRequest } from "../../domain/translation";
import type { EscalationReason } from "../../shared/errors";

export type DeepLRoute =
  | { readonly provider: "deepl"; readonly targetLanguage: "PT-BR" | "JA" }
  | { readonly provider: "gemini"; readonly reason: EscalationReason }
  | { readonly provider: "skip" };

const SHORT_JA_CONTEXT_SENSITIVE = new Set([
  "\u3046\u3093",
  "\u3046\u3046\u3093",
  "\u3048",
  "\u3048\u3063",
  "\u306f\u3084\u3063",
  "\u305d\u3063\u304b",
  "\u305d\u3046\u304b",
  "\u304a\u3051",
  "\u30aa\u30c3\u30b1\u30fc",
  "\u307e\u3058",
  "\u30de\u30b8",
  "\u3048\u30fc",
  "\u8349",
  "\u306a\u3093\u3067",
  "\u3069\u3046\u3044\u3046\u3053\u3068",
  "\u3069\u3046\u306a\u3063\u3066\u3093\u3060",
  "\u306a\u3093\u3058\u3083\u305d\u308a\u3083",
]);

function stripChatPunctuation(text: string): string {
  return text.replace(/[!\uFF01?\uFF1F\u2026\u30FC\u301C~]+$/u, "");
}

function hasOnlyJapaneseAndLatinLetters(letters: readonly string[]): boolean {
  return letters.every((c) =>
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Latin}\u30FC]/u.test(c),
  );
}

function latinTokensAreLikelyNamesOrAcronyms(text: string): boolean {
  const tokens = text.match(/\p{Script=Latin}+/gu) ?? [];
  return (
    tokens.length > 0 &&
    tokens.every((token) => /^[A-Z][a-z]+$/.test(token) || /^[A-Z]{2,}$/.test(token))
  );
}

/** Conservative deterministic preflight; no model or network call. */
export function selectDeepLRoute(request: TranslationRequest): DeepLRoute {
  const { sourceText, memory } = request;

  if (memory?.applicableCorrections.length) {
    return { provider: "gemini", reason: "correction-sensitive" };
  }
  if (memory?.tone.source === "explicit" || memory?.emojiUsage.source === "explicit") {
    return { provider: "gemini", reason: "style-sensitive" };
  }

  const normalized = sourceText.normalize("NFC").trim();
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(normalized) || !/\p{L}/u.test(normalized)) {
    return { provider: "skip" };
  }

  const letters = [...normalized].filter((c) => /\p{L}/u.test(c));
  const hasJapanese = letters.some((c) =>
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(c),
  );
  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized);
  const hasLatin = letters.some((c) => /\p{Script=Latin}/u.test(c));

  if (hasJapanese) {
    if (!hasKana || !hasOnlyJapaneseAndLatinLetters(letters)) {
      return { provider: "gemini", reason: "ambiguous-context" };
    }

    if (SHORT_JA_CONTEXT_SENSITIVE.has(stripChatPunctuation(normalized))) {
      return { provider: "gemini", reason: "ambiguous-context" };
    }

    if (hasLatin && !latinTokensAreLikelyNamesOrAcronyms(normalized)) {
      return { provider: "gemini", reason: "mixed-language" };
    }

    return { provider: "deepl", targetLanguage: "PT-BR" };
  }

  if (hasLatin && letters.every((c) => /\p{Script=Latin}/u.test(c))) {
    return { provider: "deepl", targetLanguage: "JA" };
  }

  return { provider: "gemini", reason: "ambiguous-context" };
}
