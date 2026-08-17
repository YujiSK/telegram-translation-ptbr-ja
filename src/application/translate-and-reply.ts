import type { TranslationTargetLanguage } from "../domain/language";
import type { EffectiveSpeakerMemory } from "../domain/speaker-memory";
import type { InternalTextMessage } from "../domain/telegram-update";
import type { StyleSignals, TranslationOutcome, TranslationRequest } from "../domain/translation";

/**
 * Translation use case: read speaker memory, build the request, call the
 * OpenAI translation boundary exactly once, and — only on a "translated"
 * outcome — call the Telegram reply boundary and (best-effort) record the
 * observed style. No boundary's raw vendor response type leaks here
 * (docs/project-rules.md rule 2); all four are injected so this module
 * has no concrete infrastructure import.
 *
 * Ordering and failure policy (docs/architecture.md, "Dedupe and retry
 * after a transient failure", and docs/implementation-plan.md Phase 5
 * Stage I "書き込み順序と失敗方針"):
 *   1. memory read — a failure here propagates (no OpenAI/Telegram call).
 *   2. OpenAI translation — a failure here propagates.
 *   3. Telegram reply — a failure here propagates; never treated as success.
 *   4. observed profile write — best-effort. A failure here is swallowed:
 *      the reply already succeeded, so turning this into a request
 *      failure would risk a duplicate reply on Telegram's redelivery.
 */

export interface MemoryReadBoundary {
  readMemory(params: {
    readonly chatId: number;
    readonly userId: number;
    readonly sourceText: string;
  }): Promise<EffectiveSpeakerMemory>;
}

export interface ObservedProfileWriteBoundary {
  writeObservedProfile(params: {
    readonly chatId: number;
    readonly userId: number;
    readonly displayName: string;
    readonly detectedLanguage: TranslationTargetLanguage;
    readonly styleSignals: StyleSignals;
  }): Promise<void>;
}

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
  readonly memoryReader: MemoryReadBoundary;
  readonly translate: TranslateBoundary;
  readonly reply: ReplyBoundary;
  readonly profileWriter: ObservedProfileWriteBoundary;
}

/** Best-effort: a write failure must never turn an already-successful reply into a failed request. */
async function writeObservedProfileBestEffort(
  boundaries: TranslateAndReplyBoundaries,
  message: InternalTextMessage,
  outcome: Extract<TranslationOutcome, { kind: "translated" }>,
): Promise<void> {
  if (outcome.styleSignals === undefined) {
    // No style signal to record — never guess-fill one (docs/implementation-plan.md Phase 5 Stage K).
    return;
  }
  try {
    await boundaries.profileWriter.writeObservedProfile({
      chatId: message.chatId,
      userId: message.speaker.id.telegramUserId,
      displayName: message.speaker.displayName,
      detectedLanguage: outcome.detectedLanguage,
      styleSignals: outcome.styleSignals,
    });
  } catch {
    // Swallowed on purpose — see the module-level comment. Phase 7's
    // structured logging can make this failure operator-visible without
    // message text or Secrets; nothing to do here yet.
  }
}

export async function translateAndReply(
  message: InternalTextMessage,
  boundaries: TranslateAndReplyBoundaries,
): Promise<TranslateAndReplyOutcome> {
  const memory = await boundaries.memoryReader.readMemory({
    chatId: message.chatId,
    userId: message.speaker.id.telegramUserId,
    sourceText: message.text,
  });

  const request: TranslationRequest = {
    sourceText: message.text,
    speaker: message.speaker,
    ...(message.replyContext !== undefined ? { replyContext: message.replyContext } : {}),
    memory,
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

  await writeObservedProfileBestEffort(boundaries, message, outcome);

  return { kind: "translated", sentMessage };
}
