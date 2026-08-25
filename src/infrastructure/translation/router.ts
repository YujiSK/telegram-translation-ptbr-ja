import type { TranslateBoundary } from "../../application/translate-and-reply";
import type { TranslationOutcome, TranslationRequest } from "../../domain/translation";
import { ConfigurationError, EscalationRequiredError } from "../../shared/errors";
import type { TranslationProvider } from "./provider";

/**
 * Phase 9.1A: routes the single translation-path call to exactly one
 * provider, chosen once per request by non-secret config
 * (`TRANSLATION_PROVIDER`) — never by runtime fan-out or automatic
 * fallback. Satisfies the existing `application/translate-and-reply.ts`
 * `TranslateBoundary` contract unchanged, so `application/` and
 * `domain/` stay completely unaware that more than one provider exists.
 *
 * Forbidden by design (docs/decisions/0002-multi-provider-translation-routing.md,
 * "Bounded fan-out policy" and the Phase 9.1A prompt, "Forbidden"): a
 * Workers AI transient/permanent failure never falls through to OpenAI;
 * a Workers AI `needsEscalation: true` result never falls through to
 * OpenAI either (Gemini escalation is Phase 9.1B) — it becomes an
 * `EscalationRequiredError` instead, a safe control-flow signal, not a
 * failure of either provider. Each mode calls exactly one provider, at
 * most once, every time.
 */

export type TranslationRouterMode = "workers-ai" | "openai";

export interface TranslationRouterOptions {
  readonly mode: TranslationRouterMode;
  /** Required when mode === "workers-ai"; never called when mode === "openai". */
  readonly workersAi?: TranslationProvider;
  /** Required when mode === "openai"; never called when mode === "workers-ai". Reuses the existing OpenAI TranslateBoundary directly — it already returns a plain TranslationOutcome with no escalation concept. */
  readonly openai?: TranslateBoundary;
}

async function translateViaWorkersAi(
  provider: TranslationProvider,
  request: TranslationRequest,
): Promise<TranslationOutcome> {
  const candidate = await provider.translate(request);
  if (candidate.needsEscalation) {
    throw new EscalationRequiredError(candidate.escalationReason);
  }
  return candidate.outcome;
}

export function createTranslationRouter(options: TranslationRouterOptions): TranslateBoundary {
  return {
    async translate(request: TranslationRequest): Promise<TranslationOutcome> {
      if (options.mode === "workers-ai") {
        if (options.workersAi === undefined) {
          throw new ConfigurationError(
            "Translation router is configured for workers-ai but no Workers AI provider was supplied",
          );
        }
        return translateViaWorkersAi(options.workersAi, request);
      }

      if (options.openai === undefined) {
        throw new ConfigurationError(
          "Translation router is configured for openai but no OpenAI boundary was supplied",
        );
      }
      return options.openai.translate(request);
    },
  };
}
