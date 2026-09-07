import { describe, expect, it, vi } from "vitest";
import { createDeepLTranslationProvider } from "../../../src/infrastructure/deepl/translate";

const request = {
  sourceText: "明日の午後は家族と一緒に公園へ遊びに行きます。",
  speaker: { id: { telegramUserId: 900000001 }, displayName: "Synthetic", isBot: false },
};
function provider(payload: unknown) {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
  return { fetchFn, adapter: createDeepLTranslationProvider({ apiKey: "synthetic", fetchFn }) };
}
describe("DeepL provider", () => {
  it("converts JA output without inventing observed style", async () => {
    const { adapter } = provider({
      translations: [{ text: "Tradução", detected_source_language: "JA" }],
    });
    expect(await adapter.translate(request)).toEqual({
      needsEscalation: false,
      escalationReason: "none",
      outcome: {
        kind: "translated",
        detectedLanguage: "ja",
        targetLanguage: "pt-br",
        translatedText: "Tradução",
      },
    });
  });
  it("accepts auto-detected PT", async () => {
    const { adapter } = provider({
      translations: [{ text: "翻訳", detected_source_language: "PT" }],
    });
    expect(
      (await adapter.translate({ ...request, sourceText: "Olá mundo" })).outcome,
    ).toMatchObject({ kind: "translated", detectedLanguage: "pt-br", targetLanguage: "ja" });
  });
  it.each(["EN", "ES", "JA", "PT-BR"])(
    "skips auto-detected %s with no escalation",
    async (source) => {
      const { adapter, fetchFn } = provider({
        translations: [{ text: "discard this", detected_source_language: source }],
      });
      expect(await adapter.translate({ ...request, sourceText: "Hello" })).toEqual({
        needsEscalation: false,
        escalationReason: "none",
        outcome: { kind: "skipped", detectedLanguage: "other", reason: "untargeted-language" },
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    null,
    {},
    { translations: [] },
    {
      translations: [
        { text: "x", detected_source_language: "JA" },
        { text: "y", detected_source_language: "JA" },
      ],
    },
    { translations: [null] },
    { translations: [{ text: " ", detected_source_language: "JA" }] },
    { translations: [{ text: 5, detected_source_language: "JA" }] },
    { translations: [{ text: "x" }] },
    { translations: [{ text: "x", detected_source_language: "private body" }] },
    { translations: [{ text: "x", detected_source_language: "PT" }] },
    { translations: [{ text: "x".repeat(4097), detected_source_language: "JA" }] },
  ])("rejects malformed or inconsistent output safely", async (payload) => {
    const { adapter } = provider(payload);
    await expect(adapter.translate(request)).rejects.toMatchObject({
      message: "Invalid DeepL translation",
      service: "deepl",
      retryable: false,
    });
  });
  it("refuses sensitive input before HTTP even when called directly", async () => {
    const { adapter, fetchFn } = provider({});
    await expect(adapter.translate({ ...request, sourceText: "うん" })).rejects.toMatchObject({
      code: "ESCALATION_REQUIRED",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
