import { parseBootstrapRequest } from "../domain/bootstrap";
import { isSetupSecretValid } from "../infrastructure/admin/setup-secret";
import { bootstrapAdminAndChat } from "../infrastructure/d1/bootstrap";
import { classifyError, logStructuredEvent, type LogFields } from "../shared/structured-log";

/**
 * `POST /admin/bootstrap` — Phase 8A. A production-only, one-time-per-
 * deployment operation, separate from the Telegram webhook flow entirely:
 * it never touches `processed_updates`, the Phase 7 rate/usage counters,
 * or any Telegram/OpenAI boundary, and is authenticated by
 * `SETUP_ADMIN_SECRET` (a distinct Secret from `TELEGRAM_WEBHOOK_SECRET`)
 * rather than a Telegram-signed request. See
 * `src/infrastructure/admin/setup-secret.ts`, `src/domain/bootstrap.ts`,
 * and `src/infrastructure/d1/bootstrap.ts` for the three responsibilities
 * this handler composes, and docs/architecture.md ("Bootstrap endpoint")
 * for why the design is split this way.
 *
 * Order of operations mirrors `src/handlers/telegram-webhook.ts`: Secret
 * verification before any body read or D1 access, then JSON parse, then
 * request-shape validation, then the single atomic D1 mutation. Response
 * bodies are deliberately generic — never a raw D1 error, and never an
 * echo of the submitted `adminUserId`/`chatId`, per
 * docs/security-and-privacy.md.
 */

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function unauthorized(): Response {
  return jsonResponse({ error: { message: "Unauthorized", code: "UNAUTHORIZED" } }, 401);
}

function badRequest(code: string): Response {
  return jsonResponse({ error: { message: "Bad Request", code } }, 400);
}

function internalError(): Response {
  return jsonResponse({ error: { message: "Internal Server Error", code: "INTERNAL_ERROR" } }, 500);
}

function success(): Response {
  return jsonResponse({ status: "ok", result: "bootstrap-complete" }, 200);
}

/** Logs the request's single final outcome, then returns the response unchanged — mirrors telegram-webhook.ts's `finish`. Deliberately never receives `chatId`/`updateId`: this endpoint's log fields never include the submitted adminUserId/chatId (docs/security-and-privacy.md). */
function finish(
  response: Response,
  startedAt: number,
  fields: Omit<LogFields, "status" | "durationMs" | "chatId" | "updateId">,
): Response {
  logStructuredEvent({ ...fields, status: response.status, durationMs: Date.now() - startedAt });
  return response;
}

export async function handleAdminBootstrap(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();

  // 1. Secret verification — before any body read or D1 access.
  if (!isSetupSecretValid(request, env.SETUP_ADMIN_SECRET)) {
    return finish(unauthorized(), startedAt, {
      event: "admin_bootstrap",
      outcome: "unauthorized",
    });
  }

  // 2. Safe JSON parse.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return finish(badRequest("MALFORMED_JSON"), startedAt, {
      event: "admin_bootstrap",
      outcome: "malformed_json",
    });
  }

  // 3. Request-shape validation — pure, no I/O.
  const parsed = parseBootstrapRequest(rawBody);
  if (!parsed.ok) {
    return finish(badRequest("INVALID_BOOTSTRAP_REQUEST"), startedAt, {
      event: "admin_bootstrap",
      outcome: "invalid_request",
    });
  }

  // 4. The single atomic mutation — see src/infrastructure/d1/bootstrap.ts.
  try {
    await bootstrapAdminAndChat(env.DB, parsed.value.adminUserId, parsed.value.chatId);
  } catch (error) {
    return finish(internalError(), startedAt, {
      event: "admin_bootstrap",
      outcome: "internal_error",
      ...classifyError(error),
    });
  }

  return finish(success(), startedAt, {
    event: "admin_bootstrap",
    outcome: "bootstrap-complete",
  });
}
