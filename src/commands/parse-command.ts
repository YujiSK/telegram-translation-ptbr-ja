import type { TranslationTargetLanguage } from "../domain/language";
import type { EmojiUsage, StyleTone } from "../domain/speaker-memory";
import type { CommandParseResult, ParsedCommand, PreferenceKey } from "./types";

/**
 * Pure command parser: raw message text in, a `CommandParseResult` out.
 * No D1/Telegram/OpenAI access, no `any`, no unsafe casts — matches the
 * style of `infrastructure/telegram/parse-update.ts`. Recognizes both
 * `/status` and `/status@SomeBotName` as the same command (the `@`
 * suffix is simply stripped, never checked against a specific bot
 * username, since this Worker has no way to know its own username
 * without an extra Telegram API call).
 */

const KNOWN_COMMAND_NAMES = [
  "help",
  "status",
  "profile",
  "remember",
  "forget",
  "forgetme",
  "correct",
  "enable",
  "disable",
] as const;

type KnownCommandName = (typeof KNOWN_COMMAND_NAMES)[number];

function isKnownCommandName(value: string): value is KnownCommandName {
  return (KNOWN_COMMAND_NAMES as readonly string[]).includes(value);
}

/** Matches the 100-character ceiling in `migrations/0002_speaker_memory.sql`'s `translation_corrections` CHECK. */
const MAX_TERM_LENGTH = 100;

function isValidTerm(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= MAX_TERM_LENGTH;
}

/** Narrows a raw token to `TranslationTargetLanguage` — deliberately its own guard (not `domain/language.ts`'s `isTranslationTargetLanguage`, which expects an already-typed `Language`) since the input here is arbitrary user text. */
function isLanguageToken(value: string): value is TranslationTargetLanguage {
  return value === "ja" || value === "pt-br";
}

/** ja<->pt-br only — same-language pairs and "other" are never a valid correction direction, matching `translation_corrections`' CHECK. */
function isValidDirection(
  sourceLanguage: TranslationTargetLanguage,
  targetLanguage: TranslationTargetLanguage,
): boolean {
  return (
    (sourceLanguage === "ja" && targetLanguage === "pt-br") ||
    (sourceLanguage === "pt-br" && targetLanguage === "ja")
  );
}

function isStyleTone(value: string): value is StyleTone {
  return value === "casual" || value === "neutral" || value === "formal";
}

function isEmojiUsage(value: string): value is EmojiUsage {
  return value === "none" || value === "light" || value === "frequent";
}

function isPreferenceKey(value: string): value is PreferenceKey {
  return value === "tone" || value === "emoji_usage";
}

function usageError(message: string): CommandParseResult {
  return { kind: "usage-error", message };
}

function parsed(command: ParsedCommand): CommandParseResult {
  return { kind: "parsed", command };
}

/**
 * `/help`, `/status`, `/profile`, `/enable`, and `/disable` take no
 * arguments — a trailing argument (e.g. `/status extra`) is a usage
 * error, not a normal invocation with the extra text silently ignored
 * (Phase 6 review, Issue 2). This also means `/enable garbage` is never
 * classified as a valid parsed `/enable`, so the webhook's
 * disabled-chat `/enable` exception (`src/handlers/telegram-webhook.ts`)
 * never admits it.
 */
function parseNoArgCommand(
  rest: string,
  command: ParsedCommand,
  usage: string,
): CommandParseResult {
  return rest === "" ? parsed(command) : usageError(usage);
}

const REMEMBER_USAGE =
  "Usage: /remember tone <casual|neutral|formal> or /remember emoji_usage <none|light|frequent>";

function parseRemember(rest: string): CommandParseResult {
  const tokens = rest.split(/\s+/).filter((token) => token !== "");
  if (tokens.length !== 2) {
    return usageError(REMEMBER_USAGE);
  }
  const key = tokens[0] ?? "";
  const value = tokens[1] ?? "";
  if (key === "tone") {
    return isStyleTone(value)
      ? parsed({ kind: "remember", key: "tone", value })
      : usageError(REMEMBER_USAGE);
  }
  if (key === "emoji_usage") {
    return isEmojiUsage(value)
      ? parsed({ kind: "remember", key: "emoji_usage", value })
      : usageError(REMEMBER_USAGE);
  }
  return usageError(REMEMBER_USAGE);
}

const FORGET_USAGE =
  "Usage: /forget tone | /forget emoji_usage | /forget correction <ja|pt-br> <ja|pt-br> <term>";

function parseForget(rest: string): CommandParseResult {
  const correctionMatch = /^correction\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(rest);
  if (correctionMatch !== null) {
    const rawSourceLanguage = correctionMatch[1] ?? "";
    const rawTargetLanguage = correctionMatch[2] ?? "";
    const rawTerm = correctionMatch[3] ?? "";
    if (
      !isLanguageToken(rawSourceLanguage) ||
      !isLanguageToken(rawTargetLanguage) ||
      !isValidDirection(rawSourceLanguage, rawTargetLanguage)
    ) {
      return usageError(FORGET_USAGE);
    }
    const sourceTerm = rawTerm.trim();
    if (!isValidTerm(sourceTerm)) {
      return usageError(FORGET_USAGE);
    }
    return parsed({
      kind: "forget-correction",
      sourceLanguage: rawSourceLanguage,
      targetLanguage: rawTargetLanguage,
      sourceTerm,
    });
  }

  const tokens = rest.split(/\s+/).filter((token) => token !== "");
  const singleToken = tokens[0];
  if (tokens.length === 1 && singleToken !== undefined && isPreferenceKey(singleToken)) {
    return parsed({ kind: "forget-preference", key: singleToken });
  }
  return usageError(FORGET_USAGE);
}

const FORGETME_USAGE =
  "Usage: /forgetme (shows how to confirm) or /forgetme confirm (deletes your data)";

function parseForgetMe(rest: string): CommandParseResult {
  if (rest === "") {
    return parsed({ kind: "forgetme", confirmed: false });
  }
  if (rest === "confirm") {
    return parsed({ kind: "forgetme", confirmed: true });
  }
  return usageError(FORGETME_USAGE);
}

const CORRECT_USAGE = "Usage: /correct <ja|pt-br> <ja|pt-br> <source term> => <target term>";

function parseCorrect(rest: string): CommandParseResult {
  const match = /^(\S+)\s+(\S+)\s+([\s\S]*)$/.exec(rest);
  if (match === null) {
    return usageError(CORRECT_USAGE);
  }
  const rawSourceLanguage = match[1] ?? "";
  const rawTargetLanguage = match[2] ?? "";
  const remainder = match[3] ?? "";
  if (
    !isLanguageToken(rawSourceLanguage) ||
    !isLanguageToken(rawTargetLanguage) ||
    !isValidDirection(rawSourceLanguage, rawTargetLanguage)
  ) {
    return usageError(CORRECT_USAGE);
  }

  const separatorIndex = remainder.indexOf("=>");
  if (separatorIndex === -1) {
    return usageError(CORRECT_USAGE);
  }
  const sourceTerm = remainder.slice(0, separatorIndex).trim();
  const targetTerm = remainder.slice(separatorIndex + 2).trim();
  if (!isValidTerm(sourceTerm) || !isValidTerm(targetTerm)) {
    return usageError(CORRECT_USAGE);
  }

  return parsed({
    kind: "correct",
    sourceLanguage: rawSourceLanguage,
    targetLanguage: rawTargetLanguage,
    sourceTerm,
    targetTerm,
  });
}

export function parseCommandMessage(text: string): CommandParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "not-a-command" };
  }

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) {
    return { kind: "not-a-command" };
  }
  const nameToken = match[1] ?? "";
  const rest = (match[2] ?? "").trim();

  const withoutSlash = nameToken.slice(1);
  const atIndex = withoutSlash.indexOf("@");
  const name = atIndex === -1 ? withoutSlash : withoutSlash.slice(0, atIndex);

  if (!isKnownCommandName(name)) {
    return { kind: "unknown-command", name };
  }

  switch (name) {
    case "help":
      return parseNoArgCommand(rest, { kind: "help" }, "Usage: /help");
    case "status":
      return parseNoArgCommand(rest, { kind: "status" }, "Usage: /status");
    case "profile":
      return parseNoArgCommand(rest, { kind: "profile" }, "Usage: /profile");
    case "remember":
      return parseRemember(rest);
    case "forget":
      return parseForget(rest);
    case "forgetme":
      return parseForgetMe(rest);
    case "correct":
      return parseCorrect(rest);
    case "enable":
      return parseNoArgCommand(rest, { kind: "enable" }, "Usage: /enable");
    case "disable":
      return parseNoArgCommand(rest, { kind: "disable" }, "Usage: /disable");
  }
}
