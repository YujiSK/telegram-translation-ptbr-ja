import { validateAppConfig } from "../config/app-config";
import { parseCommandMessage } from "../commands/parse-command";
import { executeCommand } from "../application/execute-command";
import { translateAndReply } from "../application/translate-and-reply";
import {
  resolveEffectiveSpeakerMemory,
  selectApplicableCorrections,
} from "../domain/speaker-memory";
import { getAllowedChatState, setAllowedChatEnabled } from "../infrastructure/d1/allowed-chats";
import { isBotAdmin } from "../infrastructure/d1/bot-admins";
import { forgetSpeakerData } from "../infrastructure/d1/forget-me";
import { recordUpdateIfNew, releaseProcessedUpdate } from "../infrastructure/d1/processed-updates";
import {
  deleteSpeakerPreference,
  getSpeakerPreferences,
  upsertSpeakerPreference,
} from "../infrastructure/d1/speaker-preferences";
import {
  getSpeakerProfile,
  upsertObservedSpeakerStyle,
} from "../infrastructure/d1/speaker-profiles";
import {
  countTranslationCorrections,
  deleteTranslationCorrection,
  listTranslationCorrections,
  upsertTranslationCorrection,
} from "../infrastructure/d1/translation-corrections";
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
 * messages are dropped before any D1 access at all; the allowed-chat
 * state lookup (a D1 read) happens before the dedupe record (a D1
 * write); the dedupe record happens before any command execution or
 * translation work, so a redelivered duplicate never re-triggers any of
 * it.
 *
 * Phase 6 (commands): command detection is a pure, in-memory parse
 * (`parseCommandMessage`) that runs before the allowed-chat state lookup,
 * because a *known but disabled* chat still routes exactly one command —
 * `/enable` — through to admin authorization, while every other message
 * (command or plain text) from a disabled or unknown chat is dropped.
 * See docs/architecture.md, "Command routing and chat state". A command
 * message never reaches the OpenAI/speaker-memory translation flow below
 * — it is handled entirely by `src/application/execute-command.ts`,
 * which never calls OpenAI and never writes the observed-style columns.
 *
 * Speaker memory (Phase 5, translation path only): read before the
 * OpenAI call, written best-effort after a successful Telegram reply —
 * see src/application/translate-and-reply.ts for the exact ordering and
 * failure policy, and docs/architecture.md for why a memory-write
 * failure never turns an already-sent reply into a 5xx.
 */

type WebhookOutcome =
  | "translated"
  | "ignored:unsupported"
  | "ignored:self"
  | "ignored:not-allowlisted"
  | "ignored:duplicate"
  | "ignored:too-long"
  | "ignored:untargeted-language"
  | "command:handled"
  | "command:unknown"
  | "command:invalid"
  | "command:forbidden";

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

function commandOutcomeToWebhookOutcome(
  kind: "handled" | "unknown" | "invalid" | "forbidden",
): WebhookOutcome {
  switch (kind) {
    case "handled":
      return "command:handled";
    case "unknown":
      return "command:unknown";
    case "invalid":
      return "command:invalid";
    case "forbidden":
      return "command:forbidden";
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

  // 6. Command detection — pure, in-memory, no I/O. Needed before the
  //    allowed-chat check below so a disabled chat's one exception
  //    (`/enable`) can be recognized.
  const commandParse = parseCommandMessage(update.text);
  const isEnableCommand = commandParse.kind === "parsed" && commandParse.command.kind === "enable";

  let chatState: "missing" | "disabled" | "enabled";
  try {
    // 7. Allowed-chat state lookup (D1 read) before any dedupe write.
    chatState = await getAllowedChatState(env.DB, update.chatId);
  } catch {
    // D1 failure: never report success, never leak the underlying error.
    return internalError();
  }

  if (chatState === "missing") {
    return accepted("ignored:not-allowlisted");
  }
  if (chatState === "disabled" && !isEnableCommand) {
    return accepted("ignored:not-allowlisted");
  }

  let isNewUpdate: boolean;
  try {
    // 8. Atomic dedupe record — false means this update_id was already seen.
    isNewUpdate = await recordUpdateIfNew(env.DB, update.updateId);
  } catch {
    return internalError();
  }

  if (!isNewUpdate) {
    return accepted("ignored:duplicate");
  }

  // 9. Command path: never reaches OpenAI config validation, the
  //    translatable-message length check, speaker-memory reads, or the
  //    OpenAI call below — see the module-level comment.
  if (commandParse.kind !== "not-a-command") {
    const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
    if (telegramBotToken === undefined || telegramBotToken === "") {
      // Command replies still need Telegram — fail safe, don't release:
      // this won't succeed on a bare redelivery either.
      return internalError();
    }

    try {
      const result = await executeCommand(
        commandParse,
        {
          chatId: update.chatId,
          userId: update.speaker.id.telegramUserId,
          messageId: update.messageId,
          chatEnabled: chatState === "enabled",
        },
        {
          read: {
            getProfile: async (chatId, userId) => {
              const profile = await getSpeakerProfile(env.DB, chatId, userId);
              return profile === null
                ? null
                : {
                    displayName: profile.displayName,
                    primaryLanguage: profile.primaryLanguage,
                    observedTone: profile.observedTone,
                    observedEmojiUsage: profile.observedEmojiUsage,
                  };
            },
            getPreferences: (chatId, userId) => getSpeakerPreferences(env.DB, chatId, userId),
            countCorrections: (chatId, userId) =>
              countTranslationCorrections(env.DB, chatId, userId),
            isAdmin: (userId) => isBotAdmin(env.DB, userId),
          },
          write: {
            upsertPreference: (params) =>
              upsertSpeakerPreference(env.DB, {
                chatId: params.chatId,
                userId: params.userId,
                key: params.key,
                value: params.value,
              }),
            deletePreference: (params) =>
              deleteSpeakerPreference(env.DB, params.chatId, params.userId, params.key),
            upsertCorrection: (params) =>
              upsertTranslationCorrection(env.DB, {
                chatId: params.chatId,
                userId: params.userId,
                sourceLanguage: params.sourceLanguage,
                targetLanguage: params.targetLanguage,
                sourceTerm: params.sourceTerm,
                targetTerm: params.targetTerm,
              }),
            deleteCorrection: (params) =>
              deleteTranslationCorrection(
                env.DB,
                params.chatId,
                params.userId,
                params.sourceLanguage,
                params.targetLanguage,
                params.sourceTerm,
              ),
            forgetSpeaker: (chatId, userId) => forgetSpeakerData(env.DB, chatId, userId),
            setChatEnabled: (chatId, enabled) => setAllowedChatEnabled(env.DB, chatId, enabled),
          },
          reply: {
            sendMessage: (params) => sendMessage(params, { botToken: telegramBotToken }),
          },
        },
      );
      return accepted(commandOutcomeToWebhookOutcome(result.kind));
    } catch (error) {
      if (error instanceof TransientUpstreamError) {
        await releaseDedupeReservation(env.DB, update.updateId);
      }
      // Permanent failures leave the dedupe row in place on purpose — see
      // the translation-path catch block below for the same reasoning.
      return internalError();
    }
  }

  // 10. Non-secret configuration must be valid before any OpenAI call.
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

  // 11. A message longer than the configured ceiling is a normal, safe skip —
  //     never sent to OpenAI, never replied to.
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
    // 12-15. The application use case: read speaker memory, at most one
    //        logical OpenAI call, then (only on a translated outcome) one
    //        Telegram reply and a best-effort observed-profile write.
    const outcome = await translateAndReply(update, {
      memoryReader: {
        readMemory: async ({ chatId, userId, sourceText }) => {
          const [profile, explicit, corrections] = await Promise.all([
            getSpeakerProfile(env.DB, chatId, userId),
            getSpeakerPreferences(env.DB, chatId, userId),
            listTranslationCorrections(env.DB, chatId, userId),
          ]);
          return resolveEffectiveSpeakerMemory({
            observed: {
              ...(profile?.observedTone != null ? { tone: profile.observedTone } : {}),
              ...(profile?.observedEmojiUsage != null
                ? { emojiUsage: profile.observedEmojiUsage }
                : {}),
            },
            explicit,
            corrections: selectApplicableCorrections(corrections, sourceText),
          });
        },
      },
      translate: {
        translate: (translationRequest) =>
          translateMessage(translationRequest, { apiKey: openaiApiKey, model: config.openaiModel }),
      },
      reply: {
        sendMessage: (params) => sendMessage(params, { botToken: telegramBotToken }),
      },
      profileWriter: {
        writeObservedProfile: (params) =>
          upsertObservedSpeakerStyle(env.DB, {
            chatId: params.chatId,
            userId: params.userId,
            displayName: params.displayName,
            primaryLanguage: params.detectedLanguage,
            observedTone: params.styleSignals.tone,
            observedEmojiUsage: params.styleSignals.emojiUsage,
          }),
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
