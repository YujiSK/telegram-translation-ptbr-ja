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
  it.each(["うん", "中文消息", "Привет", "안녕하세요", "123 😊", "", "Olá 世界"])(
    "routes ambiguity directly to Gemini: %s",
    (sourceText) => {
      expect(selectDeepLRoute({ ...request, sourceText }).provider).toBe("gemini");
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
