import { describe, expect, it } from "vitest";

import type { AppConfigInput } from "../../src/config/app-config";
import { validateAppConfig } from "../../src/config/app-config";

const validWorkersAiInput: AppConfigInput = {
  ENVIRONMENT: "development",
  TRANSLATION_PROVIDER: "workers-ai",
  WORKERS_AI_MODEL: "@cf/zai-org/glm-4.7-flash",
  MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096",
  GEMINI_ESCALATION_ENABLED: "false",
};

const validWorkersAiInputWithGeminiEnabled: AppConfigInput = {
  ...validWorkersAiInput,
  GEMINI_ESCALATION_ENABLED: "true",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  MAX_GEMINI_ATTEMPTS_PER_MINUTE: "12",
  MAX_GEMINI_ATTEMPTS_PER_DAY: "450",
};

const validOpenAiInput: AppConfigInput = {
  ENVIRONMENT: "development",
  TRANSLATION_PROVIDER: "openai",
  OPENAI_MODEL: "gpt-4o-mini",
  MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096",
};

describe("validateAppConfig — valid input, workers-ai mode", () => {
  it("accepts a fully valid workers-ai input and normalizes the numeric field", () => {
    const result = validateAppConfig(validWorkersAiInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        environment: "development",
        translationProvider: "workers-ai",
        workersAiModel: "@cf/zai-org/glm-4.7-flash",
        maxTranslatableMessageLength: 4096,
        geminiEscalationEnabled: false,
      });
    }
  });

  it("does not require OPENAI_MODEL in workers-ai mode", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, OPENAI_MODEL: undefined });

    expect(result.ok).toBe(true);
  });

  it("ignores unknown keys rather than erroring on them", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, SOME_UNRELATED_VAR: "whatever" });

    expect(result.ok).toBe(true);
  });
});

describe("validateAppConfig — valid input, openai (legacy) mode", () => {
  it("accepts a fully valid openai input and normalizes the numeric field", () => {
    const result = validateAppConfig(validOpenAiInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        environment: "development",
        translationProvider: "openai",
        openaiModel: "gpt-4o-mini",
        maxTranslatableMessageLength: 4096,
      });
    }
  });

  it("does not require WORKERS_AI_MODEL in openai mode", () => {
    const result = validateAppConfig({ ...validOpenAiInput, WORKERS_AI_MODEL: undefined });

    expect(result.ok).toBe(true);
  });
});

describe("validateAppConfig — ENVIRONMENT", () => {
  it("fails fast when ENVIRONMENT is missing entirely", () => {
    const result = validateAppConfig({
      TRANSLATION_PROVIDER: "workers-ai",
      WORKERS_AI_MODEL: "@cf/zai-org/glm-4.7-flash",
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
    const result = validateAppConfig({ ...validWorkersAiInput, ENVIRONMENT: "" });

    expect(result.ok).toBe(false);
  });

  it("rejects a value outside the development|test|production enum", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, ENVIRONMENT: "staging" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("ENVIRONMENT");
    }
  });
});

describe("validateAppConfig — TRANSLATION_PROVIDER", () => {
  it("fails fast when TRANSLATION_PROVIDER is missing entirely", () => {
    const result = validateAppConfig({
      ENVIRONMENT: "development",
      WORKERS_AI_MODEL: "@cf/zai-org/glm-4.7-flash",
      MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("TRANSLATION_PROVIDER");
    }
  });

  it("rejects an empty string", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, TRANSLATION_PROVIDER: "" });

    expect(result.ok).toBe(false);
  });

  it("rejects a value outside the workers-ai|openai enum", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, TRANSLATION_PROVIDER: "gemini" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("TRANSLATION_PROVIDER");
    }
  });
});

describe("validateAppConfig — WORKERS_AI_MODEL (workers-ai mode only)", () => {
  it("fails fast when WORKERS_AI_MODEL is missing in workers-ai mode", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, WORKERS_AI_MODEL: undefined });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("WORKERS_AI_MODEL");
    }
  });

  it("rejects a blank (whitespace-only) value", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, WORKERS_AI_MODEL: "   " });

    expect(result.ok).toBe(false);
  });

  it.each([
    " @cf/zai-org/glm-4.7-flash",
    "@cf/zai-org/glm-4.7-flash ",
    "\t@cf/zai-org/glm-4.7-flash\n",
  ])(
    "rejects leading or trailing whitespace in %j rather than normalizing it",
    (workersAiModel) => {
      const result = validateAppConfig({
        ...validWorkersAiInput,
        WORKERS_AI_MODEL: workersAiModel,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe("WORKERS_AI_MODEL");
      }
    },
  );
});

describe("validateAppConfig — GEMINI_ESCALATION_ENABLED (workers-ai mode only, Phase 9.1B)", () => {
  it("fails fast when GEMINI_ESCALATION_ENABLED is missing in workers-ai mode", () => {
    const result = validateAppConfig({
      ...validWorkersAiInput,
      GEMINI_ESCALATION_ENABLED: undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("GEMINI_ESCALATION_ENABLED");
    }
  });

  it("rejects an empty string", () => {
    const result = validateAppConfig({ ...validWorkersAiInput, GEMINI_ESCALATION_ENABLED: "" });

    expect(result.ok).toBe(false);
  });

  it.each(["True", "FALSE", "1", "0", "yes", "no", " true", "true "])(
    "rejects %j — only the exact literals 'true'/'false' are accepted (strict boolean parsing)",
    (value) => {
      const result = validateAppConfig({
        ...validWorkersAiInput,
        GEMINI_ESCALATION_ENABLED: value,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe("GEMINI_ESCALATION_ENABLED");
      }
    },
  );

  it("is not required in openai mode", () => {
    const result = validateAppConfig({ ...validOpenAiInput, GEMINI_ESCALATION_ENABLED: undefined });

    expect(result.ok).toBe(true);
  });

  it("does not include a geminiModel/budget field on the config when disabled", () => {
    const result = validateAppConfig(validWorkersAiInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("geminiModel");
      expect(result.value).not.toHaveProperty("maxGeminiAttemptsPerMinute");
      expect(result.value).not.toHaveProperty("maxGeminiAttemptsPerDay");
    }
  });
});

describe("validateAppConfig — GEMINI_MODEL and Gemini budget (workers-ai mode + escalation enabled only)", () => {
  it("accepts a fully valid workers-ai input with escalation enabled", () => {
    const result = validateAppConfig(validWorkersAiInputWithGeminiEnabled);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        environment: "development",
        translationProvider: "workers-ai",
        workersAiModel: "@cf/zai-org/glm-4.7-flash",
        maxTranslatableMessageLength: 4096,
        geminiEscalationEnabled: true,
        geminiModel: "gemini-3.5-flash-lite",
        maxGeminiAttemptsPerMinute: 12,
        maxGeminiAttemptsPerDay: 450,
      });
    }
  });

  it("fails fast when GEMINI_MODEL is missing while escalation is enabled", () => {
    const result = validateAppConfig({
      ...validWorkersAiInputWithGeminiEnabled,
      GEMINI_MODEL: undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("GEMINI_MODEL");
    }
  });

  it("rejects a blank (whitespace-only) GEMINI_MODEL", () => {
    const result = validateAppConfig({
      ...validWorkersAiInputWithGeminiEnabled,
      GEMINI_MODEL: "   ",
    });

    expect(result.ok).toBe(false);
  });

  it.each([" gemini-3.5-flash-lite", "gemini-3.5-flash-lite "])(
    "rejects leading or trailing whitespace in %j rather than normalizing it",
    (geminiModel) => {
      const result = validateAppConfig({
        ...validWorkersAiInputWithGeminiEnabled,
        GEMINI_MODEL: geminiModel,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe("GEMINI_MODEL");
      }
    },
  );

  it("fails fast when MAX_GEMINI_ATTEMPTS_PER_MINUTE is missing while escalation is enabled", () => {
    const result = validateAppConfig({
      ...validWorkersAiInputWithGeminiEnabled,
      MAX_GEMINI_ATTEMPTS_PER_MINUTE: undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("MAX_GEMINI_ATTEMPTS_PER_MINUTE");
    }
  });

  it("rejects a non-positive MAX_GEMINI_ATTEMPTS_PER_MINUTE", () => {
    const result = validateAppConfig({
      ...validWorkersAiInputWithGeminiEnabled,
      MAX_GEMINI_ATTEMPTS_PER_MINUTE: "0",
    });

    expect(result.ok).toBe(false);
  });

  it("fails fast when MAX_GEMINI_ATTEMPTS_PER_DAY is missing while escalation is enabled", () => {
    const result = validateAppConfig({
      ...validWorkersAiInputWithGeminiEnabled,
      MAX_GEMINI_ATTEMPTS_PER_DAY: undefined,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("MAX_GEMINI_ATTEMPTS_PER_DAY");
    }
  });

  it("rejects a non-positive MAX_GEMINI_ATTEMPTS_PER_DAY", () => {
    const result = validateAppConfig({
      ...validWorkersAiInputWithGeminiEnabled,
      MAX_GEMINI_ATTEMPTS_PER_DAY: "-1",
    });

    expect(result.ok).toBe(false);
  });

  it("is never required in openai (legacy) mode, regardless of these vars being present", () => {
    const result = validateAppConfig({
      ...validOpenAiInput,
      GEMINI_ESCALATION_ENABLED: "true",
      GEMINI_MODEL: undefined,
      MAX_GEMINI_ATTEMPTS_PER_MINUTE: undefined,
      MAX_GEMINI_ATTEMPTS_PER_DAY: undefined,
    });

    expect(result.ok).toBe(true);
  });

  it("GEMINI_API_KEY is never part of the returned config, even if present in input", () => {
    const result = validateAppConfig({
      ...validWorkersAiInputWithGeminiEnabled,
      GEMINI_API_KEY: "synthetic-should-never-be-read-or-echoed",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("geminiApiKey");
      expect(result.value).not.toHaveProperty("GEMINI_API_KEY");
      expect(JSON.stringify(result.value)).not.toContain(
        "synthetic-should-never-be-read-or-echoed",
      );
    }
  });
});

describe("validateAppConfig — OPENAI_MODEL (openai mode only)", () => {
  it("fails fast when OPENAI_MODEL is missing in openai mode", () => {
    const result = validateAppConfig({ ...validOpenAiInput, OPENAI_MODEL: undefined });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("OPENAI_MODEL");
    }
  });

  it("rejects a blank (whitespace-only) value", () => {
    const result = validateAppConfig({ ...validOpenAiInput, OPENAI_MODEL: "   " });

    expect(result.ok).toBe(false);
  });

  it.each([" gpt-4o-mini", "gpt-4o-mini ", "\tgpt-4o-mini\n"])(
    "rejects leading or trailing whitespace in %j rather than normalizing it",
    (openaiModel) => {
      const result = validateAppConfig({ ...validOpenAiInput, OPENAI_MODEL: openaiModel });

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
      TRANSLATION_PROVIDER: "workers-ai",
      WORKERS_AI_MODEL: "@cf/zai-org/glm-4.7-flash",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe("MAX_TRANSLATABLE_MESSAGE_LENGTH");
    }
  });

  it("rejects a non-numeric value", () => {
    const result = validateAppConfig({
      ...validWorkersAiInput,
      MAX_TRANSLATABLE_MESSAGE_LENGTH: "abc",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects zero", () => {
    const result = validateAppConfig({
      ...validWorkersAiInput,
      MAX_TRANSLATABLE_MESSAGE_LENGTH: "0",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a negative number", () => {
    const result = validateAppConfig({
      ...validWorkersAiInput,
      MAX_TRANSLATABLE_MESSAGE_LENGTH: "-5",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer (decimal) value", () => {
    const result = validateAppConfig({
      ...validWorkersAiInput,
      MAX_TRANSLATABLE_MESSAGE_LENGTH: "4096.5",
    });

    expect(result.ok).toBe(false);
  });
});
