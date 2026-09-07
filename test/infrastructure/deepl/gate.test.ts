import { describe, expect, it } from "vitest";
import type { TranslationRequest } from "../../../src/domain/translation";
import { selectDeepLRoute } from "../../../src/infrastructure/deepl/gate";

export const clearJapanese = "明日の午後は家族と一緒に公園へ遊びに行きます。";
export const request: TranslationRequest = {
  sourceText: clearJapanese,
  speaker: { id: { telegramUserId: 900000001 }, displayName: "Synthetic", isBot: false },
};

describe("DeepL deterministic preflight", () => {
  it.each([clearJapanese, "今日はスーパーで野菜と果物を買いました。"])(
    "routes clear Japanese to PT-BR: %s",
    (sourceText) => {
      expect(selectDeepLRoute({ ...request, sourceText })).toEqual({
        provider: "deepl",
        targetLanguage: "PT-BR",
      });
    },
  );
  it.each(["Olá, amanhã vamos ao parque!", "Hello world", "na\u0303o", "Ｏｌａ！"])(
    "routes Latin letters to auto-detect: %s",
    (sourceText) => {
      expect(selectDeepLRoute({ ...request, sourceText })).toEqual({
        provider: "deepl",
        targetLanguage: "JA",
      });
    },
  );
  it.each([
    "\u3046\u3093",
    "\u306a\u3093\u3058\u3083\u305d\u308a\u3083",
    "\u4e2d\u6587\u6d88\u606f",
    "\u041f\u0440\u0438\u0432\u0435\u0442",
    "\uc548\ub155\ud558\uc138\uc694",
    "Ol\u00e1 \u4e16\u754c",
  ])("routes ambiguity directly to Gemini: %s", (sourceText) => {
    expect(selectDeepLRoute({ ...request, sourceText }).provider).toBe("gemini");
  });
  it.each(["12345", "123 \ud83d\ude0a", "", "!!!", "www.google.com", "https://example.com/path"])(
    "skips non-translatable input before any provider: %s",
    (sourceText) => {
      expect(selectDeepLRoute({ ...request, sourceText })).toEqual({ provider: "skip" });
    },
  );
  it.each([
    "それでいいよ",
    "こんにちは😊😊😊😊😊😊😊😊😊😊😊😊",
    "明日はMariaと公園に遊びに行きます",
  ])("routes routine Japanese to DeepL: %s", (sourceText) => {
    expect(selectDeepLRoute({ ...request, sourceText })).toEqual({
      provider: "deepl",
      targetLanguage: "PT-BR",
    });
  });
  it("routes clear reply Japanese to DeepL", () => {
    expect(selectDeepLRoute({ ...request, replyContext: { text: "synthetic context" } })).toEqual({
      provider: "deepl",
      targetLanguage: "PT-BR",
    });
  });
  it.each(["tone", "emojiUsage"] as const)("honors explicit %s", (axis) => {
    const memory = {
      tone: { source: "none" as const },
      emojiUsage: { source: "none" as const },
      applicableCorrections: [],
    };
    expect(
      selectDeepLRoute({
        ...request,
        memory: {
          ...memory,
          ...(axis === "tone"
            ? { tone: { source: "explicit", value: "formal" } }
            : { emojiUsage: { source: "explicit", value: "none" } }),
        },
      }),
    ).toEqual({ provider: "gemini", reason: "style-sensitive" });
  });
  it("ignores observed style but honors applicable corrections", () => {
    const memory = {
      tone: { source: "observed" as const, value: "casual" as const },
      emojiUsage: { source: "none" as const },
      applicableCorrections: [],
    };
    expect(selectDeepLRoute({ ...request, memory }).provider).toBe("deepl");
    expect(
      selectDeepLRoute({
        ...request,
        memory: {
          ...memory,
          applicableCorrections: [
            {
              sourceLanguage: "ja",
              targetLanguage: "pt-br",
              sourceTerm: "家族",
              targetTerm: "família",
            },
          ],
        },
      }),
    ).toEqual({ provider: "gemini", reason: "correction-sensitive" });
  });
});
