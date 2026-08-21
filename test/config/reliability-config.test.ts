import { describe, expect, it } from "vitest";

import type { ReliabilityConfigInput } from "../../src/config/reliability-config";
import { validateReliabilityConfig } from "../../src/config/reliability-config";

const validInput: ReliabilityConfigInput = {
  MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "60",
  MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE: "20",
  MAX_OPENAI_ATTEMPTS_PER_DAY: "300",
};

describe("validateReliabilityConfig — valid input", () => {
  it("accepts a fully valid input and normalizes each numeric field", () => {
    const result = validateReliabilityConfig(validInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        maxHandledUpdatesPerChatPerMinute: 60,
        maxOpenAiAttemptsPerChatPerMinute: 20,
        maxOpenAiAttemptsPerDay: 300,
      });
    }
  });

  it("ignores unknown keys rather than erroring on them", () => {
    const result = validateReliabilityConfig({ ...validInput, SOME_UNRELATED_VAR: "whatever" });

    expect(result.ok).toBe(true);
  });

  it("does not require OPENAI_MODEL or MAX_TRANSLATABLE_MESSAGE_LENGTH — command path independence", () => {
    // This validator must never depend on OpenAI translation config, so a
    // command-path caller can validate reliability config without ever
    // touching OpenAI-specific vars.
    const result = validateReliabilityConfig(validInput);
    expect(result.ok).toBe(true);
  });
});

describe.each([
  ["MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE"],
  ["MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE"],
  ["MAX_OPENAI_ATTEMPTS_PER_DAY"],
] as const)("validateReliabilityConfig — %s", (key) => {
  it("fails fast when missing entirely", () => {
    const input = { ...validInput };
    delete (input as Record<string, string | undefined>)[key];

    const result = validateReliabilityConfig(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIGURATION_ERROR");
      expect(result.error.retryable).toBe(false);
      expect(result.error.key).toBe(key);
    }
  });

  it("rejects an empty string", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric value", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: "abc" });
    expect(result.ok).toBe(false);
  });

  it("rejects zero", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: "0" });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative number", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: "-5" });
    expect(result.ok).toBe(false);
  });

  it("rejects a decimal value", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: "1.5" });
    expect(result.ok).toBe(false);
  });

  it("rejects whitespace around an otherwise-valid value", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: " 60 " });
    expect(result.ok).toBe(false);
  });

  it("rejects a hex-shaped value", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: "0x3c" });
    expect(result.ok).toBe(false);
  });

  it("rejects an exponent-shaped value", () => {
    const result = validateReliabilityConfig({ ...validInput, [key]: "6e1" });
    expect(result.ok).toBe(false);
  });
});
