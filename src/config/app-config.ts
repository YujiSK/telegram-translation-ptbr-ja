import { ConfigurationError, type Result } from "../shared/errors";

/**
 * Pure non-secret validation. DeepL needs no model ID; Workers AI rollback
 * and OpenAI legacy require only their own model. DeepL and Workers AI share
 * the optional Gemini switch, model and minute/day budgets. Disabled Gemini
 * requires no model or budgets and sensitive input then fails closed.
 * Secrets are checked directly in webhook wiring, never in this validator.
 * Commands bypass translation configuration entirely.
 */

export type AppConfigInput = Readonly<Record<string, string | undefined>>;

export type AppEnvironment = "development" | "test" | "production";

export type TranslationProviderId = "workers-ai" | "openai" | "deepl";

interface BaseAppConfig {
  readonly environment: AppEnvironment;
  readonly maxTranslatableMessageLength: number;
}

/** Gemini availability and budgets shared by DeepL-first and Workers AI modes. */
export type GeminiEscalationConfig =
  | { readonly geminiEscalationEnabled: false }
  | {
      readonly geminiEscalationEnabled: true;
      readonly geminiModel: string;
      readonly maxGeminiAttemptsPerMinute: number;
      readonly maxGeminiAttemptsPerDay: number;
    };

export type AppConfig =
  | (BaseAppConfig & { readonly translationProvider: "deepl" } & GeminiEscalationConfig)
  | (BaseAppConfig & {
      readonly translationProvider: "workers-ai";
      readonly workersAiModel: string;
    } & GeminiEscalationConfig)
  | (BaseAppConfig & { readonly translationProvider: "openai"; readonly openaiModel: string });

const APP_ENVIRONMENTS: readonly AppEnvironment[] = ["development", "test", "production"];
const TRANSLATION_PROVIDERS: readonly TranslationProviderId[] = ["workers-ai", "openai", "deepl"];

function isAppEnvironment(value: string): value is AppEnvironment {
  return (APP_ENVIRONMENTS as readonly string[]).includes(value);
}

function isTranslationProviderId(value: string): value is TranslationProviderId {
  return (TRANSLATION_PROVIDERS as readonly string[]).includes(value);
}

/** Strict positive-integer parsing: rejects decimals, signs, whitespace, hex, and exponents that `Number()` alone would silently accept. */
function parsePositiveInteger(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function configError(key: string, detail: string): ConfigurationError {
  return new ConfigurationError(`Invalid configuration for "${key}": ${detail}`, key);
}

function fail(key: string, detail: string): Result<AppConfig, ConfigurationError> {
  return { ok: false, error: configError(key, detail) };
}

/** Strict literal `"true"`/`"false"` parsing only — never `Boolean(raw)`-style truthiness, which would silently accept any non-empty string as true. */
function parseStrictBoolean(raw: string): boolean | undefined {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return undefined;
}

/** Shared by OPENAI_MODEL and WORKERS_AI_MODEL: non-empty, no leading/trailing whitespace — never silently normalized. */
function readModelId(input: AppConfigInput, key: string): Result<string, ConfigurationError> {
  const raw = input[key];
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, error: configError(key, "is required") };
  }
  if (raw !== raw.trim()) {
    return { ok: false, error: configError(key, "must not have leading or trailing whitespace") };
  }
  return { ok: true, value: raw };
}

export function validateAppConfig(input: AppConfigInput): Result<AppConfig, ConfigurationError> {
  const environmentRaw = input.ENVIRONMENT;
  if (environmentRaw === undefined || environmentRaw === "") {
    return fail("ENVIRONMENT", "is required");
  }
  if (!isAppEnvironment(environmentRaw)) {
    return fail("ENVIRONMENT", `must be one of: ${APP_ENVIRONMENTS.join(", ")}`);
  }

  const providerRaw = input.TRANSLATION_PROVIDER;
  if (providerRaw === undefined || providerRaw === "") {
    return fail("TRANSLATION_PROVIDER", "is required");
  }
  if (!isTranslationProviderId(providerRaw)) {
    return fail("TRANSLATION_PROVIDER", `must be one of: ${TRANSLATION_PROVIDERS.join(", ")}`);
  }

  const maxLengthRaw = input.MAX_TRANSLATABLE_MESSAGE_LENGTH;
  if (maxLengthRaw === undefined || maxLengthRaw === "") {
    return fail("MAX_TRANSLATABLE_MESSAGE_LENGTH", "is required");
  }
  const maxTranslatableMessageLength = parsePositiveInteger(maxLengthRaw);
  if (maxTranslatableMessageLength === undefined) {
    return fail("MAX_TRANSLATABLE_MESSAGE_LENGTH", "must be a positive integer");
  }

  if (providerRaw === "workers-ai" || providerRaw === "deepl") {
    const workersAiModel =
      providerRaw === "workers-ai"
        ? readModelId(input, "WORKERS_AI_MODEL")
        : { ok: true as const, value: "" };
    if (!workersAiModel.ok) {
      return workersAiModel;
    }

    const escalationEnabledRaw = input.GEMINI_ESCALATION_ENABLED;
    if (escalationEnabledRaw === undefined || escalationEnabledRaw === "") {
      return fail("GEMINI_ESCALATION_ENABLED", "is required");
    }
    const geminiEscalationEnabled = parseStrictBoolean(escalationEnabledRaw);
    if (geminiEscalationEnabled === undefined) {
      return fail("GEMINI_ESCALATION_ENABLED", 'must be exactly "true" or "false"');
    }

    if (!geminiEscalationEnabled) {
      return {
        ok: true,
        value: {
          environment: environmentRaw,
          ...(providerRaw === "workers-ai"
            ? { translationProvider: "workers-ai" as const, workersAiModel: workersAiModel.value }
            : { translationProvider: "deepl" as const }),
          maxTranslatableMessageLength,
          geminiEscalationEnabled: false,
        },
      };
    }

    const geminiModel = readModelId(input, "GEMINI_MODEL");
    if (!geminiModel.ok) {
      return geminiModel;
    }
    const maxGeminiAttemptsPerMinuteRaw = input.MAX_GEMINI_ATTEMPTS_PER_MINUTE;
    if (maxGeminiAttemptsPerMinuteRaw === undefined || maxGeminiAttemptsPerMinuteRaw === "") {
      return fail("MAX_GEMINI_ATTEMPTS_PER_MINUTE", "is required");
    }
    const maxGeminiAttemptsPerMinute = parsePositiveInteger(maxGeminiAttemptsPerMinuteRaw);
    if (maxGeminiAttemptsPerMinute === undefined) {
      return fail("MAX_GEMINI_ATTEMPTS_PER_MINUTE", "must be a positive integer");
    }
    const maxGeminiAttemptsPerDayRaw = input.MAX_GEMINI_ATTEMPTS_PER_DAY;
    if (maxGeminiAttemptsPerDayRaw === undefined || maxGeminiAttemptsPerDayRaw === "") {
      return fail("MAX_GEMINI_ATTEMPTS_PER_DAY", "is required");
    }
    const maxGeminiAttemptsPerDay = parsePositiveInteger(maxGeminiAttemptsPerDayRaw);
    if (maxGeminiAttemptsPerDay === undefined) {
      return fail("MAX_GEMINI_ATTEMPTS_PER_DAY", "must be a positive integer");
    }

    return {
      ok: true,
      value: {
        environment: environmentRaw,
        ...(providerRaw === "workers-ai"
          ? { translationProvider: "workers-ai" as const, workersAiModel: workersAiModel.value }
          : { translationProvider: "deepl" as const }),
        maxTranslatableMessageLength,
        geminiEscalationEnabled: true,
        geminiModel: geminiModel.value,
        maxGeminiAttemptsPerMinute,
        maxGeminiAttemptsPerDay,
      },
    };
  }

  const openaiModel = readModelId(input, "OPENAI_MODEL");
  if (!openaiModel.ok) {
    return openaiModel;
  }
  return {
    ok: true,
    value: {
      environment: environmentRaw,
      translationProvider: "openai",
      openaiModel: openaiModel.value,
      maxTranslatableMessageLength,
    },
  };
}
