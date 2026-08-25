import { describe, expect, it, vi } from "vitest";

import type { TranslateBoundary } from "../../../src/application/translate-and-reply";
import type { SpeakerIdentity } from "../../../src/domain/speaker";
import type { TranslationOutcome, TranslationRequest } from "../../../src/domain/translation";
import { createTranslationRouter } from "../../../src/infrastructure/translation/router";
import type {
  ProviderTranslationCandidate,
  TranslationProvider,
} from "../../../src/infrastructure/translation/provider";
import {
  ConfigurationError,
  EscalationRequiredError,
  RateLimitExceededError,
  TransientUpstreamError,
  PermanentUpstreamError,
} from "../../../src/shared/errors";

const SPEAKER: SpeakerIdentity = {
  id: { telegramUserId: 900000001 },
  displayName: "Test Speaker",
  isBot: false,
};

const REQUEST: TranslationRequest = { sourceText: "こんにちは", speaker: SPEAKER };

const TRANSLATED_OUTCOME: TranslationOutcome = {
  kind: "translated",
  detectedLanguage: "ja",
  targetLanguage: "pt-br",
  translatedText: "synthetic translation",
};

/** Returns both the boundary (for wiring into the router) and the raw mock (for assertions) — asserting on `boundary.translate` directly trips eslint's unbound-method rule. */
function fakeWorkersAiProvider(candidate: ProviderTranslationCandidate) {
  const translate = vi.fn(() => Promise.resolve(candidate));
  const provider: TranslationProvider = { translate };
  return { provider, translate };
}

function fakeOpenAiBoundary(outcome: TranslationOutcome) {
  const translate = vi.fn(() => Promise.resolve(outcome));
  const boundary: TranslateBoundary = { translate };
  return { boundary, translate };
}

describe("createTranslationRouter — workers-ai mode", () => {
  it("calls only the Workers AI provider, never OpenAI", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: false,
      escalationReason: "none",
    });
    const openai = fakeOpenAiBoundary(TRANSLATED_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      openai: openai.boundary,
    });

    await router.translate(REQUEST);

    expect(workersAi.translate).toHaveBeenCalledTimes(1);
    expect(openai.translate).not.toHaveBeenCalled();
  });

  it("returns the domain TranslationOutcome unchanged on a non-escalation candidate", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: false,
      escalationReason: "none",
    });
    const router = createTranslationRouter({ mode: "workers-ai", workersAi: workersAi.provider });

    await expect(router.translate(REQUEST)).resolves.toEqual(TRANSLATED_OUTCOME);
  });

  it("returns a skipped outcome unchanged", async () => {
    const skipped: TranslationOutcome = {
      kind: "skipped",
      detectedLanguage: "other",
      reason: "untargeted-language",
    };
    const workersAi = fakeWorkersAiProvider({
      outcome: skipped,
      needsEscalation: false,
      escalationReason: "none",
    });
    const router = createTranslationRouter({ mode: "workers-ai", workersAi: workersAi.provider });

    await expect(router.translate(REQUEST)).resolves.toEqual(skipped);
  });

  it("throws EscalationRequiredError and never calls OpenAI when needsEscalation is true", async () => {
    const openai = fakeOpenAiBoundary(TRANSLATED_OUTCOME);
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      openai: openai.boundary,
    });

    const error = await router.translate(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EscalationRequiredError);
    expect((error as EscalationRequiredError).escalationReason).toBe("ambiguous-context");
    expect(openai.translate).not.toHaveBeenCalled();
  });

  it("never surfaces the provisional outcome of an escalation-required candidate", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "low-confidence",
    });
    const router = createTranslationRouter({ mode: "workers-ai", workersAi: workersAi.provider });

    await expect(router.translate(REQUEST)).rejects.toBeInstanceOf(EscalationRequiredError);
  });

  it("throws a ConfigurationError if wired to workers-ai mode with no provider supplied", async () => {
    const router = createTranslationRouter({ mode: "workers-ai" });
    await expect(router.translate(REQUEST)).rejects.toBeInstanceOf(ConfigurationError);
  });
});

/**
 * Phase 9.1B: semantic escalation to Gemini. `fakeGeminiBoundary` mirrors
 * `fakeOpenAiBoundary` deliberately — Gemini is wired as a plain
 * `TranslateBoundary`, exactly like the legacy OpenAI path, since it has
 * no escalation concept of its own (only Workers AI, via
 * `ProviderTranslationCandidate`, does).
 */
function fakeGeminiBoundary(outcome: TranslationOutcome) {
  const translate = vi.fn((_request: TranslationRequest) => Promise.resolve(outcome));
  const boundary: TranslateBoundary = { translate };
  return { boundary, translate };
}

const GEMINI_OUTCOME: TranslationOutcome = {
  kind: "translated",
  detectedLanguage: "ja",
  targetLanguage: "pt-br",
  translatedText: "synthetic gemini translation",
};

describe("createTranslationRouter — workers-ai mode, Gemini semantic escalation (Phase 9.1B)", () => {
  it("does not call Gemini when needsEscalation is false", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: false,
      escalationReason: "none",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
    });

    await router.translate(REQUEST);

    expect(gemini.translate).not.toHaveBeenCalled();
  });

  it("calls Gemini exactly once when needsEscalation is true and Gemini is configured", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
    });

    await router.translate(REQUEST);

    expect(gemini.translate).toHaveBeenCalledTimes(1);
  });

  it("passes the original TranslationRequest to Gemini, not the Workers AI provisional outcome/translation", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: {
        kind: "translated",
        detectedLanguage: "ja",
        targetLanguage: "pt-br",
        translatedText: "workers-ai provisional (must not reach Gemini)",
      },
      needsEscalation: true,
      escalationReason: "low-confidence",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
    });

    await router.translate(REQUEST);

    expect(gemini.translate).toHaveBeenCalledWith(REQUEST);
    const callArg = gemini.translate.mock.calls[0]?.[0];
    expect(JSON.stringify(callArg)).not.toContain("workers-ai provisional");
  });

  it("returns Gemini's outcome as the final result", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "mixed-language",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
    });

    await expect(router.translate(REQUEST)).resolves.toEqual(GEMINI_OUTCOME);
  });

  it("never falls back to OpenAI when Gemini handles the escalation", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "style-sensitive",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const openai = fakeOpenAiBoundary(TRANSLATED_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
      openai: openai.boundary,
    });

    await router.translate(REQUEST);

    expect(openai.translate).not.toHaveBeenCalled();
  });

  it("still throws EscalationRequiredError (Phase 9.1A behavior) when Gemini is not configured, even with needsEscalation true", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "correction-sensitive",
    });
    const router = createTranslationRouter({ mode: "workers-ai", workersAi: workersAi.provider });

    await expect(router.translate(REQUEST)).rejects.toBeInstanceOf(EscalationRequiredError);
  });

  it("a Workers AI transient failure never reaches Gemini (zero calls) and propagates unchanged", async () => {
    const failure = new TransientUpstreamError(
      "synthetic workers-ai transient failure",
      "workers-ai",
    );
    const translate = vi.fn(() => Promise.reject(failure));
    const workersAi: TranslationProvider = { translate };
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi,
      gemini: gemini.boundary,
    });

    await expect(router.translate(REQUEST)).rejects.toBe(failure);
    expect(gemini.translate).not.toHaveBeenCalled();
  });

  it("a Workers AI permanent failure never reaches Gemini (zero calls) and propagates unchanged", async () => {
    const failure = new PermanentUpstreamError(
      "synthetic workers-ai permanent failure",
      "workers-ai",
    );
    const translate = vi.fn(() => Promise.reject(failure));
    const workersAi: TranslationProvider = { translate };
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi,
      gemini: gemini.boundary,
    });

    await expect(router.translate(REQUEST)).rejects.toBe(failure);
    expect(gemini.translate).not.toHaveBeenCalled();
  });

  it("a Workers AI malformed-result failure (thrown before a candidate exists) never reaches Gemini", async () => {
    const failure = new PermanentUpstreamError(
      "synthetic malformed workers-ai output",
      "workers-ai",
    );
    const translate = vi.fn(() => Promise.reject(failure));
    const workersAi: TranslationProvider = { translate };
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi,
      gemini: gemini.boundary,
    });

    await expect(router.translate(REQUEST)).rejects.toBe(failure);
    expect(gemini.translate).not.toHaveBeenCalled();
  });

  it("propagates a Gemini transient failure unchanged", async () => {
    const failure = new TransientUpstreamError("synthetic gemini transient failure", "gemini");
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const translate = vi.fn(() => Promise.reject(failure));
    const gemini: TranslateBoundary = { translate };
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini,
    });

    await expect(router.translate(REQUEST)).rejects.toBe(failure);
  });

  it("propagates a Gemini permanent failure unchanged", async () => {
    const failure = new PermanentUpstreamError("synthetic gemini permanent failure", "gemini");
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const translate = vi.fn(() => Promise.reject(failure));
    const gemini: TranslateBoundary = { translate };
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini,
    });

    await expect(router.translate(REQUEST)).rejects.toBe(failure);
  });

  it("calls beforeGeminiAttempt exactly once, immediately before the single Gemini call", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const beforeGeminiAttempt = vi.fn(() => Promise.resolve());
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
      beforeGeminiAttempt,
    });

    await router.translate(REQUEST);

    expect(beforeGeminiAttempt).toHaveBeenCalledTimes(1);
    expect(gemini.translate).toHaveBeenCalledTimes(1);
  });

  it("never calls beforeGeminiAttempt or Gemini when needsEscalation is false", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: false,
      escalationReason: "none",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const beforeGeminiAttempt = vi.fn(() => Promise.resolve());
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
      beforeGeminiAttempt,
    });

    await router.translate(REQUEST);

    expect(beforeGeminiAttempt).not.toHaveBeenCalled();
    expect(gemini.translate).not.toHaveBeenCalled();
  });

  it("never calls Gemini when beforeGeminiAttempt rejects (budget exhausted), and propagates the rejection unchanged", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const budgetError = new RateLimitExceededError("synthetic gemini minute budget exceeded");
    const beforeGeminiAttempt = vi.fn(() => Promise.reject(budgetError));
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
      beforeGeminiAttempt,
    });

    await expect(router.translate(REQUEST)).rejects.toBe(budgetError);
    expect(gemini.translate).not.toHaveBeenCalled();
  });

  it("calls onFinalProviderSelected('workers-ai') on a non-escalation candidate", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: false,
      escalationReason: "none",
    });
    const onFinalProviderSelected = vi.fn();
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      onFinalProviderSelected,
    });

    await router.translate(REQUEST);

    expect(onFinalProviderSelected).toHaveBeenCalledExactlyOnceWith("workers-ai");
  });

  it("calls onFinalProviderSelected('gemini') when Gemini handled the escalation", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const onFinalProviderSelected = vi.fn();
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
      onFinalProviderSelected,
    });

    await router.translate(REQUEST);

    expect(onFinalProviderSelected).toHaveBeenCalledExactlyOnceWith("gemini");
  });

  it("never calls onFinalProviderSelected when the router throws EscalationRequiredError", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const onFinalProviderSelected = vi.fn();
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      onFinalProviderSelected,
    });

    await router.translate(REQUEST).catch(() => undefined);

    expect(onFinalProviderSelected).not.toHaveBeenCalled();
  });

  it("maximum logical providers per message is 2 for workers-ai mode (workers-ai + gemini, never more)", async () => {
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    });
    const gemini = fakeGeminiBoundary(GEMINI_OUTCOME);
    const openai = fakeOpenAiBoundary(TRANSLATED_OUTCOME);
    const router = createTranslationRouter({
      mode: "workers-ai",
      workersAi: workersAi.provider,
      gemini: gemini.boundary,
      openai: openai.boundary,
    });

    await router.translate(REQUEST);

    const totalCalls =
      workersAi.translate.mock.calls.length +
      gemini.translate.mock.calls.length +
      openai.translate.mock.calls.length;
    expect(totalCalls).toBe(2);
  });
});

describe("createTranslationRouter — openai mode", () => {
  it("calls only the OpenAI boundary, never Workers AI", async () => {
    const openai = fakeOpenAiBoundary(TRANSLATED_OUTCOME);
    const workersAi = fakeWorkersAiProvider({
      outcome: TRANSLATED_OUTCOME,
      needsEscalation: false,
      escalationReason: "none",
    });
    const router = createTranslationRouter({
      mode: "openai",
      openai: openai.boundary,
      workersAi: workersAi.provider,
    });

    await router.translate(REQUEST);

    expect(openai.translate).toHaveBeenCalledTimes(1);
    expect(workersAi.translate).not.toHaveBeenCalled();
  });

  it("returns the OpenAI boundary's outcome unchanged", async () => {
    const openai = fakeOpenAiBoundary(TRANSLATED_OUTCOME);
    const router = createTranslationRouter({ mode: "openai", openai: openai.boundary });

    await expect(router.translate(REQUEST)).resolves.toEqual(TRANSLATED_OUTCOME);
  });

  it("propagates a failure thrown by the OpenAI boundary unchanged", async () => {
    const failure = new Error("synthetic openai boundary failure");
    const translate = vi.fn(() => Promise.reject(failure));
    const boundary: TranslateBoundary = { translate };
    const router = createTranslationRouter({ mode: "openai", openai: boundary });

    await expect(router.translate(REQUEST)).rejects.toBe(failure);
  });

  it("throws a ConfigurationError if wired to openai mode with no boundary supplied", async () => {
    const router = createTranslationRouter({ mode: "openai" });
    await expect(router.translate(REQUEST)).rejects.toBeInstanceOf(ConfigurationError);
  });
});
