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
import { PermanentUpstreamError, type EscalationReason } from "../../shared/errors";
import {
  WORKERS_AI_JSON_SCHEMA,
  WORKERS_AI_JSON_SCHEMA_NAME,
  buildTranslationInputWorkersAi,
} from "../../prompts/translation-workers-ai";
import type { ProviderTranslationCandidate, TranslationProvider } from "../translation/provider";
import { callWorkersAiChat, type WorkersAiApiCallOptions } from "./client";

/**
 * Turns a domain `TranslationRequest` into exactly one logical Workers AI
 * chat-completions call (language detection + translation + escalation
 * decision together — one call, never split, mirroring
 * `infrastructure/openai/translate.ts`), and turns the validated result
 * back into an infrastructure-only `ProviderTranslationCandidate`. The
 * raw Workers AI response never crosses this boundary as a domain type
 * (docs/project-rules.md rule 2) — every field is checked before use,
 * and any mismatch is a `PermanentUpstreamError` (never retried, never
 * surfaced as a translation, per docs/project-rules.md rule 7). Workers
 * AI's own JSON Schema mode does not guarantee compliance in every case
 * (Cloudflare's own documentation), so this module validates just as
 * strictly as it would if no schema constraint were requested at all.
 */

export type WorkersAiTranslateOptions = WorkersAiApiCallOptions;

export function createWorkersAiTranslationProvider(
  options: WorkersAiTranslateOptions,
): TranslationProvider {
  return { translate: (request) => translateWithWorkersAi(request, options) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows to `unknown[]`, not `any[]` — `Array.isArray`'s own type predicate widens to `any[]`, which would make every element access unsafely typed `any`. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function malformed(reason: string): never {
  throw new PermanentUpstreamError(
    `Workers AI returned a malformed translation result: ${reason}`,
    "workers-ai",
  );
}

/**
 * Finds the assistant's Structured Outputs JSON string in a validated
 * Chat Completions envelope (`choices[0].message.content`). Phase 9.1A
 * review hardening: this envelope shape is verified against the
 * generated `ChatCompletionsOutput`/`ChatCompletionChoice`/
 * `ChatCompletionResponseMessage` types in `worker-configuration.d.ts` —
 * `Base_Ai_Cf_Zai_Org_Glm_4_7_Flash.postProcessedOutputs` is
 * `ChatCompletionsOutput`, whose `choices[number].message.content` is
 * exactly this field. Still manually validated at runtime, not just
 * type-asserted: Cloudflare's own Structured Outputs documentation does
 * not guarantee schema (or envelope) compliance in every case, so this
 * function treats the raw response as `unknown` regardless of what the
 * generated type promises.
 */
function extractAssistantContent(envelope: Record<string, unknown>): string {
  const choices = envelope.choices;
  if (!isUnknownArray(choices) || choices.length === 0) {
    malformed("missing choices array");
  }

  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    malformed("missing choices[0].message");
  }

  const content = first.message.content;
  if (typeof content !== "string" || content.trim() === "") {
    malformed("missing or empty choices[0].message.content");
  }

  return content;
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

const ESCALATION_REASONS: readonly EscalationReason[] = [
  "none",
  "ambiguous-context",
  "mixed-language",
  "correction-sensitive",
  "style-sensitive",
  "low-confidence",
];

function isEscalationReason(value: unknown): value is EscalationReason {
  return (ESCALATION_REASONS as readonly unknown[]).includes(value);
}

interface StructuredOutputPayload {
  readonly detectedLanguage: Language;
  readonly action: "translate" | "skip";
  readonly targetLanguage: TranslationTargetLanguage | null;
  readonly translatedText: string | null;
  readonly styleSignals: StyleSignals | null;
  readonly needsEscalation: boolean;
  readonly escalationReason: EscalationReason;
}

function parseStructuredOutput(rawText: string): StructuredOutputPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    malformed("assistant content was not valid JSON");
  }

  if (!isRecord(parsed)) {
    malformed("structured output was not a JSON object");
  }

  const {
    detectedLanguage,
    action,
    targetLanguage,
    translatedText,
    styleSignals,
    needsEscalation,
    escalationReason,
  } = parsed;

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
  if (typeof needsEscalation !== "boolean") {
    malformed("invalid needsEscalation");
  }
  if (!isEscalationReason(escalationReason)) {
    malformed("invalid escalationReason");
  }

  return {
    detectedLanguage,
    action,
    targetLanguage,
    translatedText,
    styleSignals,
    needsEscalation,
    escalationReason,
  };
}

/**
 * Cross-field logical consistency the JSON Schema alone can't express —
 * mirrors `infrastructure/openai/translate.ts`'s rules exactly, plus one
 * additional Phase 9.1A rule: `needsEscalation` and `escalationReason`
 * must agree (`needsEscalation === false` iff `escalationReason ===
 * "none"`). A provisional candidate may still carry a structurally valid
 * translate/skip payload alongside `needsEscalation: true` — the router
 * (not this module) is responsible for never surfacing that provisional
 * result as final.
 */
function validateLogicalConsistency(payload: StructuredOutputPayload): void {
  if (
    (payload.needsEscalation && payload.escalationReason === "none") ||
    (!payload.needsEscalation && payload.escalationReason !== "none")
  ) {
    malformed("needsEscalation and escalationReason are inconsistent");
  }

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

async function translateWithWorkersAi(
  request: TranslationRequest,
  options: WorkersAiTranslateOptions,
): Promise<ProviderTranslationCandidate> {
  const messages = buildTranslationInputWorkersAi({
    sourceText: request.sourceText,
    ...(request.replyContext !== undefined ? { replyContextText: request.replyContext.text } : {}),
    ...(request.memory !== undefined ? { memory: request.memory } : {}),
  });

  /**
   * Phase 9.1A review hardening: verified against this repo's generated
   * `worker-configuration.d.ts` (ambient global types, no import needed
   * — see `ResponseFormatJSONSchema`, part of `ChatCompletionsCommonOptions.response_format`,
   * which `Base_Ai_Cf_Zai_Org_Glm_4_7_Flash.inputs` — via `ChatCompletionsInput`
   * = `ChatCompletionsMessagesInput` — includes). The direct-binding
   * contract for a Chat-Completions-shaped model is
   * `{ type: "json_schema", json_schema: { name, schema, strict } }` —
   * the schema itself nested one level under `json_schema`, not the
   * OpenAI Responses-API wrapper shape (`{ name, schema, strict }` at
   * the top level of `response_format`, which this model's generated
   * type does not accept). The explicit `ResponseFormatJSONSchema`
   * annotation below makes this a type-checked claim: `npm run
   * typecheck` fails if this ever drifts from the generated contract.
   */
  const responseFormat: ResponseFormatJSONSchema = {
    type: "json_schema",
    json_schema: {
      name: WORKERS_AI_JSON_SCHEMA_NAME,
      schema: WORKERS_AI_JSON_SCHEMA,
      strict: true,
    },
  };

  const inputs: Record<string, unknown> = { messages, response_format: responseFormat };

  const envelope = await callWorkersAiChat(inputs, options);
  if (!isRecord(envelope)) {
    malformed("response envelope was not a JSON object");
  }

  const rawText = extractAssistantContent(envelope);
  const payload = parseStructuredOutput(rawText);
  validateLogicalConsistency(payload);

  return {
    outcome: toTranslationOutcome(payload),
    needsEscalation: payload.needsEscalation,
    escalationReason: payload.escalationReason,
  };
}
