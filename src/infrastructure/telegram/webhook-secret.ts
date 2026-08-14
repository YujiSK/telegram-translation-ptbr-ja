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
 * Uses the Workers-runtime `crypto.subtle.timingSafeEqual` extension
 * (non-standard, workerd-only) for a constant-time comparison. That
 * function requires both buffers to be the same length and throws
 * otherwise, so a length mismatch is handled by comparing a buffer
 * against itself instead of returning immediately — this keeps that
 * branch's cost similar to the equal-length path rather than exiting
 * early, though it does not claim to hide the length difference itself.
 */

const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.byteLength !== bBytes.byteLength) {
    crypto.subtle.timingSafeEqual(aBytes, aBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

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
