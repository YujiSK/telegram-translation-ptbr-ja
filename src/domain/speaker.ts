/**
 * Minimal internal identity for a message's sender. Deliberately narrow —
 * see docs/security-and-privacy.md: no inferred personality/health/
 * political/religious data, ever. A raw Telegram `User` object is never
 * passed through as this type (docs/project-rules.md rule 2); the
 * conversion happens at the infrastructure boundary
 * (infrastructure/telegram/parse-update.ts).
 */

export interface SpeakerId {
  readonly telegramUserId: number;
}

export interface SpeakerIdentity {
  readonly id: SpeakerId;
  /** Synthesized from Telegram's first/last name (or username as a fallback) — never the raw Telegram User object. */
  readonly displayName: string;
  readonly isBot: boolean;
}
