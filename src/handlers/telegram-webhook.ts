import { validateAppConfig } from "../config/app-config";
import { validateReliabilityConfig } from "../config/reliability-config";
import { parseCommandMessage } from "../commands/parse-command";
import { executeCommand } from "../application/execute-command";
import { translateAndReply, type TranslateBoundary } from "../application/translate-and-reply";
import {
  resolveEffectiveSpeakerMemory,
  selectApplicableCorrections,
} from "../domain/speaker-memory";
import { getAllowedChatState, setAllowedChatEnabled } from "../infrastructure/d1/allowed-chats";
import { isBotAdmin } from "../infrastructure/d1/bot-admins";
import { forgetSpeakerData } from "../infrastructure/d1/forget-me";
import { recordUpdateIfNew, releaseProcessedUpdate } from "../infrastructure/d1/processed-updates";
import {
  consumeChatHandledUpdateLimit,
  consumeChatOpenAiAttemptLimit,
  consumeDailyOpenAiAttemptLimit,
} from "../infrastructure/d1/reliability-counters";
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
import { createTranslationRouter } from "../infrastructure/translation/router";
import { createWorkersAiTranslationProvider } from "../infrastructure/workers-ai/translate";
import { parseTelegramUpdate } from "../infrastructure/telegram/parse-update";
import { isWebhookSecretValid } from "../infrastructure/telegram/webhook-secret";
import {
  EscalationRequiredError,
  RateLimitExceededError,
  TransientUpstreamError,
  UsageLimitExceededError,
} from "../shared/errors";
import { classifyError, logStructuredEvent, type LogFields } from "../shared/structured-log";
import { minuteWindowId, utcDayId } from "../shared/time-windows";

/**
 * POST /telegram/webhook entry point.
 *
 * Order of operations matches docs/security-and-privacy.md and
 * docs/architecture.md: Secret verification happens before any body
 * read, JSON parse, or D1 access; unsupported updates and the bot's own
 * messages are dropped before any D1 access at all; the allowed-chat
 * state lookup (a D1 read) happens before the dedupe record (a D1
 * write); the dedupe record happens before the per-chat inbound
 * handled-update rate limit (Phase 7) and any command execution or
 * translation work, so a redelivered duplicate never re-triggers any of
 * it, and never double-consumes the rate budget either.
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
 * Phase 7: a per-chat inbound handled-update limit applies to both the
 * command and translation paths; a per-chat OpenAI attempt burst limit
 * and a global daily OpenAI attempt ceiling apply only within the
 * translation path's OpenAI call. See docs/architecture.md, "Rate
 * limiting and usage ceiling placement". Every final outcome is
 * structured-logged (`src/shared/structured-log.ts`) — never message
 * text, prompts, raw responses, or Secrets.
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
  | "ignored:rate-limited"
  | "ignored:usage-limit"
  | "ignored:escalation-unavailable"
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

/** Logs the request's single final outcome, then returns the response unchanged — see the module doc comment for why this is the only place `logStructuredEvent` is called. */
function finish(
  response: Response,
  startedAt: number,
  fields: Omit<LogFields, "status" | "durationMs">,
): Response {
  logStructuredEvent({ ...fields, status: response.status, durationMs: Date.now() - startedAt });
  return response;
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
  const startedAt = Date.now();

  // 1. Secret verification — before any body read, JSON parse, or D1 access.
  if (!isWebhookSecretValid(request, env.TELEGRAM_WEBHOOK_SECRET)) {
    return finish(unauthorized(), startedAt, {
      event: "telegram_webhook",
      outcome: "unauthorized",
    });
  }

  // 2. Safe JSON parse.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return finish(badRequest("MALFORMED_JSON"), startedAt, {
      event: "telegram_webhook",
      outcome: "malformed_json",
    });
  }

  // 3. Convert to the internal type via the existing Phase 1 parser.
  const parsed = parseTelegramUpdate(rawBody);
  if (!parsed.ok) {
    return finish(badRequest("INVALID_UPDATE"), startedAt, {
      event: "telegram_webhook",
      outcome: "invalid_update",
    });
  }

  const update = parsed.value;

  // 4. A normal but out-of-scope update (photo, sticker, channel post, ...).
  if (update.kind === "unsupported") {
    return finish(accepted("ignored:unsupported"), startedAt, {
      event: "telegram_webhook",
      outcome: "ignored:unsupported",
      updateId: update.updateId,
    });
  }

  // 5. The bot's own messages are never processed — prevents a reply-to-itself loop.
  if (update.speaker.isBot) {
    return finish(accepted("ignored:self"), startedAt, {
      event: "telegram_webhook",
      outcome: "ignored:self",
      updateId: update.updateId,
      chatId: update.chatId,
    });
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
  } catch (error) {
    // D1 failure: never report success, never leak the underlying error.
    return finish(internalError(), startedAt, {
      event: "telegram_webhook",
      outcome: "internal_error",
      updateId: update.updateId,
      chatId: update.chatId,
      ...classifyError(error),
    });
  }

  if (chatState === "missing" || (chatState === "disabled" && !isEnableCommand)) {
    return finish(accepted("ignored:not-allowlisted"), startedAt, {
      event: "telegram_webhook",
      outcome: "ignored:not-allowlisted",
      updateId: update.updateId,
      chatId: update.chatId,
    });
  }

  let isNewUpdate: boolean;
  try {
    // 8. Atomic dedupe record — false means this update_id was already seen.
    isNewUpdate = await recordUpdateIfNew(env.DB, update.updateId);
  } catch (error) {
    return finish(internalError(), startedAt, {
      event: "telegram_webhook",
      outcome: "internal_error",
      updateId: update.updateId,
      chatId: update.chatId,
      ...classifyError(error),
    });
  }

  if (!isNewUpdate) {
    return finish(accepted("ignored:duplicate"), startedAt, {
      event: "telegram_webhook",
      outcome: "ignored:duplicate",
      updateId: update.updateId,
      chatId: update.chatId,
    });
  }

  // 9. Rate/usage config, validated once here (after dedupe, same
  //    reasoning as the translation-only config below: a misconfiguration
  //    won't be fixed by a retry, so the dedupe row is left in place).
  //    Applies to both the command and translation paths for the inbound
  //    limit; only the translation path additionally uses the OpenAI
  //    attempt limits, further below.
  const reliabilityConfigResult = validateReliabilityConfig({
    MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: env.MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE,
    MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE: env.MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE,
    MAX_OPENAI_ATTEMPTS_PER_DAY: env.MAX_OPENAI_ATTEMPTS_PER_DAY,
  });
  if (!reliabilityConfigResult.ok) {
    return finish(internalError(), startedAt, {
      event: "telegram_webhook",
      outcome: "internal_error",
      updateId: update.updateId,
      chatId: update.chatId,
      ...classifyError(reliabilityConfigResult.error),
    });
  }
  const reliabilityConfig = reliabilityConfigResult.value;

  // 9b. Per-chat inbound handled-update rate limit — after the dedupe
  //     reservation (so a redelivery of the same update never
  //     double-consumes the budget), before any command/translation work.
  let handledUpdateAllowed: boolean;
  try {
    handledUpdateAllowed = await consumeChatHandledUpdateLimit(
      env.DB,
      update.chatId,
      minuteWindowId(Date.now()),
      reliabilityConfig.maxHandledUpdatesPerChatPerMinute,
    );
  } catch (error) {
    if (error instanceof TransientUpstreamError) {
      await releaseDedupeReservation(env.DB, update.updateId);
    }
    return finish(internalError(), startedAt, {
      event: "telegram_webhook",
      outcome: "internal_error",
      updateId: update.updateId,
      chatId: update.chatId,
      ...classifyError(error),
    });
  }
  if (!handledUpdateAllowed) {
    // Dedupe reservation is deliberately KEPT (not released): the
    // reservation already exists, and releasing it would let a Telegram
    // redelivery re-consume/re-check the same budget for what is, from
    // the bot's perspective, the same inbound event.
    return finish(accepted("ignored:rate-limited"), startedAt, {
      event: "telegram_webhook",
      outcome: "ignored:rate-limited",
      updateId: update.updateId,
      chatId: update.chatId,
      limitType: "chat-updates",
    });
  }

  // 10. Command path: never reaches OpenAI config validation, the
  //     translatable-message length check, speaker-memory reads, or the
  //     OpenAI call below — see the module-level comment.
  if (commandParse.kind !== "not-a-command") {
    const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
    if (telegramBotToken === undefined || telegramBotToken === "") {
      // Command replies still need Telegram — fail safe, don't release:
      // this won't succeed on a bare redelivery either.
      return finish(internalError(), startedAt, {
        event: "telegram_webhook",
        outcome: "internal_error",
        updateId: update.updateId,
        chatId: update.chatId,
      });
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
      const outcome = commandOutcomeToWebhookOutcome(result.kind);
      return finish(accepted(outcome), startedAt, {
        event: "telegram_webhook",
        outcome,
        updateId: update.updateId,
        chatId: update.chatId,
      });
    } catch (error) {
      if (error instanceof TransientUpstreamError) {
        await releaseDedupeReservation(env.DB, update.updateId);
      }
      // Permanent failures leave the dedupe row in place on purpose — see
      // the translation-path catch block below for the same reasoning.
      return finish(internalError(), startedAt, {
        event: "telegram_webhook",
        outcome: "internal_error",
        updateId: update.updateId,
        chatId: update.chatId,
        ...classifyError(error),
      });
    }
  }

  // 11. Non-secret configuration must be valid before any provider call.
  //     Phase 9.1A: which provider fields are required depends on
  //     TRANSLATION_PROVIDER — see src/config/app-config.ts.
  const configResult = validateAppConfig({
    ENVIRONMENT: env.ENVIRONMENT,
    TRANSLATION_PROVIDER: env.TRANSLATION_PROVIDER,
    WORKERS_AI_MODEL: env.WORKERS_AI_MODEL,
    OPENAI_MODEL: env.OPENAI_MODEL,
    MAX_TRANSLATABLE_MESSAGE_LENGTH: env.MAX_TRANSLATABLE_MESSAGE_LENGTH,
  });
  if (!configResult.ok) {
    // Persistent misconfiguration — releasing would not help a retry, so
    // the dedupe row is left in place (see the release policy above).
    return finish(internalError(), startedAt, {
      event: "telegram_webhook",
      outcome: "internal_error",
      updateId: update.updateId,
      chatId: update.chatId,
      ...classifyError(configResult.error),
    });
  }
  const config = configResult.value;

  // 12. A message longer than the configured ceiling is a normal, safe skip —
  //     never sent to OpenAI, never replied to.
  if (update.text.length > config.maxTranslatableMessageLength) {
    return finish(accepted("ignored:too-long"), startedAt, {
      event: "telegram_webhook",
      outcome: "ignored:too-long",
      updateId: update.updateId,
      chatId: update.chatId,
    });
  }

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (telegramBotToken === undefined || telegramBotToken === "") {
    // Secret isn't registered yet — fail safe, and don't release: this
    // won't succeed on a bare redelivery either. Required regardless of
    // translation provider, since both reply via Telegram.
    return finish(internalError(), startedAt, {
      event: "telegram_webhook",
      outcome: "internal_error",
      updateId: update.updateId,
      chatId: update.chatId,
    });
  }

  // Phase 9.1A: build the single-provider TranslateBoundary the router
  // selects, based on TRANSLATION_PROVIDER — never both, never a
  // runtime fan-out (docs/architecture.md, "Translation provider
  // router"). Workers AI mode needs no Secret at all (env.AI is a
  // binding, not a Secret) and never consumes the Phase 7
  // OpenAI-specific rate/usage counters below.
  let translateBoundary: TranslateBoundary;
  if (config.translationProvider === "workers-ai") {
    translateBoundary = createTranslationRouter({
      mode: "workers-ai",
      workersAi: createWorkersAiTranslationProvider({
        binding: env.AI,
        model: config.workersAiModel,
      }),
    });
  } else {
    const openaiApiKey = env.OPENAI_API_KEY;
    if (openaiApiKey === undefined || openaiApiKey === "") {
      // Secret isn't registered yet — only required for the legacy
      // TRANSLATION_PROVIDER=openai path.
      return finish(internalError(), startedAt, {
        event: "telegram_webhook",
        outcome: "internal_error",
        updateId: update.updateId,
        chatId: update.chatId,
      });
    }

    // Phase 7: reserves one unit of OpenAI attempt budget immediately
    // before *each* HTTP attempt (including retries) — chat-minute
    // burst first, then the global daily ceiling, never the other way
    // around (docs/architecture.md, "Rate limiting and usage ceiling
    // placement"). Captured as a closure so infrastructure/openai never
    // imports D1. Legacy-openai-mode only — Workers AI mode never
    // reaches this branch.
    const reserveOpenAiAttempt = async (): Promise<void> => {
      const nowMs = Date.now();
      const chatAllowed = await consumeChatOpenAiAttemptLimit(
        env.DB,
        update.chatId,
        minuteWindowId(nowMs),
        reliabilityConfig.maxOpenAiAttemptsPerChatPerMinute,
      );
      if (!chatAllowed) {
        throw new RateLimitExceededError("OpenAI per-chat attempt burst limit exceeded");
      }
      const dailyAllowed = await consumeDailyOpenAiAttemptLimit(
        env.DB,
        utcDayId(nowMs),
        reliabilityConfig.maxOpenAiAttemptsPerDay,
      );
      if (!dailyAllowed) {
        throw new UsageLimitExceededError("Global daily OpenAI attempt ceiling exceeded");
      }
    };

    translateBoundary = createTranslationRouter({
      mode: "openai",
      openai: {
        translate: (translationRequest) =>
          translateMessage(translationRequest, {
            apiKey: openaiApiKey,
            model: config.openaiModel,
            beforeAttempt: reserveOpenAiAttempt,
          }),
      },
    });
  }

  try {
    // 13-16. The application use case: read speaker memory, at most one
    //        logical provider call via the router built above, then
    //        (only on a translated outcome) one Telegram reply and a
    //        best-effort observed-profile write.
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
      translate: translateBoundary,
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

    const webhookOutcome: WebhookOutcome =
      outcome.kind === "skipped" ? "ignored:untargeted-language" : "translated";
    return finish(accepted(webhookOutcome), startedAt, {
      event: "telegram_webhook",
      outcome: webhookOutcome,
      updateId: update.updateId,
      chatId: update.chatId,
      provider: config.translationProvider,
    });
  } catch (error) {
    if (error instanceof EscalationRequiredError) {
      // Dedupe reservation KEPT — retrying the identical message would
      // just re-derive the same escalation decision (Gemini escalation
      // is Phase 9.1B, not available yet). See src/shared/errors.ts.
      return finish(accepted("ignored:escalation-unavailable"), startedAt, {
        event: "telegram_webhook",
        outcome: "ignored:escalation-unavailable",
        updateId: update.updateId,
        chatId: update.chatId,
        provider: config.translationProvider,
        escalationReason: error.escalationReason,
      });
    }
    if (error instanceof RateLimitExceededError) {
      // Dedupe reservation KEPT — same reasoning as the inbound limit above.
      return finish(accepted("ignored:rate-limited"), startedAt, {
        event: "telegram_webhook",
        outcome: "ignored:rate-limited",
        updateId: update.updateId,
        chatId: update.chatId,
        limitType: "chat-openai",
        provider: config.translationProvider,
      });
    }
    if (error instanceof UsageLimitExceededError) {
      // Dedupe reservation KEPT — same reasoning as the inbound limit above.
      return finish(accepted("ignored:usage-limit"), startedAt, {
        event: "telegram_webhook",
        outcome: "ignored:usage-limit",
        updateId: update.updateId,
        chatId: update.chatId,
        limitType: "openai-daily",
        provider: config.translationProvider,
      });
    }
    if (error instanceof TransientUpstreamError) {
      await releaseDedupeReservation(env.DB, update.updateId);
    }
    // Permanent failures leave the dedupe row in place on purpose: a
    // Telegram redelivery will then be classified as ignored:duplicate
    // instead of repeating the same doomed provider/Telegram call forever.
    return finish(internalError(), startedAt, {
      event: "telegram_webhook",
      outcome: "internal_error",
      updateId: update.updateId,
      chatId: update.chatId,
      provider: config.translationProvider,
      ...classifyError(error),
    });
  }
}
