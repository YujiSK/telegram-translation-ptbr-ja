import { describe, expect, it } from "vitest";

import { parseTelegramUpdate } from "../../../src/infrastructure/telegram/parse-update";

/**
 * All fixtures below use obviously fake, out-of-range-looking IDs and
 * short, generic, synthetic sentences — never a real family message,
 * real chat ID, or real Telegram user ID.
 */

interface FixtureOverrides {
  updateId?: unknown;
  messageId?: unknown;
  chatId?: unknown;
  userId?: unknown;
  isBot?: boolean;
  firstName?: unknown;
  lastName?: string;
  username?: string;
  text?: unknown;
  replyText?: string;
  omitFrom?: boolean;
  omitChatId?: boolean;
}

function buildTextUpdate(overrides: FixtureOverrides = {}): unknown {
  const {
    updateId = 900000001,
    messageId = 500000001,
    chatId = -1001234567890,
    userId = 700000001,
    isBot = false,
    firstName = "Test User",
    lastName,
    username,
    text = "こんにちは、元気ですか?",
    replyText,
    omitFrom = false,
    omitChatId = false,
  } = overrides;

  const chat: Record<string, unknown> = { type: "group" };
  if (!omitChatId) {
    chat.id = chatId;
  }

  const from: Record<string, unknown> = {
    id: userId,
    is_bot: isBot,
    first_name: firstName,
  };
  if (lastName !== undefined) {
    from.last_name = lastName;
  }
  if (username !== undefined) {
    from.username = username;
  }

  const message: Record<string, unknown> = {
    message_id: messageId,
    date: 1700000000,
    chat,
    text,
  };
  if (!omitFrom) {
    message.from = from;
  }
  if (replyText !== undefined) {
    message.reply_to_message = {
      message_id: 500000000,
      date: 1699999999,
      chat,
      text: replyText,
    };
  }

  return { update_id: updateId, message };
}

describe("parseTelegramUpdate — supported text messages", () => {
  it("converts a Japanese text message into the internal type", () => {
    const result = parseTelegramUpdate(
      buildTextUpdate({
        text: "こんにちは、元気ですか?",
        updateId: 900000010,
        messageId: 500000010,
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "text-message") {
      expect(result.value.kind).toBe("text-message");
      expect(result.value.updateId).toBe(900000010);
      expect(result.value.messageId).toBe(500000010);
      expect(result.value.chatId).toBe(-1001234567890);
      expect(result.value.text).toBe("こんにちは、元気ですか?");
      expect(result.value.replyContext).toBeUndefined();
    } else {
      throw new Error("expected a text-message result");
    }
  });

  it("converts a Brazilian Portuguese text message into the internal type", () => {
    const result = parseTelegramUpdate(
      buildTextUpdate({ text: "Oi, tudo bem?", updateId: 900000011, messageId: 500000011 }),
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "text-message") {
      expect(result.value.text).toBe("Oi, tudo bem?");
    } else {
      throw new Error("expected a text-message result");
    }
  });

  it("extracts a single reply-context message when the update is a reply", () => {
    const result = parseTelegramUpdate(
      buildTextUpdate({ text: "はい、元気です!", replyText: "こんにちは、元気ですか?" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "text-message") {
      expect(result.value.replyContext).toEqual({ text: "こんにちは、元気ですか?" });
    } else {
      throw new Error("expected a text-message result");
    }
  });

  it("preserves bot speaker information", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ isBot: true, firstName: "SampleBot" }));

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "text-message") {
      expect(result.value.speaker.isBot).toBe(true);
      expect(result.value.speaker.displayName).toBe("SampleBot");
    } else {
      throw new Error("expected a text-message result");
    }
  });

  it("synthesizes a display name from first and last name", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ firstName: "Taro", lastName: "Test" }));

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "text-message") {
      expect(result.value.speaker.displayName).toBe("Taro Test");
    } else {
      throw new Error("expected a text-message result");
    }
  });
});

describe("parseTelegramUpdate — normal but unsupported updates", () => {
  it.each([
    ["photo", { photo: [{ file_id: "AAA_fake_file_id", width: 100, height: 100 }] }],
    ["sticker", { sticker: { file_id: "BBB_fake_file_id", is_animated: false, is_video: false } }],
    ["voice", { voice: { file_id: "CCC_fake_file_id", duration: 3 } }],
  ])("treats a %s message (no text field) as unsupported: non-text-message", (_label, extra) => {
    const raw = buildTextUpdate() as { update_id: number; message: Record<string, unknown> };
    delete raw.message.text;
    Object.assign(raw.message, extra);

    const result = parseTelegramUpdate(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "unsupported",
        updateId: raw.update_id,
        reason: "non-text-message",
      });
    }
  });

  it("treats an empty-string text as unsupported: empty-text", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ text: "" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ kind: "unsupported", reason: "empty-text" });
    }
  });

  it("treats a whitespace-only text as unsupported: empty-text", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ text: "   \n  " }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ kind: "unsupported", reason: "empty-text" });
    }
  });

  it("treats a channel post as unsupported: channel-post", () => {
    const result = parseTelegramUpdate({
      update_id: 900000020,
      channel_post: {
        message_id: 1,
        date: 1700000000,
        chat: { id: -1009999999999, type: "channel" },
        text: "announcement",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "unsupported",
        updateId: 900000020,
        reason: "channel-post",
      });
    }
  });

  it("treats a callback query as unsupported: callback-query", () => {
    const result = parseTelegramUpdate({
      update_id: 900000021,
      callback_query: {
        id: "fake_callback_id",
        from: { id: 700000002, is_bot: false, first_name: "Test User" },
        data: "some_button",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "unsupported",
        updateId: 900000021,
        reason: "callback-query",
      });
    }
  });

  it("treats an update with no recognized payload as unsupported: unrecognized-update-type", () => {
    const result = parseTelegramUpdate({
      update_id: 900000022,
      poll_answer: {
        poll_id: "fake_poll_id",
        user: { id: 700000003, is_bot: false, first_name: "Test User" },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "unsupported",
        updateId: 900000022,
        reason: "unrecognized-update-type",
      });
    }
  });
});

describe("parseTelegramUpdate — structurally invalid updates", () => {
  it("rejects a payload that is not a JSON object", () => {
    const result = parseTelegramUpdate("not an object");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("rejects an update missing update_id", () => {
    const raw = buildTextUpdate() as { update_id?: unknown; message: unknown };
    delete raw.update_id;

    const result = parseTelegramUpdate(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("update_id");
    }
  });

  it("rejects an update whose update_id is not an integer", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ updateId: 900000001.5 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("update_id");
    }
  });

  it("rejects a message missing chat.id", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ omitChatId: true }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("message.chat.id");
    }
  });

  it("rejects a message whose chat.id is not an integer", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ chatId: "not-a-number" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("message.chat.id");
    }
  });

  it("rejects a message missing from", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ omitFrom: true }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("message.from");
    }
  });

  it("rejects a message whose from.id is not an integer", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ userId: 700000001.5 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("message.from");
    }
  });

  it("rejects a message whose text is not a string", () => {
    const result = parseTelegramUpdate(buildTextUpdate({ text: 12345 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("message.text");
    }
  });
});
