/**
 * Machine-distinguishable error hierarchy shared across the codebase.
 *
 * Every error here exposes a stable `code`, a `retryable` flag, and a
 * `publicMessage` safe to log or show. None of these classes accept a
 * raw-payload/Secret field — see docs/project-rules.md rules 9-10 and
 * docs/security-and-privacy.md ("Log minimization").
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "CONFIGURATION_ERROR"
  | "UPSTREAM_TRANSIENT_ERROR"
  | "UPSTREAM_PERMANENT_ERROR"
  | "RATE_LIMIT_EXCEEDED"
  | "USAGE_LIMIT_EXCEEDED"
  | "ESCALATION_REQUIRED";

export type UpstreamService = "telegram" | "openai" | "d1" | "workers-ai" | "gemini";

/**
 * Phase 9.1A: a fixed, closed set of reasons a routine translation
 * provider (Workers AI) may flag a message as needing a stronger model
 * than it can safely handle itself — never free-form model-generated
 * text (docs/security-and-privacy.md, "Log minimization": only a fixed
 * enum reason may ever be logged, never an explanation string). Gemini
 * escalation to Gemini (Phase 9.1B, `src/infrastructure/gemini/`) is
 * attempted only when the router is actually configured with a Gemini
 * boundary — see `src/infrastructure/translation/router.ts`.
 */
export type EscalationReason =
  | "none"
  | "ambiguous-context"
  | "mixed-language"
  | "correction-sensitive"
  | "style-sensitive"
  | "low-confidence";

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;

  protected constructor(publicMessage: string) {
    super(publicMessage);
  }

  /** Safe to log or surface to an operator — never Secrets, message text, or raw payloads. */
  get publicMessage(): string {
    return this.message;
  }
}

/** Invalid input (e.g. a malformed Telegram Update). Never retryable — the same bad input will always fail the same way. */
export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR" as const;
  readonly retryable = false as const;
  readonly field: string | undefined;

  constructor(publicMessage: string, field?: string) {
    super(publicMessage);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** Invalid or missing non-secret configuration. Distinct from ValidationError so config problems (deploy-time) and request problems (runtime) are easy to tell apart in logs/alerts. */
export class ConfigurationError extends AppError {
  readonly code = "CONFIGURATION_ERROR" as const;
  readonly retryable = false as const;
  readonly key: string | undefined;

  constructor(publicMessage: string, key?: string) {
    super(publicMessage);
    this.name = "ConfigurationError";
    this.key = key;
  }
}

/**
 * Base for errors raised while calling an external service (Telegram,
 * OpenAI, D1). Not instantiable directly — use TransientUpstreamError or
 * PermanentUpstreamError so retry behavior is explicit at the call site.
 */
export abstract class UpstreamServiceError extends AppError {
  readonly service: UpstreamService;

  protected constructor(publicMessage: string, service: UpstreamService) {
    super(publicMessage);
    this.service = service;
  }
}

/** A retryable upstream failure (network error, 429, 5xx). Retry policy and caps are the caller's responsibility — see docs/project-rules.md rules 7-8. */
export class TransientUpstreamError extends UpstreamServiceError {
  readonly code = "UPSTREAM_TRANSIENT_ERROR" as const;
  readonly retryable = true as const;

  constructor(publicMessage: string, service: UpstreamService) {
    super(publicMessage, service);
    this.name = "TransientUpstreamError";
  }
}

/** A non-retryable upstream failure (4xx other than 429, a response that fails schema validation, etc.). */
export class PermanentUpstreamError extends UpstreamServiceError {
  readonly code = "UPSTREAM_PERMANENT_ERROR" as const;
  readonly retryable = false as const;

  constructor(publicMessage: string, service: UpstreamService) {
    super(publicMessage, service);
    this.name = "PermanentUpstreamError";
  }
}

/**
 * Phase 7: a safe, expected control-flow signal — the caller (a chat, for
 * inbound updates or OpenAI attempts) has made too many requests within
 * the current rate window. Never an upstream failure and never retried;
 * the webhook responds 200 with a distinct `ignored:rate-limited`
 * outcome and — since `retryable` is false and this is not a
 * `TransientUpstreamError` — keeps the dedupe reservation, so a Telegram
 * redelivery doesn't repeat the same doomed attempt. See
 * docs/architecture.md, "Rate limiting and usage ceiling placement".
 */
export class RateLimitExceededError extends AppError {
  readonly code = "RATE_LIMIT_EXCEEDED" as const;
  readonly retryable = false as const;

  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "RateLimitExceededError";
  }
}

/**
 * Phase 7: a safe, expected control-flow signal — a usage/cost ceiling
 * (the global daily OpenAI attempt budget) has been reached. Distinct
 * from `RateLimitExceededError` so logs and callers can tell "too fast
 * right now" apart from "too much today, come back tomorrow" — the
 * webhook responds 200 with a distinct `ignored:usage-limit` outcome and
 * keeps the dedupe reservation, same reasoning as the rate-limit case.
 */
export class UsageLimitExceededError extends AppError {
  readonly code = "USAGE_LIMIT_EXCEEDED" as const;
  readonly retryable = false as const;

  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "UsageLimitExceededError";
  }
}

/**
 * Phase 9.1A: a safe, expected control-flow signal — the routine
 * (Workers AI) provider determined this specific message needs stronger
 * handling than it can provide (`needsEscalation: true`), and the router
 * has no escalation provider configured to send it to. As of Phase 9.1B
 * this happens when Gemini escalation is disabled (`GEMINI_ESCALATION_ENABLED=false`)
 * or Gemini's config/Secret is missing — see
 * `src/infrastructure/translation/router.ts`; before Phase 9.1B it
 * happened unconditionally, since no escalation provider existed at all.
 * Never an upstream failure — the provider call itself succeeded and
 * returned a structurally valid, cross-field-consistent result; this
 * only means the *router* has nowhere safe to send that result. The
 * webhook responds 200 with a distinct `ignored:escalation-unavailable`
 * outcome and — since this is not a `TransientUpstreamError` — keeps the
 * dedupe reservation: retrying the identical message would just
 * re-derive the same escalation decision, so there is no retry benefit,
 * and keeping the reservation avoids an unbounded Telegram redelivery
 * loop. See docs/architecture.md, "Translation provider router".
 */
export class EscalationRequiredError extends AppError {
  readonly code = "ESCALATION_REQUIRED" as const;
  readonly retryable = false as const;
  readonly escalationReason: EscalationReason;

  constructor(escalationReason: EscalationReason) {
    super(
      `Translation requires escalation (reason: ${escalationReason}), which is not available in this phase`,
    );
    this.name = "EscalationRequiredError";
    this.escalationReason = escalationReason;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Result type for pure functions that validate/parse instead of throwing. */
export type Result<T, E extends AppError = AppError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
