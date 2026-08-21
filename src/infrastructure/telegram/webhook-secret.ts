/**
 * Verifies Telegram's webhook Secret header. Per the Telegram Bot API
 * `setWebhook` documentation, when a `secret_token` is configured on the
 * webhook, every request Telegram sends carries it back in the
 * `X-Telegram-Bot-Api-Secret-Token` header (1-256 characters, `A-Z`,
 * `a-z`, `0-9`, `_`, `-`); the receiving server's first job is to check
 * that header before doing anything else. This must run before the
 * request body is read, before JSON parsing, and before any D1 access —
 * see docs/security-and-privacy.md ("Telegram Webhook Secret
 * verification").
 *
 * The constant-time comparison itself lives in
 * `src/shared/secret-compare.ts`, shared with the Phase 8
 * setup/admin-bootstrap Secret check
 * (`src/infrastructure/admin/setup-secret.ts`) — this module only owns
 * the Telegram-specific header name and request shape.
 */

import { timingSafeEqualStrings } from "../../shared/secret-compare";

const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/**
 * Returns whether `request` carries the correct webhook Secret. Never
 * logs, echoes, or throws the header or configured value — an empty or
 * missing `configuredSecret` always fails closed (never authenticates
 * any request).
 */
export function isWebhookSecretValid(
  request: Request,
  configuredSecret: string | undefined,
): boolean {
  if (configuredSecret === undefined || configuredSecret === "") {
    return false;
  }

  const providedSecret = request.headers.get(WEBHOOK_SECRET_HEADER);
  if (providedSecret === null || providedSecret === "") {
    return false;
  }

  return timingSafeEqualStrings(providedSecret, configuredSecret);
}
