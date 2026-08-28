import {
  TRANSLATION_CORE_INSTRUCTIONS,
  buildTranslationUserContentLines,
  type TranslationPromptDataShared,
} from "./translation-shared";

/**
 * Phase 9.1A: the Workers AI routine-provider prompt. Reuses the exact
 * same translation semantics as `translation-v2.ts` (via
 * `./translation-shared.ts`) and adds one Workers-AI-specific
 * instruction block: the escalation decision, which OpenAI's prompt has
 * no equivalent of. See docs/decisions/0002-multi-provider-translation-routing.md
 * and src/infrastructure/translation/provider.ts for why
 * `needsEscalation`/`escalationReason` exist as a structured, fixed-enum
 * field rather than free-form model text.
 */

export const TRANSLATION_WORKERS_AI_PROMPT_VERSION = "translation-workers-ai-v1";

export const WORKERS_AI_JSON_SCHEMA_NAME = "family_chat_translation_with_escalation";

const ESCALATION_INSTRUCTIONS = `Escalation decision: after deciding whether and how to translate, also decide whether this specific message needs stronger handling than you can safely provide yourself. Set needsEscalation to true only when justified by exactly one of these fixed reasons — never invent a different one:
- "ambiguous-context": the meaning genuinely depends on context you were not given.
- "mixed-language": the message meaningfully mixes multiple languages in a way that makes one confident translation unsafe.
- "correction-sensitive": a known term correction almost matches but you are not fully confident it applies here.
- "style-sensitive": the speaker's style preference and the message's own tone conflict in a way you cannot safely resolve.
- "low-confidence": you are not otherwise confident the translation (or the skip decision) is accurate.
When none of these apply, set needsEscalation to false and escalationReason to "none". Never explain your escalation reasoning in translatedText or anywhere outside the escalationReason field — escalationReason must be exactly one of the fixed values above, never free-form text.`;

const SYSTEM_INSTRUCTIONS = `${TRANSLATION_CORE_INSTRUCTIONS}

${ESCALATION_INSTRUCTIONS}

Respond using only the structured output format you have been given. Do not include any text outside that structure.`;

export type TranslationPromptDataWorkersAi = TranslationPromptDataShared;

/**
 * Workers AI runtime compatibility note: although the generated
 * `ChatCompletionMessageParam` type accepts `role: "developer"`,
 * live `@cf/zai-org/glm-4.7-flash` inference did not reliably apply
 * developer-role instructions. A live synthetic regression check on
 * 2026-08-28 showed the model ignoring the JA<->PT-BR policy and
 * translating Japanese to English, which then failed our cross-field
 * validator. The same prompt sent as `role: "system"` produced the
 * expected PT-BR result. Keep Workers AI instructions on the system
 * role unless Cloudflare/model behavior is re-verified in live inference.
 */
export interface WorkersAiChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export function buildTranslationInputWorkersAi(
  data: TranslationPromptDataWorkersAi,
): WorkersAiChatMessage[] {
  const userContentLines = buildTranslationUserContentLines(data);

  return [
    { role: "system", content: SYSTEM_INSTRUCTIONS },
    { role: "user", content: userContentLines.join("\n") },
  ];
}

/**
 * Structured Outputs strict-mode JSON Schema for Workers AI's
 * `response_format: { type: "json_schema", json_schema: { schema, strict: true } }`
 * (Chat Completions-compatible shape). Extends `translation-v1.ts`'s
 * schema with `needsEscalation`/`escalationReason` — every property is
 * listed in `required` (strict mode has no "optional" property concept;
 * a field that doesn't apply is a nullable type instead), and every
 * object sets `additionalProperties: false`.
 */
export const WORKERS_AI_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "detectedLanguage",
    "action",
    "targetLanguage",
    "translatedText",
    "styleSignals",
    "needsEscalation",
    "escalationReason",
  ],
  properties: {
    detectedLanguage: {
      type: "string",
      enum: ["ja", "pt-br", "other"],
    },
    action: {
      type: "string",
      enum: ["translate", "skip"],
    },
    targetLanguage: {
      type: ["string", "null"],
      enum: ["ja", "pt-br", null],
    },
    translatedText: {
      type: ["string", "null"],
    },
    styleSignals: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["tone", "emojiUsage"],
      properties: {
        tone: {
          type: "string",
          enum: ["casual", "neutral", "formal"],
        },
        emojiUsage: {
          type: "string",
          enum: ["none", "light", "frequent"],
        },
      },
    },
    needsEscalation: {
      type: "boolean",
    },
    escalationReason: {
      type: "string",
      enum: [
        "none",
        "ambiguous-context",
        "mixed-language",
        "correction-sensitive",
        "style-sensitive",
        "low-confidence",
      ],
    },
  },
} as const;
