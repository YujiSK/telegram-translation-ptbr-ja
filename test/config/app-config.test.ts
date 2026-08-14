import { describe, expect, it } from "vitest";

import type { AppConfigInput } from "../../src/config/app-config";
import { validateAppConfig } from "../../src/config/app-config";

const validInput: AppConfigInput = {
  ENVIRONMENT: "development",
  OPENAI_MODEL: "gpt-4o-mini",
  MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096",
};

describe("validateAppConfig — valid input", () => {
  it("accepts a fully valid input and normalizes the numeric field", () => {
    const result = validateAppConfig(validInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        environment: "development",
        openaiModel: "gpt-4o-mini",
        maxTranslatableMessageLength: 4096,
      });
    }
  });

  it("ignores unknown keys rather than erroring on them", () => {
    const result = validateAppConfig({ ...validInput, SOME_UNRELATED_VAR: "whatever" });

    expect(result.ok).toBe(true);
  });
});

describe("validateAppConfig — ENVIRONMENT", () => {
  it("fails fast when ENVIRONMENT is missing entirely", () => {
    const result = validateAppConfig({
      OPENAI_MODEL: "gpt-4o-mini",
      MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIGURATION_ERROR");
      expect(result.error.retryable).toBe(false);
      expect(result.error.key).toBe("ENVIRONMENT");
    }
  });

  it("rejects an empty string", () => {
    const result = validateAppConfig({ ...validInput, ENVIRONMENT: "" });

    expect(result.ok).toBe(false);
  });

  it("rejects a value outside the development|test|production enum", () => {
    const result = validateAppConfig({ ...validInput, ENVIRONMENT: "staging" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("ENVIRONMENT");
    }
  });
});

describe("validateAppConfig — OPENAI_MODEL", () => {
  it("fails fast when OPENAI_MODEL is missing entirely", () => {
    const result = validateAppConfig({
      ENVIRONMENT: "development",
      MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("OPENAI_MODEL");
    }
  });

  it("rejects a blank (whitespace-only) value", () => {
    const result = validateAppConfig({ ...validInput, OPENAI_MODEL: "   " });

    expect(result.ok).toBe(false);
  });

  it.each([" gpt-4o-mini", "gpt-4o-mini ", "\tgpt-4o-mini\n"])(
    "rejects leading or trailing whitespace in %j rather than normalizing it",
    (openaiModel) => {
      const result = validateAppConfig({ ...validInput, OPENAI_MODEL: openaiModel });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe("OPENAI_MODEL");
      }
    },
  );
});

describe("validateAppConfig — MAX_TRANSLATABLE_MESSAGE_LENGTH", () => {
  it("fails fast when the value is missing entirely", () => {
    const result = validateAppConfig({
      ENVIRONMENT: "development",
      OPENAI_MODEL: "gpt-4o-mini",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("MAX_TRANSLATABLE_MESSAGE_LENGTH");
    }
  });

  it("rejects a non-numeric value", () => {
    const result = validateAppConfig({ ...validInput, MAX_TRANSLATABLE_MESSAGE_LENGTH: "abc" });

    expect(result.ok).toBe(false);
  });

  it("rejects zero", () => {
    const result = validateAppConfig({ ...validInput, MAX_TRANSLATABLE_MESSAGE_LENGTH: "0" });

    expect(result.ok).toBe(false);
  });

  it("rejects a negative number", () => {
    const result = validateAppConfig({ ...validInput, MAX_TRANSLATABLE_MESSAGE_LENGTH: "-5" });

    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer (decimal) value", () => {
    const result = validateAppConfig({ ...validInput, MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096.5" });

    expect(result.ok).toBe(false);
  });
});
