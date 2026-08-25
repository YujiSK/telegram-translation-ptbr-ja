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
import { PermanentUpstreamError, TransientUpstreamError } from "../../shared/errors";
import {
  TRANSLATION_JSON_SCHEMA,
  buildTranslationInputGemini,
} from "../../prompts/translation-gemini";
import type { TranslateBoundary } from "../../application/translate-and-reply";
import { callGeminiInteraction, type GeminiApiCallOptions } from "./client";

/**
 * Turns a domain `TranslationRequest` into exactly one logical Gemini
 * Interactions API call, and turns the validated result back into a
 * domain `TranslationOutcome` — the same shape/contract
 * `infrastructure/openai/translate.ts` implements, since Gemini is a
 * drop-in semantic-escalation `TranslateBoundary` for the router
 * (`src/infrastructure/translation/router.ts`), never a
 * `TranslationProvider` that reports its own further escalation. The raw
 * Gemini response never crosses this boundary as a domain type
 * (docs/project-rules.md rule 2) — every field is checked before use,
 * and any mismatch is a `PermanentUpstreamError` (never retried, never
 * surfaced as a translation, per docs/project-rules.md rule 7).
 *
 * Response envelope (Phase 9.1B implementation note — re-verify against
 * current official documentation before any live use; see
 * `src/infrastructure/gemini/client.ts`'s module doc comment for why
 * this could not be re-confirmed live in this environment): the current
 * official REST examples for the Interactions API expose model output
 * text through `steps[]` entries of `type: "model_output"`, each with a
 * `content[]` array containing `type: "text"` parts — never the SDK-only
 * convenience field `output_text`, which this module does not assume
 * exists in a raw REST response.
 */

export interface GeminiTranslateOptions extends GeminiApiCallOptions {
  readonly model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows to `unknown[]`, not `any[]` — see the identical helper in `src/infrastructure/workers-ai/translate.ts` for why `Array.isArray`'s own type predicate is avoided here. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function malformed(reason: string): never {
  throw new PermanentUpstreamError(
    `Gemini returned a malformed translation result: ${reason}`,
    "gemini",
  );
}

/**
 * Interactions API responses are only safe to surface when the top-level
 * interaction status is fully `completed`. A 2xx HTTP response can still
 * represent an unfinished/failed interaction, so status validation must
 * happen before reading any model-output step.
 *
 * `incomplete` / `requires_action` are deterministic for the returned
 * interaction and therefore permanent for this delivery. Runtime states
 * (`in_progress`, `failed`, `cancelled`) are treated as transient so a
 * Telegram redelivery may retry with a fresh interaction. Missing/unknown
 * status is a malformed successful provider response and stays permanent.
 */
function validateInteractionStatus(envelope: Record<string, unknown>): void {
  const status = envelope.status;
  if (status === "completed") {
    return;
  }
  if (status === "in_progress" || status === "failed" || status === "cancelled") {
    throw new TransientUpstreamError("Gemini interaction did not complete successfully", "gemini");
  }
  if (status === "incomplete" || status === "requires_action") {
    throw new PermanentUpstreamError(
      "Gemini interaction did not produce a final translation",
      "gemini",
    );
  }
  malformed("missing or unknown interaction status");
}

/**
 * Finds the model's Structured Outputs JSON string among the response's
 * `steps[]` — the first `type: "model_output"` step whose `content[]`
 * contains a `type: "text"` part. Every field is checked structurally;
 * an unexpected shape is a permanent (never retried) failure, exactly
 * like a malformed OpenAI/Workers AI response.
 */
function extractModelOutputText(envelope: Record<string, unknown>): string {
  const steps = envelope.steps;
  if (!isUnknownArray(steps) || steps.length === 0) {
    malformed("missing steps array");
  }

  for (const step of steps) {
    if (!isRecord(step) || step.type !== "model_output") {
      continue;
    }
    const content = step.content;
    if (!isUnknownArray(content)) {
      continue;
    }
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        if (part.text.trim() === "") {
          malformed("model_output text content was empty");
        }
        return part.text;
      }
    }
  }

  malformed("no model_output text content found in steps");
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
    malformed("model output text was not valid JSON");
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

/** Cross-field logical consistency the JSON Schema alone can't express — identical rules to `infrastructure/openai/translate.ts`, since Gemini's output contract has no escalation concept to additionally check (unlike the Workers AI adapter). */
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

/**
 * Phase 9.1B implementation note (re-verify before live use — see this
 * file's module doc comment): the request body's exact top-level field
 * names (`model`, `system_instruction`, `input`, `response_format`) and
 * `response_format`'s shape follow the operational facts given for this
 * task; `system_instruction`/`input` are sent as plain strings, the
 * simplest defensible interpretation available without live
 * documentation access in this environment. `store: false` is enforced
 * unconditionally by `callGeminiInteraction` itself, not only here.
 */
async function translateWithGemini(
  request: TranslationRequest,
  options: GeminiTranslateOptions,
): Promise<TranslationOutcome> {
  const prompt = buildTranslationInputGemini({
    sourceText: request.sourceText,
    ...(request.replyContext !== undefined ? { replyContextText: request.replyContext.text } : {}),
    ...(request.memory !== undefined ? { memory: request.memory } : {}),
  });

  const body: Record<string, unknown> = {
    model: options.model,
    system_instruction: prompt.systemInstruction,
    input: prompt.input,
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: TRANSLATION_JSON_SCHEMA,
    },
  };

  const envelope = await callGeminiInteraction(body, options);
  if (!isRecord(envelope)) {
    malformed("response envelope was not a JSON object");
  }
  validateInteractionStatus(envelope);

  const rawText = extractModelOutputText(envelope);
  const payload = parseStructuredOutput(rawText);
  validateLogicalConsistency(payload);
  return toTranslationOutcome(payload);
}

export function createGeminiTranslationBoundary(
  options: GeminiTranslateOptions,
): TranslateBoundary {
  return { translate: (request) => translateWithGemini(request, options) };
}
