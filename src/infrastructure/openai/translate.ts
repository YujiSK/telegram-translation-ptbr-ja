import {
  isTranslationTargetLanguage,
  type Language,
  type TranslationTargetLanguage,
} from "../../domain/language";
import type {
  StyleSignals,
  TranslationOutcome,
  TranslationRequest,
} from "../../domain/translation";
import { PermanentUpstreamError } from "../../shared/errors";
import {
  TRANSLATION_JSON_SCHEMA,
  TRANSLATION_JSON_SCHEMA_NAME,
} from "../../prompts/translation-v1";
import { buildTranslationInputV2 } from "../../prompts/translation-v2";
import { callOpenAiResponses, type OpenAiApiCallOptions } from "./client";

/**
 * Turns a domain `TranslationRequest` into exactly one logical OpenAI
 * Responses API call (language detection + translation together — see
 * docs/architecture.md), and turns the validated result back into a
 * domain `TranslationOutcome`. The raw OpenAI response never crosses
 * this boundary as a domain type (docs/project-rules.md rule 2) — every
 * field is checked before use, and any mismatch is a
 * PermanentUpstreamError (never retried, never surfaced as a
 * translation — docs/project-rules.md rule 7).
 */

export interface TranslateMessageOptions extends OpenAiApiCallOptions {
  readonly model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(reason: string): never {
  throw new PermanentUpstreamError(
    `OpenAI returned a malformed translation result: ${reason}`,
    "openai",
  );
}

/** Finds the assistant's Structured Outputs JSON string in a validated Responses API envelope. */
function extractOutputText(envelope: Record<string, unknown>): string {
  const output = envelope.output;
  if (!Array.isArray(output)) {
    malformed("missing output array");
  }

  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || item.role !== "assistant") {
      continue;
    }
    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }

  malformed("no assistant output_text content found");
}

function isLanguage(value: unknown): value is Language {
  return value === "ja" || value === "pt-br" || value === "other";
}

function isTranslateAction(value: unknown): value is "translate" | "skip" {
  return value === "translate" || value === "skip";
}

function isNullableTargetLanguage(value: unknown): value is TranslationTargetLanguage | null {
  return value === null || value === "ja" || value === "pt-br";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStyleSignals(value: unknown): value is StyleSignals {
  if (!isRecord(value)) {
    return false;
  }
  const validTone = value.tone === "casual" || value.tone === "neutral" || value.tone === "formal";
  const validEmoji =
    value.emojiUsage === "none" || value.emojiUsage === "light" || value.emojiUsage === "frequent";
  return validTone && validEmoji;
}

function isNullableStyleSignals(value: unknown): value is StyleSignals | null {
  return value === null || isStyleSignals(value);
}

interface StructuredOutputPayload {
  readonly detectedLanguage: Language;
  readonly action: "translate" | "skip";
  readonly targetLanguage: TranslationTargetLanguage | null;
  readonly translatedText: string | null;
  readonly styleSignals: StyleSignals | null;
}

function parseStructuredOutput(rawText: string): StructuredOutputPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    malformed("output_text was not valid JSON");
  }

  if (!isRecord(parsed)) {
    malformed("structured output was not a JSON object");
  }

  const { detectedLanguage, action, targetLanguage, translatedText, styleSignals } = parsed;

  if (!isLanguage(detectedLanguage)) {
    malformed("invalid detectedLanguage");
  }
  if (!isTranslateAction(action)) {
    malformed("invalid action");
  }
  if (!isNullableTargetLanguage(targetLanguage)) {
    malformed("invalid targetLanguage");
  }
  if (!isNullableString(translatedText)) {
    malformed("invalid translatedText");
  }
  if (!isNullableStyleSignals(styleSignals)) {
    malformed("invalid styleSignals");
  }

  return { detectedLanguage, action, targetLanguage, translatedText, styleSignals };
}

/**
 * Cross-field logical consistency the JSON Schema alone can't express —
 * see docs/implementation-plan.md Stage E. Phase 5 review, Issue 6:
 * `styleSignals` must be present (non-null) for every targeted
 * translation, since Phase 5 records the observed style from this exact
 * response with no second OpenAI call — a `translate` action with a
 * `null` styleSignals is malformed, never a "translate now, observe
 * later" partial success.
 */
function validateLogicalConsistency(payload: StructuredOutputPayload): void {
  if (payload.detectedLanguage === "other") {
    if (
      payload.action !== "skip" ||
      payload.targetLanguage !== null ||
      payload.translatedText !== null ||
      payload.styleSignals !== null
    ) {
      malformed(
        "detectedLanguage=other must have action=skip with null target/translation/styleSignals",
      );
    }
    return;
  }

  const expectedTarget: TranslationTargetLanguage =
    payload.detectedLanguage === "ja" ? "pt-br" : "ja";
  if (
    payload.action !== "translate" ||
    payload.targetLanguage !== expectedTarget ||
    payload.translatedText === null ||
    payload.translatedText.trim() === "" ||
    payload.styleSignals === null
  ) {
    malformed(
      "detectedLanguage=ja|pt-br must have a matching translate action, non-empty text, and non-null styleSignals",
    );
  }
}

function toTranslationOutcome(payload: StructuredOutputPayload): TranslationOutcome {
  if (payload.action === "skip") {
    return {
      kind: "skipped",
      detectedLanguage: payload.detectedLanguage,
      reason: "untargeted-language",
    };
  }

  if (
    !isTranslationTargetLanguage(payload.detectedLanguage) ||
    payload.targetLanguage === null ||
    payload.translatedText === null
  ) {
    malformed("translate action missing a required field");
  }

  return {
    kind: "translated",
    detectedLanguage: payload.detectedLanguage,
    targetLanguage: payload.targetLanguage,
    translatedText: payload.translatedText,
    ...(payload.styleSignals !== null ? { styleSignals: payload.styleSignals } : {}),
  };
}

export async function translateMessage(
  request: TranslationRequest,
  options: TranslateMessageOptions,
): Promise<TranslationOutcome> {
  const input = buildTranslationInputV2({
    sourceText: request.sourceText,
    ...(request.replyContext !== undefined ? { replyContextText: request.replyContext.text } : {}),
    ...(request.memory !== undefined ? { memory: request.memory } : {}),
  });

  const body: Record<string, unknown> = {
    model: options.model,
    input,
    text: {
      format: {
        type: "json_schema",
        name: TRANSLATION_JSON_SCHEMA_NAME,
        schema: TRANSLATION_JSON_SCHEMA,
        strict: true,
      },
    },
  };

  const envelope = await callOpenAiResponses(body, options);
  if (!isRecord(envelope)) {
    malformed("response envelope was not a JSON object");
  }

  const rawText = extractOutputText(envelope);
  const payload = parseStructuredOutput(rawText);
  validateLogicalConsistency(payload);
  return toTranslationOutcome(payload);
}
