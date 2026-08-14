import { validateAppConfig } from "../config/app-config";
import { translateAndReply } from "../application/translate-and-reply";
import { isChatAllowed } from "../infrastructure/d1/allowed-chats";
import { recordUpdateIfNew, releaseProcessedUpdate } from "../infrastructure/d1/processed-updates";
import { sendMessage } from "../infrastructure/telegram/send-message";
import { translateMessage } from "../infrastructure/openai/translate";
import { parseTelegramUpdate } from "../infrastructure/telegram/parse-update";
import { isWebhookSecretValid } from "../infrastructure/telegram/webhook-secret";
import { TransientUpstreamError } from "../shared/errors";

/**
 * POST /telegram/webhook entry point.
 *
 * Order of operations matches docs/security-and-privacy.md and
 * docs/architecture.md: Secret verification happens before any body
 * read, JSON parse, or D1 access; unsupported updates and the bot's own
 * messages are dropped before any D1 access at all; the allowlist check
 * (a D1 read) happens before the dedupe record (a D1 write); the dedupe
 * record happens before the message-length check and the OpenAI/Telegram
 * work, so a redelivered duplicate never re-triggers either — see
 * "Dedupe and retry after a transient failure" in docs/architecture.md
 * for why a transient OpenAI/Telegram failure releases the dedupe
 * reservation but a permanent one does not.
 */

type WebhookOutcome =
  | "translated"
  | "ignored:unsupported"
  | "ignored:self"
  | "ignored:not-allowlisted"
  | "ignored:duplicate"
  | "ignored:too-long"
  | "ignored:untargeted-language";

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

/** Best-effort: release failure must not change the response — the request already failed and needs a 5xx either way. */
async function releaseDedupeReservation(db: D1Database, updateId: number): Promise<void> {
  try {
    await releaseProcessedUpdate(db, updateId);
  } catch {
    // Nothing more to do — the outer caller still returns 500.
  }
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

  // 5. The bot's own messages are never processed — prevents a reply-to-itself loop.
  if (update.speaker.isBot) {
    return accepted("ignored:self");
  }

  let isNewUpdate: boolean;
  try {
    // 6. Allowlist check (D1 read) before any dedupe write.
    const allowed = await isChatAllowed(env.DB, update.chatId);
    if (!allowed) {
      return accepted("ignored:not-allowlisted");
    }

    // 7. Atomic dedupe record — false means this update_id was already seen.
    isNewUpdate = await recordUpdateIfNew(env.DB, update.updateId);
  } catch {
    // D1 failure: never report success, never leak the underlying error.
    return internalError();
  }

  if (!isNewUpdate) {
    return accepted("ignored:duplicate");
  }

  // 8. Non-secret configuration must be valid before any OpenAI call.
  const configResult = validateAppConfig({
    ENVIRONMENT: env.ENVIRONMENT,
    OPENAI_MODEL: env.OPENAI_MODEL,
    MAX_TRANSLATABLE_MESSAGE_LENGTH: env.MAX_TRANSLATABLE_MESSAGE_LENGTH,
  });
  if (!configResult.ok) {
    // Persistent misconfiguration — releasing would not help a retry, so
    // the dedupe row is left in place (see the release policy above).
    return internalError();
  }
  const config = configResult.value;

  // 9. A message longer than the configured ceiling is a normal, safe skip —
  //    never sent to OpenAI, never replied to.
  if (update.text.length > config.maxTranslatableMessageLength) {
    return accepted("ignored:too-long");
  }

  const openaiApiKey = env.OPENAI_API_KEY;
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (
    openaiApiKey === undefined ||
    openaiApiKey === "" ||
    telegramBotToken === undefined ||
    telegramBotToken === ""
  ) {
    // Secrets aren't registered yet (expected before Phase 8) — fail safe,
    // and don't release: this won't succeed on a bare redelivery either.
    return internalError();
  }

  try {
    // 10. The application use case: at most one logical OpenAI call, then
    //     (only on a translated outcome) one Telegram reply.
    const outcome = await translateAndReply(update, {
      translate: {
        translate: (translationRequest) =>
          translateMessage(translationRequest, { apiKey: openaiApiKey, model: config.openaiModel }),
      },
      reply: {
        sendMessage: (params) => sendMessage(params, { botToken: telegramBotToken }),
      },
    });

    if (outcome.kind === "skipped") {
      return accepted("ignored:untargeted-language");
    }
    return accepted("translated");
  } catch (error) {
    if (error instanceof TransientUpstreamError) {
      await releaseDedupeReservation(env.DB, update.updateId);
    }
    // Permanent failures leave the dedupe row in place on purpose: a
    // Telegram redelivery will then be classified as ignored:duplicate
    // instead of repeating the same doomed OpenAI/Telegram call forever.
    return internalError();
  }
}
