import { isChatAllowed } from "../infrastructure/d1/allowed-chats";
import { recordUpdateIfNew } from "../infrastructure/d1/processed-updates";
import { parseTelegramUpdate } from "../infrastructure/telegram/parse-update";
import { isWebhookSecretValid } from "../infrastructure/telegram/webhook-secret";

/**
 * POST /telegram/webhook entry point.
 *
 * Phase 3 scope: verify → parse → dedupe/allowlist gate. No translation,
 * no reply is posted — see docs/implementation-plan.md Phase 3. Order of
 * operations matches docs/security-and-privacy.md and this phase's
 * brief: Secret verification happens before any body read, JSON parse,
 * or D1 access; unsupported updates and the bot's own messages are
 * dropped before any D1 access at all; the allowlist check (a D1 read)
 * happens before the dedupe record (a D1 write), so a non-allowlisted
 * chat's update_id is never recorded.
 */

type WebhookOutcome =
  | "accepted"
  | "ignored:unsupported"
  | "ignored:self"
  | "ignored:not-allowlisted"
  | "ignored:duplicate";

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

function accepted(outcome: WebhookOutcome): Response {
  return jsonResponse({ status: "ok", outcome }, 200);
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // 1. Secret verification — before any body read, JSON parse, or D1 access.
  if (!isWebhookSecretValid(request, env.TELEGRAM_WEBHOOK_SECRET)) {
    return unauthorized();
  }

  // 2. Safe JSON parse.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("MALFORMED_JSON");
  }

  // 3. Convert to the internal type via the existing Phase 1 parser.
  const parsed = parseTelegramUpdate(rawBody);
  if (!parsed.ok) {
    return badRequest("INVALID_UPDATE");
  }

  const update = parsed.value;

  // 4. A normal but out-of-scope update (photo, sticker, channel post, ...).
  if (update.kind === "unsupported") {
    return accepted("ignored:unsupported");
  }

  // 5. The bot's own messages are never processed — prevents a
  //    reply-to-itself loop once Phase 4+ starts posting replies.
  if (update.speaker.isBot) {
    return accepted("ignored:self");
  }

  try {
    // 6. Allowlist check (D1 read) before any dedupe write.
    const allowed = await isChatAllowed(env.DB, update.chatId);
    if (!allowed) {
      return accepted("ignored:not-allowlisted");
    }

    // 7. Atomic dedupe record — false means this update_id was already seen.
    const isNewUpdate = await recordUpdateIfNew(env.DB, update.updateId);
    if (!isNewUpdate) {
      return accepted("ignored:duplicate");
    }

    return accepted("accepted");
  } catch {
    // D1 failure: never report success, never leak the underlying error.
    return internalError();
  }
}
