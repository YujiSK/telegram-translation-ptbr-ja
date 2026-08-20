import type { TranslationTargetLanguage } from "../domain/language";
import type { EmojiUsage, StyleTone } from "../domain/speaker-memory";

/**
 * Phase 6 command vocabulary. Pure types only — no D1, Telegram, or
 * OpenAI dependency (docs/project-rules.md rule 1; `commands/` sits
 * alongside `domain/` for this purpose). Raw Telegram message text is
 * converted into these types only by `parse-command.ts`; nothing else in
 * this module ever sees the raw text.
 */

export type PreferenceKey = "tone" | "emoji_usage";

export interface HelpCommand {
  readonly kind: "help";
}

export interface StatusCommand {
  readonly kind: "status";
}

export interface ProfileCommand {
  readonly kind: "profile";
}

export type RememberCommand =
  | { readonly kind: "remember"; readonly key: "tone"; readonly value: StyleTone }
  | { readonly kind: "remember"; readonly key: "emoji_usage"; readonly value: EmojiUsage };

export type ForgetCommand =
  | { readonly kind: "forget-preference"; readonly key: PreferenceKey }
  | {
      readonly kind: "forget-correction";
      readonly sourceLanguage: TranslationTargetLanguage;
      readonly targetLanguage: TranslationTargetLanguage;
      readonly sourceTerm: string;
    };

export interface ForgetMeCommand {
  readonly kind: "forgetme";
  readonly confirmed: boolean;
}

export interface CorrectCommand {
  readonly kind: "correct";
  readonly sourceLanguage: TranslationTargetLanguage;
  readonly targetLanguage: TranslationTargetLanguage;
  readonly sourceTerm: string;
  readonly targetTerm: string;
}

export interface EnableCommand {
  readonly kind: "enable";
}

export interface DisableCommand {
  readonly kind: "disable";
}

export type ParsedCommand =
  | HelpCommand
  | StatusCommand
  | ProfileCommand
  | RememberCommand
  | ForgetCommand
  | ForgetMeCommand
  | CorrectCommand
  | EnableCommand
  | DisableCommand;

/**
 * Result of parsing one message's text as a possible command.
 * - `not-a-command`: the text doesn't start with `/` — route to the
 *   normal JA/PT-BR translation flow instead.
 * - `unknown-command`: starts with `/` but the name isn't one of the
 *   commands this bot recognizes.
 * - `usage-error`: a recognized command name with invalid arguments —
 *   `message` is a ready-to-send, safe (no Secret/ID) usage string.
 * - `parsed`: a fully valid command, ready for `execute-command.ts`.
 */
export type CommandParseResult =
  | { readonly kind: "not-a-command" }
  | { readonly kind: "unknown-command"; readonly name: string }
  | { readonly kind: "usage-error"; readonly message: string }
  | { readonly kind: "parsed"; readonly command: ParsedCommand };

/** `CommandParseResult` narrowed to the variants the command path (never the translation path) handles. */
export type CommandMessage = Exclude<CommandParseResult, { readonly kind: "not-a-command" }>;
