import { PermanentUpstreamError } from "../../shared/errors";
import { callTelegramApi, type TelegramApiCallOptions } from "./client";

/**
 * `sendMessage` — implemented for use starting Phase 4 (not called from
 * the Phase 3 webhook handler; see docs/implementation-plan.md). Field
 * names and the reply mechanism follow the current Telegram Bot API
 * `sendMessage` reference: `chat_id`, `text`, and — to reply to a
 * specific message — `reply_parameters: { message_id }` (the current,
 * non-deprecated reply mechanism).
 */

export interface SendMessageParams {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
}

export interface SentMessage {
  readonly messageId: number;
  readonly chatId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the untrusted `result` payload before trusting any of its fields — never cast without checking. */
function parseSentMessage(result: unknown): SentMessage {
  if (
    !isRecord(result) ||
    typeof result.message_id !== "number" ||
    !Number.isSafeInteger(result.message_id) ||
    !isRecord(result.chat) ||
    typeof result.chat.id !== "number" ||
    !Number.isSafeInteger(result.chat.id)
  ) {
    throw new PermanentUpstreamError(
      "Telegram API returned a malformed sendMessage result",
      "telegram",
    );
  }

  return { messageId: result.message_id, chatId: result.chat.id };
}

export async function sendMessage(
  params: SendMessageParams,
  options: TelegramApiCallOptions,
): Promise<SentMessage> {
  const body: Record<string, unknown> = {
    chat_id: params.chatId,
    text: params.text,
  };
  if (params.replyToMessageId !== undefined) {
    body.reply_parameters = { message_id: params.replyToMessageId };
  }

  const result = await callTelegramApi("sendMessage", body, options);
  return parseSentMessage(result);
}
