import { describe, expect, it, vi } from "vitest";

import type { TranslateBoundary } from "../../../src/application/translate-and-reply";
import type { SpeakerIdentity } from "../../../src/domain/speaker";
import type { TranslationOutcome, TranslationRequest } from "../../../src/domain/translation";
import { createTranslationRouter } from "../../../src/infrastructure/translation/router";
import type {
  ProviderTranslationCandidate,
  TranslationProvider,
} from "../../../src/infrastructure/translation/provider";
import { ConfigurationError, EscalationRequiredError } from "../../../src/shared/errors";

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
