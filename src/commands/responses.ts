import type { EffectiveStyleSignal } from "../domain/speaker-memory";

/**
 * Pure, plain-text response builders for the command surface. No
 * Markdown/HTML parse mode (docs/implementation-plan.md Phase 6, "User-
 * facing response policy") and never a Telegram user ID, chat ID, Secret,
 * raw D1 error, or stack trace — see docs/security-and-privacy.md.
 */

export const HELP_TEXT = [
  "Available commands:",
  "/help - show this message",
  "/status - show bot status and your effective settings",
  "/profile - show your stored profile",
  "/remember tone <casual|neutral|formal> - set your tone preference",
  "/remember emoji_usage <none|light|frequent> - set your emoji preference",
  "/forget tone - remove your tone preference",
  "/forget emoji_usage - remove your emoji preference",
  "/forget correction <ja|pt-br> <ja|pt-br> <term> - remove a stored correction",
  "/forgetme - show how to permanently delete your stored data",
  "/forgetme confirm - permanently delete your stored data",
  "/correct <ja|pt-br> <ja|pt-br> <source term> => <target term> - store a translation correction",
  "/enable - enable the bot for this chat (admin only)",
  "/disable - disable the bot for this chat (admin only)",
].join("\n");

export const UNKNOWN_COMMAND_TEXT = "Unknown command. Use /help.";

export const ADMIN_ONLY_TEXT = "This command is restricted to bot admins.";

export const CHAT_ENABLED_TEXT = "Chat enabled.";
export const CHAT_DISABLED_TEXT = "Chat disabled.";

export const FORGETME_CONFIRMED_TEXT = "Your stored data for this chat has been deleted.";
export const FORGETME_INSTRUCTIONS_TEXT =
  "This will permanently delete your stored profile, preferences, and corrections for this chat. Send /forgetme confirm to proceed.";

function formatKeyLabel(key: "tone" | "emoji_usage"): string {
  return key === "tone" ? "Tone preference" : "Emoji preference";
}

export function formatRememberConfirmation(key: "tone" | "emoji_usage", value: string): string {
  return `${formatKeyLabel(key)} saved: ${value}`;
}

export function formatForgetPreferenceConfirmation(key: "tone" | "emoji_usage"): string {
  return `${formatKeyLabel(key)} removed.`;
}

export function formatForgetCorrectionConfirmation(
  sourceLanguage: string,
  targetLanguage: string,
  sourceTerm: string,
): string {
  return `Correction removed: ${sourceLanguage} -> ${targetLanguage} "${sourceTerm}"`;
}

export function formatCorrectConfirmation(
  sourceLanguage: string,
  targetLanguage: string,
  sourceTerm: string,
  targetTerm: string,
): string {
  return `Correction saved: ${sourceLanguage} -> ${targetLanguage} "${sourceTerm}" => "${targetTerm}"`;
}

/** Always shows one of the three source states (explicit/observed/none) — never guesses a value. */
function formatSignalLine(label: string, signal: EffectiveStyleSignal<string>): string {
  if (signal.source === "none") {
    return `${label}: unset (none)`;
  }
  return `${label}: ${signal.value} (${signal.source})`;
}

export interface StatusReplyInput {
  readonly chatEnabled: boolean;
  readonly tone: EffectiveStyleSignal<string>;
  readonly emojiUsage: EffectiveStyleSignal<string>;
  readonly correctionCount: number;
}

/** Never includes a Telegram user/chat ID, another user's data, or correction text — only counts and this caller's own resolved settings. */
export function formatStatusReply(input: StatusReplyInput): string {
  return [
    `Chat: ${input.chatEnabled ? "enabled" : "disabled"}`,
    formatSignalLine("Tone", input.tone),
    formatSignalLine("Emoji usage", input.emojiUsage),
    `Stored corrections: ${input.correctionCount}`,
  ].join("\n");
}

export interface ProfileReplyInput {
  readonly observed: {
    readonly displayName: string;
    readonly primaryLanguage: string | null;
    readonly tone: string | null;
    readonly emojiUsage: string | null;
  } | null;
  readonly explicitTone: string | null;
  readonly explicitEmojiUsage: string | null;
  readonly correctionCount: number;
}

/** Never includes a Telegram user/chat ID, another user's data, or a list of correction terms — only this caller's own resolved fields and a count. */
export function formatProfileReply(input: ProfileReplyInput): string {
  const lines: string[] = [];
  if (input.observed === null) {
    lines.push("No observed profile yet. Send a message in ja or pt-br to create one.");
  } else {
    lines.push(`Display name: ${input.observed.displayName}`);
    lines.push(`Primary language: ${input.observed.primaryLanguage ?? "not observed yet"}`);
    lines.push(`Observed tone: ${input.observed.tone ?? "not observed yet"}`);
    lines.push(`Observed emoji usage: ${input.observed.emojiUsage ?? "not observed yet"}`);
  }
  lines.push(`Explicit tone preference: ${input.explicitTone ?? "not set"}`);
  lines.push(`Explicit emoji preference: ${input.explicitEmojiUsage ?? "not set"}`);
  lines.push(`Stored corrections: ${input.correctionCount}`);
  return lines.join("\n");
}
