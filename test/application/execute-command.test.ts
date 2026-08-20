import { describe, expect, it, vi } from "vitest";

import { executeCommand } from "../../src/application/execute-command";
import type {
  CommandCallerProfile,
  CommandExecutionContext,
  CommandReadBoundary,
  CommandReplyBoundary,
  CommandWriteBoundary,
  ExecuteCommandBoundaries,
  SentMessageInfo,
} from "../../src/application/execute-command";
import type { CommandMessage } from "../../src/commands/types";

/**
 * All IDs and message text below are obviously synthetic. All boundaries
 * are mocked, so this suite never reaches D1 or Telegram, and never
 * imports anything OpenAI-related — commands never call OpenAI.
 */

const baseContext: CommandExecutionContext = {
  chatId: -1008700000001,
  userId: 770000001,
  messageId: 630000001,
  chatEnabled: true,
};

function readBoundary(overrides: Partial<CommandReadBoundary> = {}): CommandReadBoundary {
  return {
    getProfile: vi.fn().mockResolvedValue(null),
    getPreferences: vi.fn().mockResolvedValue({}),
    countCorrections: vi.fn().mockResolvedValue(0),
    isAdmin: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function writeBoundary(overrides: Partial<CommandWriteBoundary> = {}): CommandWriteBoundary {
  return {
    upsertPreference: vi.fn().mockResolvedValue(undefined),
    deletePreference: vi.fn().mockResolvedValue(undefined),
    upsertCorrection: vi.fn().mockResolvedValue(undefined),
    deleteCorrection: vi.fn().mockResolvedValue(undefined),
    forgetSpeaker: vi.fn().mockResolvedValue(undefined),
    setChatEnabled: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function replyBoundary(sendMessage: CommandReplyBoundary["sendMessage"]): CommandReplyBoundary {
  return { sendMessage };
}

const sentMessage: SentMessageInfo = { messageId: 630099999, chatId: baseContext.chatId };

function boundaries(
  read: CommandReadBoundary,
  write: CommandWriteBoundary,
  sendMessage: CommandReplyBoundary["sendMessage"],
): ExecuteCommandBoundaries {
  return { read, write, reply: replyBoundary(sendMessage) };
}

describe("executeCommand — /help", () => {
  it("sends the help text and never touches D1", async () => {
    const getProfile = vi.fn().mockResolvedValue(null);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "help" } },
      baseContext,
      boundaries(readBoundary({ getProfile }), writeBoundary(), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getProfile).not.toHaveBeenCalled();
  });
});

describe("executeCommand — unknown command", () => {
  it("replies with an unknown-command message and never touches D1", async () => {
    const upsertPreference = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "unknown-command", name: "bogus" },
      baseContext,
      boundaries(readBoundary(), writeBoundary({ upsertPreference }), sendMessage),
    );

    expect(outcome.kind).toBe("unknown");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(upsertPreference).not.toHaveBeenCalled();
  });
});

describe("executeCommand — usage-error", () => {
  it("replies with the usage message and never touches D1", async () => {
    const upsertPreference = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);
    const message: CommandMessage = { kind: "usage-error", message: "Usage: /remember tone <x>" };

    const outcome = await executeCommand(
      message,
      baseContext,
      boundaries(readBoundary(), writeBoundary({ upsertPreference }), sendMessage),
    );

    expect(outcome.kind).toBe("invalid");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Usage: /remember tone <x>" }),
    );
    expect(upsertPreference).not.toHaveBeenCalled();
  });
});

describe("executeCommand — /status", () => {
  it("resolves explicit-over-observed and reports a correction count only", async () => {
    const getProfile = vi.fn().mockResolvedValue({
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
      observedTone: "casual",
      observedEmojiUsage: "frequent",
    } satisfies CommandCallerProfile);
    const getPreferences = vi.fn().mockResolvedValue({ tone: "formal" });
    const countCorrections = vi.fn().mockResolvedValue(3);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "status" } },
      baseContext,
      boundaries(
        readBoundary({ getProfile, getPreferences, countCorrections }),
        writeBoundary(),
        sendMessage,
      ),
    );

    expect(outcome.kind).toBe("handled");
    const call = sendMessage.mock.calls[0] as [{ text: string }] | undefined;
    if (call === undefined) {
      throw new Error("expected sendMessage to have been called");
    }
    const text = call[0].text;
    expect(text).toContain("Chat: enabled");
    expect(text).toContain("Tone: formal (explicit)");
    expect(text).toContain("Emoji usage: frequent (observed)");
    expect(text).toContain("Stored corrections: 3");
    // Never leaks IDs.
    expect(text).not.toContain(String(baseContext.chatId));
    expect(text).not.toContain(String(baseContext.userId));
  });

  it("shows 'none' sources and reports disabled chat state when nothing is stored", async () => {
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "status" } },
      { ...baseContext, chatEnabled: false },
      boundaries(readBoundary(), writeBoundary(), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    const call = sendMessage.mock.calls[0] as [{ text: string }] | undefined;
    if (call === undefined) {
      throw new Error("expected sendMessage to have been called");
    }
    expect(call[0].text).toContain("Chat: disabled");
    expect(call[0].text).toContain("Tone: unset (none)");
    expect(call[0].text).toContain("Emoji usage: unset (none)");
  });
});

describe("executeCommand — /profile", () => {
  it("reports a safe 'no profile yet' message when no profile row exists", async () => {
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "profile" } },
      baseContext,
      boundaries(readBoundary(), writeBoundary(), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    const call = sendMessage.mock.calls[0] as [{ text: string }] | undefined;
    if (call === undefined) {
      throw new Error("expected sendMessage to have been called");
    }
    expect(call[0].text).toContain("No observed profile yet");
    expect(call[0].text).not.toContain(String(baseContext.chatId));
    expect(call[0].text).not.toContain(String(baseContext.userId));
  });

  it("reports the observed profile fields, explicit preferences, and a correction count", async () => {
    const getProfile = vi.fn().mockResolvedValue({
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
      observedTone: "casual",
      observedEmojiUsage: "none",
    } satisfies CommandCallerProfile);
    const getPreferences = vi.fn().mockResolvedValue({ emojiUsage: "light" });
    const countCorrections = vi.fn().mockResolvedValue(2);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "profile" } },
      baseContext,
      boundaries(
        readBoundary({ getProfile, getPreferences, countCorrections }),
        writeBoundary(),
        sendMessage,
      ),
    );

    expect(outcome.kind).toBe("handled");
    const call = sendMessage.mock.calls[0] as [{ text: string }] | undefined;
    if (call === undefined) {
      throw new Error("expected sendMessage to have been called");
    }
    const text = call[0].text;
    expect(text).toContain("Display name: Synthetic Speaker");
    expect(text).toContain("Observed tone: casual");
    expect(text).toContain("Explicit tone preference: not set");
    expect(text).toContain("Explicit emoji preference: light");
    expect(text).toContain("Stored corrections: 2");
  });
});

describe("executeCommand — /remember", () => {
  it("upserts the preference and confirms", async () => {
    const upsertPreference = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "remember", key: "tone", value: "formal" } },
      baseContext,
      boundaries(readBoundary(), writeBoundary({ upsertPreference }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(upsertPreference).toHaveBeenCalledWith({
      chatId: baseContext.chatId,
      userId: baseContext.userId,
      key: "tone",
      value: "formal",
    });
  });
});

describe("executeCommand — /forget", () => {
  it("deletes a preference and confirms", async () => {
    const deletePreference = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "forget-preference", key: "emoji_usage" } },
      baseContext,
      boundaries(readBoundary(), writeBoundary({ deletePreference }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(deletePreference).toHaveBeenCalledWith({
      chatId: baseContext.chatId,
      userId: baseContext.userId,
      key: "emoji_usage",
    });
  });

  it("deletes a correction and confirms", async () => {
    const deleteCorrection = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      {
        kind: "parsed",
        command: {
          kind: "forget-correction",
          sourceLanguage: "ja",
          targetLanguage: "pt-br",
          sourceTerm: "お母さん",
        },
      },
      baseContext,
      boundaries(readBoundary(), writeBoundary({ deleteCorrection }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(deleteCorrection).toHaveBeenCalledWith({
      chatId: baseContext.chatId,
      userId: baseContext.userId,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "お母さん",
    });
  });
});

describe("executeCommand — /forgetme", () => {
  it("shows confirmation instructions and never mutates when not confirmed", async () => {
    const forgetSpeaker = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "forgetme", confirmed: false } },
      baseContext,
      boundaries(readBoundary(), writeBoundary({ forgetSpeaker }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(forgetSpeaker).not.toHaveBeenCalled();
  });

  it("deletes the caller's data when confirmed", async () => {
    const forgetSpeaker = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "forgetme", confirmed: true } },
      baseContext,
      boundaries(readBoundary(), writeBoundary({ forgetSpeaker }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(forgetSpeaker).toHaveBeenCalledWith(baseContext.chatId, baseContext.userId);
  });
});

describe("executeCommand — /correct", () => {
  it("upserts the correction and confirms", async () => {
    const upsertCorrection = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      {
        kind: "parsed",
        command: {
          kind: "correct",
          sourceLanguage: "ja",
          targetLanguage: "pt-br",
          sourceTerm: "お母さん",
          targetTerm: "mãe",
        },
      },
      baseContext,
      boundaries(readBoundary(), writeBoundary({ upsertCorrection }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(upsertCorrection).toHaveBeenCalledWith({
      chatId: baseContext.chatId,
      userId: baseContext.userId,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "お母さん",
      targetTerm: "mãe",
    });
  });
});

describe("executeCommand — /enable and /disable admin authorization", () => {
  it("denies /enable for a non-admin caller without mutating allowed_chats", async () => {
    const isAdmin = vi.fn().mockResolvedValue(false);
    const setChatEnabled = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "enable" } },
      baseContext,
      boundaries(readBoundary({ isAdmin }), writeBoundary({ setChatEnabled }), sendMessage),
    );

    expect(outcome.kind).toBe("forbidden");
    expect(setChatEnabled).not.toHaveBeenCalled();
  });

  it("denies /disable for a non-admin caller without mutating allowed_chats", async () => {
    const isAdmin = vi.fn().mockResolvedValue(false);
    const setChatEnabled = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "disable" } },
      baseContext,
      boundaries(readBoundary({ isAdmin }), writeBoundary({ setChatEnabled }), sendMessage),
    );

    expect(outcome.kind).toBe("forbidden");
    expect(setChatEnabled).not.toHaveBeenCalled();
  });

  it("allows /enable for an admin caller", async () => {
    const isAdmin = vi.fn().mockResolvedValue(true);
    const setChatEnabled = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "enable" } },
      baseContext,
      boundaries(readBoundary({ isAdmin }), writeBoundary({ setChatEnabled }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(setChatEnabled).toHaveBeenCalledWith(baseContext.chatId, true);
  });

  it("allows /disable for an admin caller", async () => {
    const isAdmin = vi.fn().mockResolvedValue(true);
    const setChatEnabled = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(sentMessage);

    const outcome = await executeCommand(
      { kind: "parsed", command: { kind: "disable" } },
      baseContext,
      boundaries(readBoundary({ isAdmin }), writeBoundary({ setChatEnabled }), sendMessage),
    );

    expect(outcome.kind).toBe("handled");
    expect(setChatEnabled).toHaveBeenCalledWith(baseContext.chatId, false);
  });
});
