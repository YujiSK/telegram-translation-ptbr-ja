import type { Language, TranslationTargetLanguage } from "./language";
import type { SpeakerIdentity } from "./speaker";
import type { EffectiveSpeakerMemory } from "./speaker-memory";

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
  /** Optional since not every caller has speaker memory to offer (e.g. Phase 4 tests) — see docs/implementation-plan.md Phase 5. */
  readonly memory?: EffectiveSpeakerMemory;
}

/**
 * Low-risk style signals extracted by the same OpenAI call that performs
 * translation (Phase 4) — never stored in D1 until Phase 5 defines the
 * memory behavior that owns them. Deliberately a small, fixed enum
 * shape, not free-form: see docs/security-and-privacy.md for what may
 * never end up here (no inferred personality/health/political/religious
 * data, no confidence/emotion scores, no age/gender guesses).
 */
export interface StyleSignals {
  readonly tone: "casual" | "neutral" | "formal";
  readonly emojiUsage: "none" | "light" | "frequent";
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
