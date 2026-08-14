import type { Language, TranslationTargetLanguage } from "./language";
import type { SpeakerIdentity } from "./speaker";

/**
 * Minimal reply-context shape. Per docs/architecture.md, at most one
 * message (the one being replied to) may ever be used as context — never
 * a thread or history.
 */
export interface ReplyContext {
  readonly text: string;
}

export interface TranslationRequest {
  readonly sourceText: string;
  readonly speaker: SpeakerIdentity;
  readonly replyContext?: ReplyContext;
}

/**
 * Extension point for low-risk style signals (emoji usage, formality,
 * etc.) that Phase 4/5 will populate from the OpenAI Structured Outputs
 * response. Deliberately unspecified beyond a narrow, low-risk key/value
 * bag — see docs/security-and-privacy.md for what may never end up here
 * (no inferred personality/health/political/religious data).
 */
export interface StyleSignals {
  readonly [signal: string]: string | number | boolean;
}

export type TranslationOutcome =
  | {
      readonly kind: "translated";
      readonly detectedLanguage: TranslationTargetLanguage;
      readonly targetLanguage: TranslationTargetLanguage;
      readonly translatedText: string;
      readonly styleSignals?: StyleSignals;
    }
  | {
      readonly kind: "skipped";
      readonly detectedLanguage: Language;
      readonly reason: "untargeted-language";
    };

export interface TranslationResult {
  readonly request: TranslationRequest;
  readonly outcome: TranslationOutcome;
}
