import type { InternalTextMessage } from "../domain/telegram-update";
import type { TranslationOutcome, TranslationRequest } from "../domain/translation";

/**
 * Translation use case: build the request, call the OpenAI translation
 * boundary exactly once, and — only on a "translated" outcome — call the
 * Telegram reply boundary. Neither boundary's raw vendor response type
 * leaks here (docs/project-rules.md rule 2); both are injected so this
 * module has no concrete infrastructure import. Speaker memory is not
 * read or written here — that's Phase 5.
 */

export interface TranslateBoundary {
  translate(request: TranslationRequest): Promise<TranslationOutcome>;
}

export interface SentMessageInfo {
  readonly messageId: number;
  readonly chatId: number;
}

export interface ReplyBoundary {
  sendMessage(params: {
    readonly chatId: number;
    readonly text: string;
    readonly replyToMessageId: number;
  }): Promise<SentMessageInfo>;
}

export type TranslateAndReplyOutcome =
  | { readonly kind: "translated"; readonly sentMessage: SentMessageInfo }
  | { readonly kind: "skipped"; readonly reason: "untargeted-language" };

export interface TranslateAndReplyBoundaries {
  readonly translate: TranslateBoundary;
  readonly reply: ReplyBoundary;
}

export async function translateAndReply(
  message: InternalTextMessage,
  boundaries: TranslateAndReplyBoundaries,
): Promise<TranslateAndReplyOutcome> {
  const request: TranslationRequest = {
    sourceText: message.text,
    speaker: message.speaker,
    ...(message.replyContext !== undefined ? { replyContext: message.replyContext } : {}),
  };

  const outcome = await boundaries.translate.translate(request);

  if (outcome.kind === "skipped") {
    return { kind: "skipped", reason: "untargeted-language" };
  }

  const sentMessage = await boundaries.reply.sendMessage({
    chatId: message.chatId,
    text: outcome.translatedText,
    replyToMessageId: message.messageId,
  });

  return { kind: "translated", sentMessage };
}
