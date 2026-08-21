import { timingSafeEqualStrings } from "../../shared/secret-compare";

/**
 * Verifies the `POST /admin/bootstrap` request's Secret header
 * (Phase 8A). Deliberately its own module, not a reuse of
 * `src/infrastructure/telegram/webhook-secret.ts` — that module owns the
 * Telegram-specific header name and request shape, and mixing the two
 * responsibilities would make a future change to either check risk
 * breaking the other. A dedicated header — `X-Setup-Admin-Secret` —
 * rather than `Authorization: Bearer` keeps this Secret's request shape
 * unambiguous and independent of any future Authorization-based scheme.
 *
 * Same fail-closed contract as the webhook Secret check: this must run
 * before the request body is read and before any D1 access, an
 * unconfigured/empty `SETUP_ADMIN_SECRET` never authenticates any
 * request, and the header/configured values are never logged, echoed, or
 * included in a thrown error.
 */

const SETUP_ADMIN_SECRET_HEADER = "X-Setup-Admin-Secret";

export function isSetupSecretValid(
  request: Request,
  configuredSecret: string | undefined,
): boolean {
  if (configuredSecret === undefined || configuredSecret === "") {
    return false;
  }

  const providedSecret = request.headers.get(SETUP_ADMIN_SECRET_HEADER);
  if (providedSecret === null || providedSecret === "") {
    return false;
  }

  return timingSafeEqualStrings(providedSecret, configuredSecret);
}
