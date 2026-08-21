import { ValidationError, type Result } from "../shared/errors";

/**
 * Phase 8A: the `POST /admin/bootstrap` request contract. Pure parser —
 * raw (`unknown`) JSON in, a validated `BootstrapRequest` or a
 * `ValidationError` out — no D1 access, no network, mirroring
 * `src/infrastructure/telegram/parse-update.ts`'s style. Extra fields on
 * the input object are ignored rather than rejected, matching this
 * codebase's existing config/body-parsing philosophy (e.g.
 * `validateAppConfig`, `validateReliabilityConfig`): only the fields this
 * contract actually reads are validated.
 *
 * `adminUserId` uses the same "positive safe integer" rule
 * `parse-update.ts` applies to a Telegram user ID. `chatId` uses the same
 * "non-zero safe integer" rule `parse-update.ts` applies to a Telegram
 * chat ID — Telegram group chat IDs are negative, so `chatId` is
 * deliberately not constrained to positive.
 */

export interface BootstrapRequest {
  readonly adminUserId: number;
  readonly chatId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readNonZeroId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0
    ? value
    : undefined;
}

function invalidRequest(
  message: string,
  field?: string,
): Result<BootstrapRequest, ValidationError> {
  return { ok: false, error: new ValidationError(message, field) };
}

export function parseBootstrapRequest(input: unknown): Result<BootstrapRequest, ValidationError> {
  if (!isRecord(input)) {
    return invalidRequest("Bootstrap request body must be a JSON object");
  }

  const adminUserId = readPositiveId(input.adminUserId);
  if (adminUserId === undefined) {
    return invalidRequest("adminUserId must be a positive safe integer", "adminUserId");
  }

  const chatId = readNonZeroId(input.chatId);
  if (chatId === undefined) {
    return invalidRequest("chatId must be a non-zero safe integer", "chatId");
  }

  return { ok: true, value: { adminUserId, chatId } };
}
