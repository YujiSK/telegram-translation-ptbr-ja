import { describe, expect, it, vi } from "vitest";

import { translateAndReply } from "../../src/application/translate-and-reply";
import type { TranslateAndReplyBoundaries } from "../../src/application/translate-and-reply";
import type { EffectiveSpeakerMemory } from "../../src/domain/speaker-memory";
import type { InternalTextMessage } from "../../src/domain/telegram-update";
import { PermanentUpstreamError, TransientUpstreamError } from "../../src/shared/errors";

/**
 * All IDs and message text below are obviously synthetic. All four
 * boundaries are mocked, so this suite never reaches D1, OpenAI, or
 * Telegram.
 */

const baseMessage: InternalTextMessage = {
  kind: "text-message",
  updateId: 940000001,
  messageId: 620000001,
  chatId: -1008500000001,
  speaker: { id: { telegramUserId: 760000001 }, displayName: "Synthetic Speaker", isBot: false },
  text: "synthetic test message",
};

const NO_MEMORY: EffectiveSpeakerMemory = {
  tone: { source: "none" },
  emojiUsage: { source: "none" },
  applicableCorrections: [],
};

function boundaries(
  overrides: Partial<TranslateAndReplyBoundaries> = {},
): TranslateAndReplyBoundaries {
  return {
    memoryReader: { readMemory: vi.fn().mockResolvedValue(NO_MEMORY) },
    translate: { translate: vi.fn() },
    reply: { sendMessage: vi.fn() },
    profileWriter: { writeObservedProfile: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

const translatedOutcome = {
  kind: "translated" as const,
  detectedLanguage: "ja" as const,
  targetLanguage: "pt-br" as const,
  translatedText: "mensagem sintética de teste",
  styleSignals: { tone: "casual" as const, emojiUsage: "light" as const },
};

describe("translateAndReply — translated outcome", () => {
  it("replies with the translated text for a ja source message", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ messageId: 620000099, chatId: baseMessage.chatId });

    const outcome = await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, reply: { sendMessage } }),
    );

    expect(outcome).toEqual({
      kind: "translated",
      sentMessage: { messageId: 620000099, chatId: baseMessage.chatId },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: baseMessage.chatId,
      text: "mensagem sintética de teste",
      replyToMessageId: baseMessage.messageId,
    });
  });

  it("replies with the translated text for a pt-br source message", async () => {
    const translate = vi.fn().mockResolvedValue({
      ...translatedOutcome,
      detectedLanguage: "pt-br",
      targetLanguage: "ja",
      translatedText: "合成テストメッセージ",
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ messageId: 620000100, chatId: baseMessage.chatId });

    const outcome = await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, reply: { sendMessage } }),
    );

    expect(outcome.kind).toBe("translated");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "合成テストメッセージ" }),
    );
  });

  it("sends the reply to the correct chat and as a reply to the correct message", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 1, chatId: baseMessage.chatId });

    await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, reply: { sendMessage } }),
    );

    const call = sendMessage.mock.calls[0]?.[0] as { chatId: number; replyToMessageId: number };
    expect(call.chatId).toBe(baseMessage.chatId);
    expect(call.replyToMessageId).toBe(baseMessage.messageId);
  });

  it("passes the reply context through to the translate boundary when present", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 1, chatId: baseMessage.chatId });
    const messageWithReply: InternalTextMessage = {
      ...baseMessage,
      replyContext: { text: "synthetic prior message" },
    };

    await translateAndReply(
      messageWithReply,
      boundaries({ translate: { translate }, reply: { sendMessage } }),
    );

    expect(translate).toHaveBeenCalledWith(
      expect.objectContaining({ replyContext: { text: "synthetic prior message" } }),
    );
  });

  it("calls the translate boundary exactly once per message", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 1, chatId: baseMessage.chatId });

    await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, reply: { sendMessage } }),
    );

    expect(translate).toHaveBeenCalledTimes(1);
  });
});

describe("translateAndReply — skipped outcome", () => {
  it("never calls the reply boundary when the translate boundary reports a skip", async () => {
    const translate = vi.fn().mockResolvedValue({
      kind: "skipped",
      detectedLanguage: "other",
      reason: "untargeted-language",
    });
    const sendMessage = vi.fn();

    const outcome = await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, reply: { sendMessage } }),
    );

    expect(outcome).toEqual({ kind: "skipped", reason: "untargeted-language" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never writes to the observed profile on a skipped outcome", async () => {
    const translate = vi.fn().mockResolvedValue({
      kind: "skipped",
      detectedLanguage: "other",
      reason: "untargeted-language",
    });
    const writeObservedProfile = vi.fn();

    await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, profileWriter: { writeObservedProfile } }),
    );

    expect(writeObservedProfile).not.toHaveBeenCalled();
  });
});

describe("translateAndReply — failures are never treated as success", () => {
  it("propagates a translate-boundary transient failure instead of swallowing it", async () => {
    const translate = vi
      .fn()
      .mockRejectedValue(new TransientUpstreamError("synthetic failure", "openai"));
    const sendMessage = vi.fn();

    await expect(
      translateAndReply(
        baseMessage,
        boundaries({ translate: { translate }, reply: { sendMessage } }),
      ),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("propagates a translate-boundary permanent (malformed-response) failure instead of swallowing it", async () => {
    const translate = vi
      .fn()
      .mockRejectedValue(new PermanentUpstreamError("synthetic malformed response", "openai"));
    const sendMessage = vi.fn();

    await expect(
      translateAndReply(
        baseMessage,
        boundaries({ translate: { translate }, reply: { sendMessage } }),
      ),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("propagates a reply-boundary (Telegram send) failure instead of treating it as success", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new TransientUpstreamError("synthetic failure", "telegram"));

    await expect(
      translateAndReply(
        baseMessage,
        boundaries({ translate: { translate }, reply: { sendMessage } }),
      ),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
  });

  it("propagates a memory-read failure without calling translate or reply", async () => {
    const readMemory = vi.fn().mockRejectedValue(new Error("synthetic D1 failure"));
    const translate = vi.fn();
    const sendMessage = vi.fn();

    await expect(
      translateAndReply(
        baseMessage,
        boundaries({
          memoryReader: { readMemory },
          translate: { translate },
          reply: { sendMessage },
        }),
      ),
    ).rejects.toThrow("synthetic D1 failure");
    expect(translate).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("translateAndReply — speaker memory read path", () => {
  it("translates with no memory when the memory reader resolves to an empty memory", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);

    await translateAndReply(baseMessage, boundaries({ translate: { translate } }));

    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ memory: NO_MEMORY }));
  });

  it("passes an observed-sourced style signal through to the translate boundary", async () => {
    const memory: EffectiveSpeakerMemory = {
      tone: { source: "observed", value: "formal" },
      emojiUsage: { source: "none" },
      applicableCorrections: [],
    };
    const readMemory = vi.fn().mockResolvedValue(memory);
    const translate = vi.fn().mockResolvedValue(translatedOutcome);

    await translateAndReply(
      baseMessage,
      boundaries({ memoryReader: { readMemory }, translate: { translate } }),
    );

    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ memory }));
  });

  it("passes an explicit-sourced style signal through to the translate boundary", async () => {
    const memory: EffectiveSpeakerMemory = {
      tone: { source: "explicit", value: "casual" },
      emojiUsage: { source: "explicit", value: "frequent" },
      applicableCorrections: [],
    };
    const readMemory = vi.fn().mockResolvedValue(memory);
    const translate = vi.fn().mockResolvedValue(translatedOutcome);

    await translateAndReply(
      baseMessage,
      boundaries({ memoryReader: { readMemory }, translate: { translate } }),
    );

    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ memory }));
  });

  it("passes applicable corrections through to the translate boundary", async () => {
    const memory: EffectiveSpeakerMemory = {
      tone: { source: "none" },
      emojiUsage: { source: "none" },
      applicableCorrections: [
        {
          sourceLanguage: "ja",
          targetLanguage: "pt-br",
          sourceTerm: "synthetic-term",
          targetTerm: "termo-sintetico",
        },
      ],
    };
    const readMemory = vi.fn().mockResolvedValue(memory);
    const translate = vi.fn().mockResolvedValue(translatedOutcome);

    await translateAndReply(
      baseMessage,
      boundaries({ memoryReader: { readMemory }, translate: { translate } }),
    );

    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ memory }));
  });

  it("reads memory scoped to the message's chat and speaker", async () => {
    const readMemory = vi.fn().mockResolvedValue(NO_MEMORY);
    const translate = vi.fn().mockResolvedValue(translatedOutcome);

    await translateAndReply(
      baseMessage,
      boundaries({ memoryReader: { readMemory }, translate: { translate } }),
    );

    expect(readMemory).toHaveBeenCalledWith({
      chatId: baseMessage.chatId,
      userId: baseMessage.speaker.id.telegramUserId,
      sourceText: baseMessage.text,
    });
  });
});

describe("translateAndReply — speaker memory write path", () => {
  it("writes the observed profile after a successful translation and reply", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const writeObservedProfile = vi.fn().mockResolvedValue(undefined);

    await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, profileWriter: { writeObservedProfile } }),
    );

    expect(writeObservedProfile).toHaveBeenCalledTimes(1);
    expect(writeObservedProfile).toHaveBeenCalledWith({
      chatId: baseMessage.chatId,
      userId: baseMessage.speaker.id.telegramUserId,
      displayName: baseMessage.speaker.displayName,
      detectedLanguage: translatedOutcome.detectedLanguage,
      styleSignals: translatedOutcome.styleSignals,
    });
  });

  it("writes the observed profile only after the Telegram reply has already succeeded", async () => {
    const callOrder: string[] = [];
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const sendMessage = vi.fn().mockImplementation(() => {
      callOrder.push("reply");
      return Promise.resolve({ messageId: 1, chatId: baseMessage.chatId });
    });
    const writeObservedProfile = vi.fn().mockImplementation(() => {
      callOrder.push("write");
      return Promise.resolve();
    });

    await translateAndReply(
      baseMessage,
      boundaries({
        translate: { translate },
        reply: { sendMessage },
        profileWriter: { writeObservedProfile },
      }),
    );

    expect(callOrder).toEqual(["reply", "write"]);
  });

  it("never writes to the observed profile when styleSignals is absent from a translated outcome", async () => {
    const translate = vi.fn().mockResolvedValue({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "x",
      // styleSignals intentionally omitted — never guess-fill one.
    });
    const writeObservedProfile = vi.fn();

    await translateAndReply(
      baseMessage,
      boundaries({ translate: { translate }, profileWriter: { writeObservedProfile } }),
    );

    expect(writeObservedProfile).not.toHaveBeenCalled();
  });

  it("still reports a translated outcome when the profile write fails (reply already succeeded)", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ messageId: 620000101, chatId: baseMessage.chatId });
    const writeObservedProfile = vi.fn().mockRejectedValue(new Error("synthetic D1 write failure"));

    const outcome = await translateAndReply(
      baseMessage,
      boundaries({
        translate: { translate },
        reply: { sendMessage },
        profileWriter: { writeObservedProfile },
      }),
    );

    expect(outcome).toEqual({
      kind: "translated",
      sentMessage: { messageId: 620000101, chatId: baseMessage.chatId },
    });
  });

  it("never propagates a profile-write failure out of translateAndReply", async () => {
    const translate = vi.fn().mockResolvedValue(translatedOutcome);
    const writeObservedProfile = vi.fn().mockRejectedValue(new Error("synthetic D1 write failure"));

    await expect(
      translateAndReply(
        baseMessage,
        boundaries({ translate: { translate }, profileWriter: { writeObservedProfile } }),
      ),
    ).resolves.toMatchObject({ kind: "translated" });
  });
});
