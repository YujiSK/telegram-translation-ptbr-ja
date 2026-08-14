import type { ReplyContext } from "../../domain/translation";
import type { SpeakerIdentity } from "../../domain/speaker";
import type {
  InternalTextMessage,
  InternalUpdate,
  UnsupportedUpdateReason,
} from "../../domain/telegram-update";
import { ValidationError, type Result } from "../../shared/errors";

/**
 * Pure parser: raw (`unknown`) Telegram Update JSON in, a validated
 * InternalUpdate or a ValidationError out. No network calls, no module-
 * level state, no `any`, no `as unknown as X` casts — narrowing is done
 * field-by-field with type guards, per docs/project-rules.md rules 1-2
 * and Phase 1's brief.
 *
 * ID handling: Telegram documents Bot API dialog IDs (users and chats)
 * as potentially wider than 32 bits but having at most 52 significant
 * bits. All numeric identifiers parsed here must therefore be safe
 * JavaScript integers, with sign constraints applied according to each
 * field's semantics instead of treating every Telegram ID alike.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readPositiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readNonZeroId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function invalidUpdate(message: string, field?: string): Result<InternalUpdate, ValidationError> {
  return { ok: false, error: new ValidationError(message, field) };
}

function unsupportedUpdate(
  updateId: number,
  reason: UnsupportedUpdateReason,
): Result<InternalUpdate, ValidationError> {
  return { ok: true, value: { kind: "unsupported", updateId, reason } };
}

function buildDisplayName(from: Record<string, unknown>): string | undefined {
  const firstName = readNonEmptyString(from.first_name);
  if (firstName === undefined) {
    return readNonEmptyString(from.username);
  }
  const lastName = readNonEmptyString(from.last_name);
  return lastName === undefined ? firstName : `${firstName} ${lastName}`;
}

function parseSpeaker(from: unknown): SpeakerIdentity | undefined {
  if (!isRecord(from)) {
    return undefined;
  }
  const telegramUserId = readPositiveId(from.id);
  if (telegramUserId === undefined) {
    return undefined;
  }
  if (typeof from.is_bot !== "boolean") {
    return undefined;
  }
  const displayName = buildDisplayName(from);
  if (displayName === undefined) {
    return undefined;
  }
  return {
    id: { telegramUserId },
    displayName,
    isBot: from.is_bot,
  };
}

/** Extracts at most one message's worth of reply context. If the replied-to message has no usable text (e.g. a reply to a photo), there is simply no context — that's not an error. */
function parseReplyContext(replyToMessage: unknown): ReplyContext | undefined {
  if (!isRecord(replyToMessage)) {
    return undefined;
  }
  const text = readNonEmptyString(replyToMessage.text);
  return text === undefined ? undefined : { text };
}

export function parseTelegramUpdate(input: unknown): Result<InternalUpdate, ValidationError> {
  if (!isRecord(input)) {
    return invalidUpdate("Update must be a JSON object");
  }

  const updateId = readNonNegativeId(input.update_id);
  if (updateId === undefined) {
    return invalidUpdate("Update is missing a valid update_id", "update_id");
  }

  // Normal Telegram Update shapes this bot doesn't act on (MVP is
  // text-message-only — see docs/implementation-plan.md).
  if (input.channel_post !== undefined) {
    return unsupportedUpdate(updateId, "channel-post");
  }
  if (input.callback_query !== undefined) {
    return unsupportedUpdate(updateId, "callback-query");
  }
  if (input.message === undefined) {
    return unsupportedUpdate(updateId, "unrecognized-update-type");
  }

  const message = input.message;
  if (!isRecord(message)) {
    return invalidUpdate("Update.message must be a JSON object", "message");
  }

  const messageId = readPositiveId(message.message_id);
  if (messageId === undefined) {
    return invalidUpdate("Update.message.message_id is missing or invalid", "message.message_id");
  }

  if (!isRecord(message.chat)) {
    return invalidUpdate("Update.message.chat is missing or invalid", "message.chat");
  }
  const chatId = readNonZeroId(message.chat.id);
  if (chatId === undefined) {
    return invalidUpdate("Update.message.chat.id is missing or invalid", "message.chat.id");
  }

  const speaker = parseSpeaker(message.from);
  if (speaker === undefined) {
    return invalidUpdate("Update.message.from is missing or invalid", "message.from");
  }

  // A non-text message (photo, sticker, voice, ...) simply has no `text`
  // key — that's a normal, structurally valid update, just unsupported.
  if (message.text === undefined) {
    return unsupportedUpdate(updateId, "non-text-message");
  }
  if (typeof message.text !== "string") {
    return invalidUpdate("Update.message.text must be a string when present", "message.text");
  }
  if (message.text.trim() === "") {
    return unsupportedUpdate(updateId, "empty-text");
  }

  const replyContext = parseReplyContext(message.reply_to_message);

  const textMessage: InternalTextMessage = {
    kind: "text-message",
    updateId,
    messageId,
    chatId,
    speaker,
    text: message.text,
    ...(replyContext !== undefined ? { replyContext } : {}),
  };

  return { ok: true, value: textMessage };
}
