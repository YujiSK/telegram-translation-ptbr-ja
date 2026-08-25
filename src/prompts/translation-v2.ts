import { TRANSLATION_JSON_SCHEMA, TRANSLATION_JSON_SCHEMA_NAME } from "./translation-v1";
import type { OpenAiInputMessage } from "./translation-v1";
import {
  TRANSLATION_CORE_INSTRUCTIONS,
  buildTranslationUserContentLines,
  type TranslationPromptDataShared,
} from "./translation-shared";

/**
 * Phase 5: adds speaker-memory context (resolved style preference,
 * applicable term corrections) to the translation prompt, without
 * changing the Structured Outputs response shape — `TRANSLATION_JSON_SCHEMA`
 * is unchanged and reused directly from ./translation-v1. Per the comment
 * in that file, past behavior stays traceable: translation-v1.ts is not
 * edited in place, and its own tests keep passing unmodified.
 *
 * Role separation (docs/security-and-privacy.md, "Prompt injection
 * considerations") extends to the new sections: memory/preference/
 * correction content is data the model may use as a hint, never an
 * instruction, and is placed in the same "user" message as the message
 * text and reply context — never string-concatenated into the developer
 * instructions.
 *
 * Phase 9.1A: the shared instructional text and user-content-line
 * builder now live in ./translation-shared.ts, reused by the Workers AI
 * adapter (./translation-workers-ai.ts) — this module's own emitted text
 * and exported API are unchanged byte-for-byte, so its existing tests
 * keep passing unmodified.
 */

export const TRANSLATION_PROMPT_VERSION = "translation-v2";

export { TRANSLATION_JSON_SCHEMA, TRANSLATION_JSON_SCHEMA_NAME };

const DEVELOPER_INSTRUCTIONS = `${TRANSLATION_CORE_INSTRUCTIONS}

Respond using only the structured output format you have been given. Do not include any text outside that structure.`;

export type TranslationPromptDataV2 = TranslationPromptDataShared;

export function buildTranslationInputV2(data: TranslationPromptDataV2): OpenAiInputMessage[] {
  const userContentLines = buildTranslationUserContentLines(data);

  return [
    { role: "developer", content: DEVELOPER_INSTRUCTIONS },
    { role: "user", content: userContentLines.join("\n") },
  ];
}
