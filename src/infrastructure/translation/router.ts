import { selectDeepLRoute } from "../deepl/gate";
import type { TranslateBoundary } from "../../application/translate-and-reply";
import type { TranslationOutcome, TranslationRequest } from "../../domain/translation";
import { ConfigurationError, EscalationRequiredError } from "../../shared/errors";
import type { TranslationProvider } from "./provider";

/**
 * Infrastructure-only provider selection; domain/application see one outcome.
 * DeepL mode preflights the original request and calls at most one provider:
 * DeepL OR Gemini. No result or failure can trigger another provider call.
 * Workers AI rollback retains semantic escalation to Gemini (at most two).
 * OpenAI legacy remains isolated. Every attempt uses the original request.
 */

export type TranslationRouterMode = "deepl" | "workers-ai" | "openai";

/** Phase 9.1B: which provider actually produced the final outcome — a safe fixed enum for logging only, never attached to `TranslationOutcome` itself (docs/phase9-provider-plan.md, "Provider metadata"). */
export type TranslationRouterFinalProvider = "deepl" | "workers-ai" | "openai" | "gemini";

export interface TranslationRouterOptions {
  readonly mode: TranslationRouterMode;
  readonly deepl?: TranslationProvider;
  /** Required when mode === "workers-ai"; never called when mode === "openai". */
  readonly workersAi?: TranslationProvider;
  /**
   * Phase 9.1B: the semantic escalation provider, called when the DeepL preflight selects Gemini or
   * `workersAi`'s candidate has `needsEscalation: true`. Leave undefined
   * to keep Phase 9.1A behavior (`needsEscalation: true` throws
   * `EscalationRequiredError`) — this is how "Gemini escalation
   * disabled" is represented; the router has no separate boolean flag
   * for it. Never called when mode === "openai".
   */
  readonly gemini?: TranslateBoundary;
  /**
   * Reserves one unit of the Gemini attempt budget immediately before
   * the single Gemini HTTP attempt — called only when `gemini` is
   * configured and the selected route needs Gemini. May reject
   * (typically with `RateLimitExceededError`/`UsageLimitExceededError` —
   * see `src/shared/errors.ts`); that rejection propagates immediately
   * and Gemini is never called, mirroring
   * `infrastructure/openai/client.ts`'s `beforeAttempt` guard.
   */
  readonly beforeGeminiAttempt?: () => Promise<void>;
  /** Required when mode === "openai"; never called when mode === "workers-ai". Reuses the existing OpenAI TranslateBoundary directly — it already returns a plain TranslationOutcome with no escalation concept. */
  readonly openai?: TranslateBoundary;
  /** Optional observer, called synchronously with the provider that actually produced the final outcome — see the module doc comment, "Provider metadata". Never called if the router throws instead of returning an outcome. */
  readonly onFinalProviderSelected?: (provider: TranslationRouterFinalProvider) => void;
}

async function translateViaWorkersAi(
  options: TranslationRouterOptions,
  workersAi: TranslationProvider,
  request: TranslationRequest,
): Promise<TranslationOutcome> {
  const candidate = await workersAi.translate(request);

  if (!candidate.needsEscalation) {
    options.onFinalProviderSelected?.("workers-ai");
    return candidate.outcome;
  }

  if (options.gemini === undefined) {
    // Gemini escalation not configured — Phase 9.1A behavior, never a
    // fallback to OpenAI or any other provider.
    throw new EscalationRequiredError(candidate.escalationReason);
  }

  if (options.beforeGeminiAttempt) {
    // Deliberately outside any try/catch here: a budget rejection is
    // never treated as a Gemini upstream failure and Gemini is never
    // called in that case (mirrors infrastructure/openai/client.ts's
    // beforeAttempt guard).
    await options.beforeGeminiAttempt();
  }

  const outcome = await options.gemini.translate(request);
  options.onFinalProviderSelected?.("gemini");
  return outcome;
}

export function createTranslationRouter(options: TranslationRouterOptions): TranslateBoundary {
  return {
    async translate(request: TranslationRequest): Promise<TranslationOutcome> {
      if (options.mode === "deepl") {
        const route = selectDeepLRoute(request);
        if (route.provider === "gemini") {
          if (options.gemini === undefined) throw new EscalationRequiredError(route.reason);
          await options.beforeGeminiAttempt?.();
          const outcome = await options.gemini.translate(request);
          options.onFinalProviderSelected?.("gemini");
          return outcome;
        }
        if (options.deepl === undefined) throw new ConfigurationError("DeepL provider is missing");
        const candidate = await options.deepl.translate(request);
        // Never escalate after calling DeepL, even if an adapter requests it.
        if (candidate.needsEscalation)
          throw new EscalationRequiredError(candidate.escalationReason);
        options.onFinalProviderSelected?.("deepl");
        return candidate.outcome;
      }
      if (options.mode === "workers-ai") {
        if (options.workersAi === undefined) {
          throw new ConfigurationError(
            "Translation router is configured for workers-ai but no Workers AI provider was supplied",
          );
        }
        return translateViaWorkersAi(options, options.workersAi, request);
      }

      if (options.openai === undefined) {
        throw new ConfigurationError(
          "Translation router is configured for openai but no OpenAI boundary was supplied",
        );
      }
      const outcome = await options.openai.translate(request);
      options.onFinalProviderSelected?.("openai");
      return outcome;
    },
  };
}
