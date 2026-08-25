import { TRANSLATION_JSON_SCHEMA, TRANSLATION_JSON_SCHEMA_NAME } from "./translation-v1";
import {
  TRANSLATION_CORE_INSTRUCTIONS,
  buildTranslationUserContentLines,
  type TranslationPromptDataShared,
} from "./translation-shared";

/**
 * Phase 9.1B: the Gemini semantic-escalation prompt. Reuses the exact
 * same translation semantics as `translation-v2.ts`/`translation-workers-ai.ts`
 * (via `./translation-shared.ts`) and — unlike the Workers AI prompt —
 * adds no escalation-decision instructions: Gemini is the final
 * semantic-quality layer for Phase 9.1B, not another escalation source
 * (docs/decisions/0002-multi-provider-translation-routing.md). Its
 * response shape is therefore identical to the plain translation
 * contract `translation-v1.ts` already defines (no `needsEscalation`/
 * `escalationReason`), so `TRANSLATION_JSON_SCHEMA`/`TRANSLATION_JSON_SCHEMA_NAME`
 * are reused directly rather than redefined — see
 * `src/infrastructure/translation/router.ts` for why the router, not
 * Gemini itself, owns the escalation decision.
 *
 * Deliberately does NOT accept or forward the Workers AI provisional
 * translation, outcome, or free-form reasoning — only the original,
 * unmodified `TranslationRequest` fields (source text, at most one reply
 * context, resolved speaker-memory hints) ever reach this prompt, so
 * Gemini forms an independent second opinion rather than anchoring to a
 * low-confidence first attempt (docs/phase9-provider-plan.md, "Gemini
 * prompt semantics").
 */

export const TRANSLATION_GEMINI_PROMPT_VERSION = "translation-gemini-v1";

export { TRANSLATION_JSON_SCHEMA, TRANSLATION_JSON_SCHEMA_NAME };

const SYSTEM_INSTRUCTION = `${TRANSLATION_CORE_INSTRUCTIONS}

Respond using only the structured output format you have been given. Do not include any text outside that structure.`;

export type TranslationPromptDataGemini = TranslationPromptDataShared;

/**
 * The Gemini Interactions API's request shape uses `system_instruction`
 * (stable rules) and `input` (the current bounded request) as separate
 * top-level fields, not a chat-style message array — see
 * `src/infrastructure/gemini/client.ts` for the exact request contract
 * this feeds into, and its module doc comment for why this shape is a
 * documented best-effort interpretation pending live re-verification.
 */
export interface GeminiInteractionPromptParts {
  readonly systemInstruction: string;
  readonly input: string;
}

export function buildTranslationInputGemini(
  data: TranslationPromptDataGemini,
): GeminiInteractionPromptParts {
  const userContentLines = buildTranslationUserContentLines(data);

  return {
    systemInstruction: SYSTEM_INSTRUCTION,
    input: userContentLines.join("\n"),
  };
}
