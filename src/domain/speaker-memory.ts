import type { TranslationTargetLanguage } from "./language";
import type { StyleSignals } from "./translation";

/**
 * Phase 5 speaker-memory vocabulary. No external-service dependency here
 * (docs/project-rules.md rule 1) — D1 row shapes are converted into these
 * types at the infrastructure boundary
 * (src/infrastructure/d1/{speaker-profiles,speaker-preferences,translation-corrections}.ts),
 * never passed through directly (rule 2).
 *
 * Everything here reuses `StyleSignals`' fixed, low-risk enums
 * (docs/security-and-privacy.md) — no free-form style description, no
 * confidence/emotion score, no personality/health/political/religious
 * inference, ever.
 */

export type StyleTone = StyleSignals["tone"];
export type EmojiUsage = StyleSignals["emojiUsage"];

/** The single latest auto-observed style signal for a speaker — never a history. */
export interface ObservedSpeakerStyle {
  readonly tone?: StyleTone;
  readonly emojiUsage?: EmojiUsage;
}

/** Explicit, user-set style preferences — always outrank `ObservedSpeakerStyle` on the same axis. */
export interface ExplicitSpeakerPreferences {
  readonly tone?: StyleTone;
  readonly emojiUsage?: EmojiUsage;
}

/** A short term/phrase correction pair, scoped to a single (chat, user) — see docs/data-model.md. */
export interface TranslationCorrection {
  readonly sourceLanguage: TranslationTargetLanguage;
  readonly targetLanguage: TranslationTargetLanguage;
  readonly sourceTerm: string;
  readonly targetTerm: string;
}

export type MemorySignalSource = "explicit" | "observed" | "none";

/**
 * A single resolved style axis. `source` records which input won so
 * callers (the prompt builder, tests) can tell an explicit override from
 * a soft inferred hint apart without re-deriving priority themselves.
 */
export type EffectiveStyleSignal<T extends string> =
  { readonly source: "explicit" | "observed"; readonly value: T } | { readonly source: "none" };

/**
 * The fully-resolved memory for one speaker in one chat, ready to hand to
 * the prompt builder. A speaker with no stored data at all is represented
 * validly by `{ source: "none" }` on both axes and an empty
 * `applicableCorrections` array — there is no separate "no memory" type,
 * by design (see docs/implementation-plan.md Phase 5, Stage E).
 */
export interface EffectiveSpeakerMemory {
  readonly tone: EffectiveStyleSignal<StyleTone>;
  readonly emojiUsage: EffectiveStyleSignal<EmojiUsage>;
  readonly applicableCorrections: readonly TranslationCorrection[];
}

function resolveSignal<T extends string>(
  explicitValue: T | undefined,
  observedValue: T | undefined,
): EffectiveStyleSignal<T> {
  if (explicitValue !== undefined) {
    return { source: "explicit", value: explicitValue };
  }
  if (observedValue !== undefined) {
    return { source: "observed", value: observedValue };
  }
  return { source: "none" };
}

/**
 * Priority resolution: explicit preference beats observed style on the
 * same axis; tone and emojiUsage are resolved independently of each
 * other (an explicit tone does not affect the emojiUsage fallback, and
 * vice versa). `corrections` is treated as an entirely separate axis —
 * already selected/filtered by the caller (see
 * `selectApplicableCorrections`) — and is carried through unchanged, per
 * docs/implementation-plan.md Phase 5 Stage F ("correctionはstyle
 * preferenceとは別の軸").
 */
export function resolveEffectiveSpeakerMemory(input: {
  readonly observed: ObservedSpeakerStyle;
  readonly explicit: ExplicitSpeakerPreferences;
  readonly corrections: readonly TranslationCorrection[];
}): EffectiveSpeakerMemory {
  return {
    tone: resolveSignal(input.explicit.tone, input.observed.tone),
    emojiUsage: resolveSignal(input.explicit.emojiUsage, input.observed.emojiUsage),
    applicableCorrections: input.corrections,
  };
}

/** Hard cap on corrections included in a single translation prompt — see docs/data-model.md. */
export const MAX_PROMPT_CORRECTIONS = 20;

/**
 * Selects the corrections actually relevant to the current message,
 * capped and in a deterministic order. Matching is deliberately simple
 * and predictable — a literal substring check — per
 * docs/implementation-plan.md Phase 5 Stage D-3: no morphological
 * analysis, no regex generation, no embeddings, no fuzzy matching.
 *
 * `corrections` is expected to already be ordered deterministically by
 * the repository layer (most-recently-updated first, then `sourceTerm`
 * — see `listTranslationCorrections`); `Array.prototype.filter`
 * preserves that relative order, so the result stays deterministic
 * without this function needing to know the ordering rule itself.
 *
 * `sourceText` is used only for this in-memory comparison — it is never
 * written to D1 by this function or any caller in this module.
 */
export function selectApplicableCorrections(
  corrections: readonly TranslationCorrection[],
  sourceText: string,
  limit: number = MAX_PROMPT_CORRECTIONS,
): TranslationCorrection[] {
  const applicable = corrections.filter((correction) => sourceText.includes(correction.sourceTerm));
  return applicable.slice(0, limit);
}
