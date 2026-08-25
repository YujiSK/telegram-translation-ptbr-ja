import type { TranslationOutcome, TranslationRequest } from "../../domain/translation";
import type { EscalationReason } from "../../shared/errors";

/**
 * Phase 9.1A: the shape every translation provider adapter (Workers AI
 * today; Gemini/DeepL in later phases) returns internally. This is
 * deliberately infrastructure-only — `needsEscalation`/`escalationReason`
 * never appear on the domain `TranslationOutcome` (src/domain/translation.ts)
 * or cross into `application/`, per docs/decisions/0002-multi-provider-translation-routing.md,
 * "Application contract". The router (./router.ts) is the only consumer.
 *
 * No floating-point confidence score: `needsEscalation` is an explicit
 * bounded boolean the provider adapter itself decides (from its own
 * structured output), never a raw model-reported number trusted as-is —
 * see the Phase 9.1A prompt's "avoid a floating-point confidence score
 * unless a concrete routing need is demonstrated" guidance.
 */
export interface ProviderTranslationCandidate {
  readonly outcome: TranslationOutcome;
  readonly needsEscalation: boolean;
  readonly escalationReason: EscalationReason;
}

export interface TranslationProvider {
  translate(request: TranslationRequest): Promise<ProviderTranslationCandidate>;
}
