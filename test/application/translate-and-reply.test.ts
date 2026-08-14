import { describe, expect, it, vi } from "vitest";

import { translateAndReply } from "../../src/application/translate-and-reply";
import type { TranslateAndReplyBoundaries } from "../../src/application/translate-and-reply";
import type { InternalTextMessage } from "../../src/domain/telegram-update";
import { PermanentUpstreamError, TransientUpstreamError } from "../../src/shared/errors";

/**
 * All IDs and message text below are obviously synthetic. Both boundaries
 * are mocked, so this suite never reaches OpenAI or Telegram.
 */

const baseMessage: InternalTextMessage = {
  kind: "text-message",
  updateId: 940000001,
  messageId: 620000001,
  chatId: -1008500000001,
  speaker: { id: { telegramUserId: 760000001 }, displayName: "Synthetic Speaker", isBot: false },
  text: "synthetic test message",
};

function boundaries(
  overrides: Partial<TranslateAndReplyBoundaries> = {},
): TranslateAndReplyBoundaries {
  return {
    translate: { translate: vi.fn() },
    reply: { sendMessage: vi.fn() },
    ...overrides,
  };
}

describe("translateAndReply — translated outcome", () => {
  it("replies with the translated text for a ja source message", async () => {
    const translate = vi.fn().mockResolvedValue({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "mensagem sintética de teste",
    });
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
      kind: "translated",
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
    const translate = vi.fn().mockResolvedValue({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "x",
    });
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
    const translate = vi.fn().mockResolvedValue({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "x",
    });
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
    const translate = vi.fn().mockResolvedValue({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "x",
    });
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
    const translate = vi.fn().mockResolvedValue({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "x",
    });
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
});
