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
 * Phase 9.1B adds one bounded exception: when `workers-ai` mode's
 * provider returns `needsEscalation: true` AND the router was actually
 * configured with a `gemini` boundary (i.e. Gemini semantic escalation
 * is enabled — see src/handlers/telegram-webhook.ts, "Phase 9.1B:
 * Gemini escalation wiring"), the router calls Gemini exactly once, with
 * the *original* `TranslationRequest` — never Workers AI's provisional
 * outcome, translated text, or free-form reasoning (Gemini forms an
 * independent second opinion, not a refinement of a low-confidence
 * first attempt). If `gemini` is not configured (escalation disabled, or
 * before Phase 9.1B), behavior is unchanged from Phase 9.1A: an
 * `EscalationRequiredError` instead. This is the only place either
 * distinction is made — "is Gemini configured" fully answers "is
 * escalation enabled", so this module never reads config directly.
 *
 * Bounded fan-out invariant (docs/decisions/0002-multi-provider-translation-routing.md,
 * "Bounded fan-out policy"; docs/phase9-provider-plan.md, "Phase 9.1B"):
 * for `workers-ai` mode, at most 2 logical providers are ever called per
 * message — Workers AI alone, or Workers AI then Gemini. Forbidden by
 * design, unconditionally: a Workers AI transient/permanent/malformed
 * failure never reaches Gemini or OpenAI (the failing `provider.translate`
 * call throws before `needsEscalation` is ever read); a Gemini
 * transient/permanent/malformed failure never falls through to OpenAI;
 * `openai` mode never calls Workers AI or Gemini. Each mode calls at
 * most its own bounded provider set, at most once each, every time.
 */

export type TranslationRouterMode = "workers-ai" | "openai";

/** Phase 9.1B: which provider actually produced the final outcome — a safe fixed enum for logging only, never attached to `TranslationOutcome` itself (docs/phase9-provider-plan.md, "Provider metadata"). */
export type TranslationRouterFinalProvider = "workers-ai" | "openai" | "gemini";

export interface TranslationRouterOptions {
  readonly mode: TranslationRouterMode;
  /** Required when mode === "workers-ai"; never called when mode === "openai". */
  readonly workersAi?: TranslationProvider;
  /**
   * Phase 9.1B: the semantic escalation provider, called only when
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
   * configured and Workers AI actually requested escalation. May reject
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
