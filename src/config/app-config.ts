import { ConfigurationError, type Result } from "../shared/errors";

/**
 * Non-secret configuration only. Secrets (OPENAI_API_KEY,
 * TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SETUP_ADMIN_SECRET) must
 * never be read through this module — see docs/security-and-privacy.md
 * and docs/project-rules.md rule 10.
 *
 * This module is a pure validator: it takes a plain string-keyed record
 * (the shape both `process.env`-like sources and a Worker's non-secret
 * `env` vars share) and returns a validated AppConfig or a
 * ConfigurationError. Wiring it up to a real Cloudflare `env` binding is
 * left to whichever later phase first needs one of these values —
 * `wrangler.jsonc` has no `vars` yet (see docs/project-rules.md,
 * "Compatibility flags" for the same never-add-ahead-of-need policy).
 */

export type AppConfigInput = Readonly<Record<string, string | undefined>>;

export type AppEnvironment = "development" | "test" | "production";

export interface AppConfig {
  readonly environment: AppEnvironment;
  /** Public, non-secret model identifier (e.g. "gpt-4o-mini" — see docs/architecture.md). */
  readonly openaiModel: string;
  readonly maxTranslatableMessageLength: number;
}

const APP_ENVIRONMENTS: readonly AppEnvironment[] = ["development", "test", "production"];

function isAppEnvironment(value: string): value is AppEnvironment {
  return (APP_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Strict positive-integer parsing: rejects decimals, signs, whitespace, hex, and exponents that `Number()` alone would silently accept. */
function parsePositiveInteger(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function fail(key: string, detail: string): Result<AppConfig, ConfigurationError> {
  return {
    ok: false,
    error: new ConfigurationError(`Invalid configuration for "${key}": ${detail}`, key),
  };
}

export function validateAppConfig(input: AppConfigInput): Result<AppConfig, ConfigurationError> {
  const environmentRaw = input.ENVIRONMENT;
  if (environmentRaw === undefined || environmentRaw === "") {
    return fail("ENVIRONMENT", "is required");
  }
  if (!isAppEnvironment(environmentRaw)) {
    return fail("ENVIRONMENT", `must be one of: ${APP_ENVIRONMENTS.join(", ")}`);
  }

  const openaiModelRaw = input.OPENAI_MODEL;
  if (openaiModelRaw === undefined || openaiModelRaw.trim() === "") {
    return fail("OPENAI_MODEL", "is required");
  }
  if (openaiModelRaw !== openaiModelRaw.trim()) {
    return fail("OPENAI_MODEL", "must not have leading or trailing whitespace");
  }

  const maxLengthRaw = input.MAX_TRANSLATABLE_MESSAGE_LENGTH;
  if (maxLengthRaw === undefined || maxLengthRaw === "") {
    return fail("MAX_TRANSLATABLE_MESSAGE_LENGTH", "is required");
  }
  const maxTranslatableMessageLength = parsePositiveInteger(maxLengthRaw);
  if (maxTranslatableMessageLength === undefined) {
    return fail("MAX_TRANSLATABLE_MESSAGE_LENGTH", "must be a positive integer");
  }

  return {
    ok: true,
    value: {
      environment: environmentRaw,
      openaiModel: openaiModelRaw,
      maxTranslatableMessageLength,
    },
  };
}
