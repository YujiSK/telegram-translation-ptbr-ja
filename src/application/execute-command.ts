import type { CommandMessage, PreferenceKey } from "../commands/types";
import {
  ADMIN_ONLY_TEXT,
  CHAT_DISABLED_TEXT,
  CHAT_ENABLED_TEXT,
  FORGETME_CONFIRMED_TEXT,
  FORGETME_INSTRUCTIONS_TEXT,
  HELP_TEXT,
  UNKNOWN_COMMAND_TEXT,
  formatCorrectConfirmation,
  formatForgetCorrectionConfirmation,
  formatForgetPreferenceConfirmation,
  formatProfileReply,
  formatRememberConfirmation,
  formatStatusReply,
} from "../commands/responses";
import type { TranslationTargetLanguage } from "../domain/language";
import {
  resolveEffectiveSpeakerMemory,
  type EmojiUsage,
  type ExplicitSpeakerPreferences,
  type StyleTone,
} from "../domain/speaker-memory";
import { PermanentUpstreamError, TransientUpstreamError } from "../shared/errors";

/**
 * Command orchestration use case — Phase 6's counterpart to
 * `translate-and-reply.ts`. Reads/writes are injected boundaries so no
 * concrete D1/Telegram import leaks in here (docs/project-rules.md rule
 * 2); `src/handlers/telegram-webhook.ts` wires the real
 * `infrastructure/d1` and `infrastructure/telegram` implementations.
 *
 * Never calls OpenAI and never touches speaker_profiles' observed-style
 * write path — command processing is completely separate from the
 * JA/PT-BR translation flow (docs/implementation-plan.md Phase 6, "目的").
 * `/enable`/`/disable` admin authorization and all D1 mutations
 * (`/remember`, `/forget`, `/forgetme confirm`, `/correct`, `/enable`,
 * `/disable`) are idempotent, so a Telegram redelivery after a transient
 * failure can safely repeat them — see docs/architecture.md, "Command
 * D1 error classification and dedupe".
 *
 * `/disable` is the one exception to "reply failure after a successful
 * mutation releases the dedupe reservation": once `setChatEnabled(...,
 * false)` succeeds, the webhook's early routing drops every further
 * update for that chat except a valid `/enable`, so a Telegram
 * redelivery of *this* update could never reach the command path again
 * to retry the confirmation reply. See the `enable`/`disable` case below
 * and docs/architecture.md, "`/disable` reply-failure dedupe exception"
 * (Phase 6 review, Issue 1).
 */

export interface SentMessageInfo {
  readonly messageId: number;
  readonly chatId: number;
}

export interface CommandExecutionContext {
  readonly chatId: number;
  readonly userId: number;
  readonly messageId: number;
  /** Known true whenever a command (other than `/enable` on a disabled chat) reaches this use case — see the webhook's routing order. */
  readonly chatEnabled: boolean;
}

/** The caller's own observed profile fields only — never another user's, never a Telegram/chat ID. */
export interface CommandCallerProfile {
  readonly displayName: string;
  readonly primaryLanguage: string | null;
  readonly observedTone: StyleTone | null;
  readonly observedEmojiUsage: EmojiUsage | null;
}

export interface CommandReadBoundary {
  getProfile(chatId: number, userId: number): Promise<CommandCallerProfile | null>;
  getPreferences(chatId: number, userId: number): Promise<ExplicitSpeakerPreferences>;
  countCorrections(chatId: number, userId: number): Promise<number>;
  isAdmin(userId: number): Promise<boolean>;
}

export interface CommandWriteBoundary {
  upsertPreference(params: {
    readonly chatId: number;
    readonly userId: number;
    readonly key: PreferenceKey;
    readonly value: string;
  }): Promise<void>;
  deletePreference(params: {
    readonly chatId: number;
    readonly userId: number;
    readonly key: PreferenceKey;
  }): Promise<void>;
  upsertCorrection(params: {
    readonly chatId: number;
    readonly userId: number;
    readonly sourceLanguage: TranslationTargetLanguage;
    readonly targetLanguage: TranslationTargetLanguage;
    readonly sourceTerm: string;
    readonly targetTerm: string;
  }): Promise<void>;
  deleteCorrection(params: {
    readonly chatId: number;
    readonly userId: number;
    readonly sourceLanguage: TranslationTargetLanguage;
    readonly targetLanguage: TranslationTargetLanguage;
    readonly sourceTerm: string;
  }): Promise<void>;
  forgetSpeaker(chatId: number, userId: number): Promise<void>;
  setChatEnabled(chatId: number, enabled: boolean): Promise<void>;
}

export interface CommandReplyBoundary {
  sendMessage(params: {
    readonly chatId: number;
    readonly text: string;
    readonly replyToMessageId: number;
  }): Promise<SentMessageInfo>;
}

export interface ExecuteCommandBoundaries {
  readonly read: CommandReadBoundary;
  readonly write: CommandWriteBoundary;
  readonly reply: CommandReplyBoundary;
}

export type CommandExecutionOutcome =
  | { readonly kind: "handled"; readonly sentMessage: SentMessageInfo }
  | { readonly kind: "unknown"; readonly sentMessage: SentMessageInfo }
  | { readonly kind: "invalid"; readonly sentMessage: SentMessageInfo }
  | { readonly kind: "forbidden"; readonly sentMessage: SentMessageInfo };

async function reply(
  boundaries: ExecuteCommandBoundaries,
  context: CommandExecutionContext,
  text: string,
): Promise<SentMessageInfo> {
  return boundaries.reply.sendMessage({
    chatId: context.chatId,
    text,
    replyToMessageId: context.messageId,
  });
}

export async function executeCommand(
  message: CommandMessage,
  context: CommandExecutionContext,
  boundaries: ExecuteCommandBoundaries,
): Promise<CommandExecutionOutcome> {
  if (message.kind === "unknown-command") {
    const sentMessage = await reply(boundaries, context, UNKNOWN_COMMAND_TEXT);
    return { kind: "unknown", sentMessage };
  }
  if (message.kind === "usage-error") {
    const sentMessage = await reply(boundaries, context, message.message);
    return { kind: "invalid", sentMessage };
  }

  const command = message.command;
  switch (command.kind) {
    case "help": {
      const sentMessage = await reply(boundaries, context, HELP_TEXT);
      return { kind: "handled", sentMessage };
    }

    case "status": {
      const [profile, preferences, correctionCount] = await Promise.all([
        boundaries.read.getProfile(context.chatId, context.userId),
        boundaries.read.getPreferences(context.chatId, context.userId),
        boundaries.read.countCorrections(context.chatId, context.userId),
      ]);
      const memory = resolveEffectiveSpeakerMemory({
        observed: {
          ...(profile?.observedTone != null ? { tone: profile.observedTone } : {}),
          ...(profile?.observedEmojiUsage != null
            ? { emojiUsage: profile.observedEmojiUsage }
            : {}),
        },
        explicit: preferences,
        corrections: [],
      });
      const text = formatStatusReply({
        chatEnabled: context.chatEnabled,
        tone: memory.tone,
        emojiUsage: memory.emojiUsage,
        correctionCount,
      });
      const sentMessage = await reply(boundaries, context, text);
      return { kind: "handled", sentMessage };
    }

    case "profile": {
      const [profile, preferences, correctionCount] = await Promise.all([
        boundaries.read.getProfile(context.chatId, context.userId),
        boundaries.read.getPreferences(context.chatId, context.userId),
        boundaries.read.countCorrections(context.chatId, context.userId),
      ]);
      const text = formatProfileReply({
        observed:
          profile === null
            ? null
            : {
                displayName: profile.displayName,
                primaryLanguage: profile.primaryLanguage,
                tone: profile.observedTone,
                emojiUsage: profile.observedEmojiUsage,
              },
        explicitTone: preferences.tone ?? null,
        explicitEmojiUsage: preferences.emojiUsage ?? null,
        correctionCount,
      });
      const sentMessage = await reply(boundaries, context, text);
      return { kind: "handled", sentMessage };
    }

    case "remember": {
      await boundaries.write.upsertPreference({
        chatId: context.chatId,
        userId: context.userId,
        key: command.key,
        value: command.value,
      });
      const sentMessage = await reply(
        boundaries,
        context,
        formatRememberConfirmation(command.key, command.value),
      );
      return { kind: "handled", sentMessage };
    }

    case "forget-preference": {
      await boundaries.write.deletePreference({
        chatId: context.chatId,
        userId: context.userId,
        key: command.key,
      });
      const sentMessage = await reply(
        boundaries,
        context,
        formatForgetPreferenceConfirmation(command.key),
      );
      return { kind: "handled", sentMessage };
    }

    case "forget-correction": {
      await boundaries.write.deleteCorrection({
        chatId: context.chatId,
        userId: context.userId,
        sourceLanguage: command.sourceLanguage,
        targetLanguage: command.targetLanguage,
        sourceTerm: command.sourceTerm,
      });
      const sentMessage = await reply(
        boundaries,
        context,
        formatForgetCorrectionConfirmation(
          command.sourceLanguage,
          command.targetLanguage,
          command.sourceTerm,
        ),
      );
      return { kind: "handled", sentMessage };
    }

    case "forgetme": {
      if (!command.confirmed) {
        const sentMessage = await reply(boundaries, context, FORGETME_INSTRUCTIONS_TEXT);
        return { kind: "handled", sentMessage };
      }
      await boundaries.write.forgetSpeaker(context.chatId, context.userId);
      const sentMessage = await reply(boundaries, context, FORGETME_CONFIRMED_TEXT);
      return { kind: "handled", sentMessage };
    }

    case "correct": {
      await boundaries.write.upsertCorrection({
        chatId: context.chatId,
        userId: context.userId,
        sourceLanguage: command.sourceLanguage,
        targetLanguage: command.targetLanguage,
        sourceTerm: command.sourceTerm,
        targetTerm: command.targetTerm,
      });
      const sentMessage = await reply(
        boundaries,
        context,
        formatCorrectConfirmation(
          command.sourceLanguage,
          command.targetLanguage,
          command.sourceTerm,
          command.targetTerm,
        ),
      );
      return { kind: "handled", sentMessage };
    }

    case "enable":
    case "disable": {
      const isAdmin = await boundaries.read.isAdmin(context.userId);
      if (!isAdmin) {
        const sentMessage = await reply(boundaries, context, ADMIN_ONLY_TEXT);
        return { kind: "forbidden", sentMessage };
      }
      const enabled = command.kind === "enable";
      await boundaries.write.setChatEnabled(context.chatId, enabled);
      const confirmationText = enabled ? CHAT_ENABLED_TEXT : CHAT_DISABLED_TEXT;

      if (enabled) {
        const sentMessage = await reply(boundaries, context, confirmationText);
        return { kind: "handled", sentMessage };
      }

      // `/disable`: the mutation above already succeeded, so the chat is
      // disabled now — a Telegram redelivery of this same update can
      // never reach this command path again (the webhook drops every
      // update for a disabled chat except a valid `/enable`). Releasing
      // the dedupe reservation on a *transient* reply failure here would
      // therefore strand the confirmation forever instead of making it
      // retryable, unlike every other command. Reclassify a transient
      // reply failure as permanent so the webhook's
      // `error instanceof TransientUpstreamError` check keeps the
      // reservation instead — see docs/architecture.md, "`/disable`
      // reply-failure dedupe exception" (Phase 6 review, Issue 1). A
      // permanent Telegram failure already keeps the reservation without
      // this, so it passes through unchanged.
      try {
        const sentMessage = await reply(boundaries, context, confirmationText);
        return { kind: "handled", sentMessage };
      } catch (error) {
        if (error instanceof TransientUpstreamError) {
          throw new PermanentUpstreamError(error.message, error.service);
        }
        throw error;
      }
    }
  }
}
