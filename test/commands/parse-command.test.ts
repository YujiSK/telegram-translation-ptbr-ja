import { describe, expect, it } from "vitest";

import { parseCommandMessage } from "../../src/commands/parse-command";

describe("parseCommandMessage — not a command", () => {
  it("treats plain text as not-a-command", () => {
    expect(parseCommandMessage("こんにちは、元気ですか?")).toEqual({ kind: "not-a-command" });
  });

  it("treats text with leading whitespace before a non-slash character as not-a-command", () => {
    expect(parseCommandMessage("  oi tudo bem")).toEqual({ kind: "not-a-command" });
  });
});

describe("parseCommandMessage — recognized no-argument commands", () => {
  it("parses /help", () => {
    expect(parseCommandMessage("/help")).toEqual({ kind: "parsed", command: { kind: "help" } });
  });

  it("parses /status", () => {
    expect(parseCommandMessage("/status")).toEqual({ kind: "parsed", command: { kind: "status" } });
  });

  it("parses /status@SomeBotName the same as /status", () => {
    expect(parseCommandMessage("/status@SomeBotName")).toEqual({
      kind: "parsed",
      command: { kind: "status" },
    });
  });

  it("parses /profile", () => {
    expect(parseCommandMessage("/profile")).toEqual({
      kind: "parsed",
      command: { kind: "profile" },
    });
  });

  it("parses /enable", () => {
    expect(parseCommandMessage("/enable")).toEqual({ kind: "parsed", command: { kind: "enable" } });
  });

  it("parses /disable", () => {
    expect(parseCommandMessage("/disable")).toEqual({
      kind: "parsed",
      command: { kind: "disable" },
    });
  });

  it("parses /enable@SomeBotName the same as /enable", () => {
    expect(parseCommandMessage("/enable@SomeBotName")).toEqual({
      kind: "parsed",
      command: { kind: "enable" },
    });
  });
});

// Phase 6 review, Issue 2: a no-argument command with a trailing
// argument (e.g. "/status extra") must be a usage-error, not a normal
// invocation with the extra text silently ignored. This matters most for
// "/enable garbage" on a disabled chat — it must never be treated as a
// valid parsed /enable by the webhook's disabled-chat exception.
describe("parseCommandMessage — no-argument commands reject trailing arguments", () => {
  it("rejects /help with a trailing argument", () => {
    expect(parseCommandMessage("/help x")).toEqual({
      kind: "usage-error",
      message: "Usage: /help",
    });
  });

  it("rejects /status with a trailing argument", () => {
    expect(parseCommandMessage("/status x")).toEqual({
      kind: "usage-error",
      message: "Usage: /status",
    });
  });

  it("rejects /profile with a trailing argument", () => {
    expect(parseCommandMessage("/profile x")).toEqual({
      kind: "usage-error",
      message: "Usage: /profile",
    });
  });

  it("rejects /enable with a trailing argument", () => {
    expect(parseCommandMessage("/enable x")).toEqual({
      kind: "usage-error",
      message: "Usage: /enable",
    });
  });

  it("rejects /disable with a trailing argument", () => {
    expect(parseCommandMessage("/disable x")).toEqual({
      kind: "usage-error",
      message: "Usage: /disable",
    });
  });

  it("rejects /enable garbage — never a valid parsed /enable", () => {
    const result = parseCommandMessage("/enable garbage");
    expect(result.kind).toBe("usage-error");
  });

  it("rejects a no-argument command with a trailing argument even with a bot-name suffix", () => {
    expect(parseCommandMessage("/status@SomeBotName extra")).toEqual({
      kind: "usage-error",
      message: "Usage: /status",
    });
  });
});

describe("parseCommandMessage — unknown command", () => {
  it("returns unknown-command for an unrecognized slash command", () => {
    expect(parseCommandMessage("/bogus")).toEqual({ kind: "unknown-command", name: "bogus" });
  });

  it("returns unknown-command for an unrecognized command with a bot-name suffix", () => {
    expect(parseCommandMessage("/bogus@SomeBotName")).toEqual({
      kind: "unknown-command",
      name: "bogus",
    });
  });
});

describe("parseCommandMessage — /remember", () => {
  it("parses /remember tone formal", () => {
    expect(parseCommandMessage("/remember tone formal")).toEqual({
      kind: "parsed",
      command: { kind: "remember", key: "tone", value: "formal" },
    });
  });

  it("parses /remember emoji_usage light", () => {
    expect(parseCommandMessage("/remember emoji_usage light")).toEqual({
      kind: "parsed",
      command: { kind: "remember", key: "emoji_usage", value: "light" },
    });
  });

  it("rejects an invalid tone value with a usage-error", () => {
    const result = parseCommandMessage("/remember tone super-formal");
    expect(result.kind).toBe("usage-error");
  });

  it("rejects an invalid preference key with a usage-error", () => {
    const result = parseCommandMessage("/remember volume loud");
    expect(result.kind).toBe("usage-error");
  });

  it("rejects a missing value with a usage-error", () => {
    const result = parseCommandMessage("/remember tone");
    expect(result.kind).toBe("usage-error");
  });
});

describe("parseCommandMessage — /forget", () => {
  it("parses /forget tone", () => {
    expect(parseCommandMessage("/forget tone")).toEqual({
      kind: "parsed",
      command: { kind: "forget-preference", key: "tone" },
    });
  });

  it("parses /forget emoji_usage", () => {
    expect(parseCommandMessage("/forget emoji_usage")).toEqual({
      kind: "parsed",
      command: { kind: "forget-preference", key: "emoji_usage" },
    });
  });

  it("parses /forget correction ja pt-br <term>", () => {
    expect(parseCommandMessage("/forget correction ja pt-br お母さん")).toEqual({
      kind: "parsed",
      command: {
        kind: "forget-correction",
        sourceLanguage: "ja",
        targetLanguage: "pt-br",
        sourceTerm: "お母さん",
      },
    });
  });

  it("parses /forget correction pt-br ja <term>", () => {
    expect(parseCommandMessage("/forget correction pt-br ja mãe")).toEqual({
      kind: "parsed",
      command: {
        kind: "forget-correction",
        sourceLanguage: "pt-br",
        targetLanguage: "ja",
        sourceTerm: "mãe",
      },
    });
  });

  it("rejects an unrecognized /forget target with a usage-error", () => {
    expect(parseCommandMessage("/forget banana").kind).toBe("usage-error");
  });

  it("rejects a same-language /forget correction direction with a usage-error", () => {
    expect(parseCommandMessage("/forget correction ja ja term").kind).toBe("usage-error");
  });
});

describe("parseCommandMessage — /forgetme", () => {
  it("parses bare /forgetme as unconfirmed", () => {
    expect(parseCommandMessage("/forgetme")).toEqual({
      kind: "parsed",
      command: { kind: "forgetme", confirmed: false },
    });
  });

  it("parses /forgetme confirm as confirmed", () => {
    expect(parseCommandMessage("/forgetme confirm")).toEqual({
      kind: "parsed",
      command: { kind: "forgetme", confirmed: true },
    });
  });

  it("rejects an unrecognized /forgetme argument with a usage-error", () => {
    expect(parseCommandMessage("/forgetme please").kind).toBe("usage-error");
  });
});

describe("parseCommandMessage — /correct", () => {
  it("parses /correct ja pt-br <source> => <target>", () => {
    expect(parseCommandMessage("/correct ja pt-br お母さん => mãe")).toEqual({
      kind: "parsed",
      command: {
        kind: "correct",
        sourceLanguage: "ja",
        targetLanguage: "pt-br",
        sourceTerm: "お母さん",
        targetTerm: "mãe",
      },
    });
  });

  it("parses /correct pt-br ja <source> => <target>", () => {
    expect(parseCommandMessage("/correct pt-br ja mãe => お母さん")).toEqual({
      kind: "parsed",
      command: {
        kind: "correct",
        sourceLanguage: "pt-br",
        targetLanguage: "ja",
        sourceTerm: "mãe",
        targetTerm: "お母さん",
      },
    });
  });

  it("rejects a same-language direction with a usage-error", () => {
    expect(parseCommandMessage("/correct ja ja termo => term").kind).toBe("usage-error");
  });

  it("rejects an 'other' language with a usage-error", () => {
    expect(parseCommandMessage("/correct ja en term => term").kind).toBe("usage-error");
  });

  it("rejects a missing '=>' separator with a usage-error", () => {
    expect(parseCommandMessage("/correct ja pt-br termo mãe").kind).toBe("usage-error");
  });

  it("rejects an empty source term with a usage-error", () => {
    expect(parseCommandMessage("/correct ja pt-br   => mãe").kind).toBe("usage-error");
  });

  it("rejects an empty target term with a usage-error", () => {
    expect(parseCommandMessage("/correct ja pt-br termo => ").kind).toBe("usage-error");
  });

  it("rejects a source term over 100 characters with a usage-error", () => {
    const longTerm = "a".repeat(101);
    expect(parseCommandMessage(`/correct ja pt-br ${longTerm} => mãe`).kind).toBe("usage-error");
  });

  it("rejects a target term over 100 characters with a usage-error", () => {
    const longTerm = "a".repeat(101);
    expect(parseCommandMessage(`/correct ja pt-br termo => ${longTerm}`).kind).toBe("usage-error");
  });

  it("accepts a source term of exactly 100 characters", () => {
    const term = "a".repeat(100);
    const result = parseCommandMessage(`/correct ja pt-br ${term} => mãe`);
    expect(result.kind).toBe("parsed");
  });
});
