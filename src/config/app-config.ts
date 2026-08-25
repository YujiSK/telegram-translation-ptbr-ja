import { ConfigurationError, type Result } from "../shared/errors";

/**
 * Non-secret configuration only. Secrets (OPENAI_API_KEY,
 * TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SETUP_ADMIN_SECRET) must
 * never be read through this module — see docs/security-and-privacy.md
 * and docs/project-rules.md rule 10.
 *
 * Phase 9.1A: `AppConfig` is a discriminated union on `translationProvider`
 * rather than one shape that always requires `OPENAI_MODEL`. The command
 * path never calls `validateAppConfig` at all (see
 * src/handlers/telegram-webhook.ts and docs/architecture.md, "A command
 * message never invokes an AI provider") — this module only needs to
 * distinguish the two *translation-path* provider modes:
 * `TRANSLATION_PROVIDER=workers-ai` requires `WORKERS_AI_MODEL` and never
 * requires `OPENAI_MODEL`; `TRANSLATION_PROVIDER=openai` (the retained
 * legacy/compatibility path) requires `OPENAI_MODEL` and never requires
 * `WORKERS_AI_MODEL`. `MAX_TRANSLATABLE_MESSAGE_LENGTH` is required in
 * both modes, since the length check runs before either provider is
 * called.
 *
 * This module is a pure validator: it takes a plain string-keyed record
 * (the shape both `process.env`-like sources and a Worker's non-secret
 * `env` vars share) and returns a validated AppConfig or a
 * ConfigurationError.
 */

export type AppConfigInput = Readonly<Record<string, string | undefined>>;

export type AppEnvironment = "development" | "test" | "production";

export type TranslationProviderId = "workers-ai" | "openai";

interface BaseAppConfig {
  readonly environment: AppEnvironment;
  readonly maxTranslatableMessageLength: number;
}

export type AppConfig =
  | (BaseAppConfig & {
      readonly translationProvider: "workers-ai";
      readonly workersAiModel: string;
    })
  | (BaseAppConfig & { readonly translationProvider: "openai"; readonly openaiModel: string });

const APP_ENVIRONMENTS: readonly AppEnvironment[] = ["development", "test", "production"];
const TRANSLATION_PROVIDERS: readonly TranslationProviderId[] = ["workers-ai", "openai"];

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

  if (providerRaw === "workers-ai") {
    const workersAiModel = readModelId(input, "WORKERS_AI_MODEL");
    if (!workersAiModel.ok) {
      return workersAiModel;
    }
    return {
      ok: true,
      value: {
        environment: environmentRaw,
        translationProvider: "workers-ai",
        workersAiModel: workersAiModel.value,
        maxTranslatableMessageLength,
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
