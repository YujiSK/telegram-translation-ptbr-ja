import { ConfigurationError, type Result } from "../shared/errors";

/**
 * Phase 7 rate/usage-ceiling configuration — deliberately its own
 * validator, separate from `validateAppConfig` in `app-config.ts`.
 * `validateAppConfig` covers OpenAI *translation* config
 * (`OPENAI_MODEL`, `MAX_TRANSLATABLE_MESSAGE_LENGTH`), which the command
 * path must never depend on (docs/architecture.md, "A command message
 * never invokes OpenAI"). The per-chat inbound handled-update limit
 * here, by contrast, applies to *both* the command and translation
 * paths — see "Command routing and chat state" — so it needs a config
 * surface neither path source-couples to the other's concerns.
 */

export type ReliabilityConfigInput = Readonly<Record<string, string | undefined>>;

export interface ReliabilityConfig {
  readonly maxHandledUpdatesPerChatPerMinute: number;
  readonly maxOpenAiAttemptsPerChatPerMinute: number;
  readonly maxOpenAiAttemptsPerDay: number;
}

/** Strict positive-integer parsing: rejects decimals, signs, whitespace, hex, and exponents that `Number()` alone would silently accept. */
function parsePositiveInteger(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function fail(key: string, detail: string): Result<number, ConfigurationError> {
  return {
    ok: false,
    error: new ConfigurationError(`Invalid configuration for "${key}": ${detail}`, key),
  };
}

function readPositiveInteger(
  input: ReliabilityConfigInput,
  key: string,
): Result<number, ConfigurationError> {
  const raw = input[key];
  if (raw === undefined || raw === "") {
    return fail(key, "is required");
  }
  const value = parsePositiveInteger(raw);
  if (value === undefined) {
    return fail(key, "must be a positive integer");
  }
  return { ok: true, value };
}

export function validateReliabilityConfig(
  input: ReliabilityConfigInput,
): Result<ReliabilityConfig, ConfigurationError> {
  const maxHandledUpdatesPerChatPerMinute = readPositiveInteger(
    input,
    "MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE",
  );
  if (!maxHandledUpdatesPerChatPerMinute.ok) {
    return maxHandledUpdatesPerChatPerMinute;
  }

  const maxOpenAiAttemptsPerChatPerMinute = readPositiveInteger(
    input,
    "MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE",
  );
  if (!maxOpenAiAttemptsPerChatPerMinute.ok) {
    return maxOpenAiAttemptsPerChatPerMinute;
  }

  const maxOpenAiAttemptsPerDay = readPositiveInteger(input, "MAX_OPENAI_ATTEMPTS_PER_DAY");
  if (!maxOpenAiAttemptsPerDay.ok) {
    return maxOpenAiAttemptsPerDay;
  }

  return {
    ok: true,
    value: {
      maxHandledUpdatesPerChatPerMinute: maxHandledUpdatesPerChatPerMinute.value,
      maxOpenAiAttemptsPerChatPerMinute: maxOpenAiAttemptsPerChatPerMinute.value,
      maxOpenAiAttemptsPerDay: maxOpenAiAttemptsPerDay.value,
    },
  };
}
