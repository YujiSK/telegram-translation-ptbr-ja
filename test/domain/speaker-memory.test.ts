import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_CORRECTIONS,
  resolveEffectiveSpeakerMemory,
  selectApplicableCorrections,
} from "../../src/domain/speaker-memory";
import type { TranslationCorrection } from "../../src/domain/speaker-memory";

const NO_CORRECTIONS: readonly TranslationCorrection[] = [];

describe("resolveEffectiveSpeakerMemory — priority resolution", () => {
  it("prefers explicit tone over observed tone", () => {
    const memory = resolveEffectiveSpeakerMemory({
      observed: { tone: "casual" },
      explicit: { tone: "formal" },
      corrections: NO_CORRECTIONS,
    });

    expect(memory.tone).toEqual({ source: "explicit", value: "formal" });
  });

  it("prefers explicit emojiUsage over observed emojiUsage", () => {
    const memory = resolveEffectiveSpeakerMemory({
      observed: { emojiUsage: "none" },
      explicit: { emojiUsage: "frequent" },
      corrections: NO_CORRECTIONS,
    });

    expect(memory.emojiUsage).toEqual({ source: "explicit", value: "frequent" });
  });

  it("falls back to observed emojiUsage when only tone is explicit", () => {
    const memory = resolveEffectiveSpeakerMemory({
      observed: { tone: "neutral", emojiUsage: "light" },
      explicit: { tone: "casual" },
      corrections: NO_CORRECTIONS,
    });

    expect(memory.tone).toEqual({ source: "explicit", value: "casual" });
    expect(memory.emojiUsage).toEqual({ source: "observed", value: "light" });
  });

  it("falls back to observed tone when only emojiUsage is explicit", () => {
    const memory = resolveEffectiveSpeakerMemory({
      observed: { tone: "formal", emojiUsage: "none" },
      explicit: { emojiUsage: "frequent" },
      corrections: NO_CORRECTIONS,
    });

    expect(memory.tone).toEqual({ source: "observed", value: "formal" });
    expect(memory.emojiUsage).toEqual({ source: "explicit", value: "frequent" });
  });

  it("uses observed-only style when there is no explicit preference at all", () => {
    const memory = resolveEffectiveSpeakerMemory({
      observed: { tone: "casual", emojiUsage: "light" },
      explicit: {},
      corrections: NO_CORRECTIONS,
    });

    expect(memory.tone).toEqual({ source: "observed", value: "casual" });
    expect(memory.emojiUsage).toEqual({ source: "observed", value: "light" });
  });

  it("uses explicit-only style when there is no observed style at all", () => {
    const memory = resolveEffectiveSpeakerMemory({
      observed: {},
      explicit: { tone: "formal", emojiUsage: "none" },
      corrections: NO_CORRECTIONS,
    });

    expect(memory.tone).toEqual({ source: "explicit", value: "formal" });
    expect(memory.emojiUsage).toEqual({ source: "explicit", value: "none" });
  });

  it("resolves to 'none' on both axes when there is no memory at all", () => {
    const memory = resolveEffectiveSpeakerMemory({
      observed: {},
      explicit: {},
      corrections: NO_CORRECTIONS,
    });

    expect(memory.tone).toEqual({ source: "none" });
    expect(memory.emojiUsage).toEqual({ source: "none" });
    expect(memory.applicableCorrections).toEqual([]);
  });

  it("carries corrections through unchanged, independent of the style priority axis", () => {
    const corrections: TranslationCorrection[] = [
      {
        sourceLanguage: "ja",
        targetLanguage: "pt-br",
        sourceTerm: "synthetic",
        targetTerm: "sintético",
      },
    ];

    const memory = resolveEffectiveSpeakerMemory({
      observed: { tone: "casual" },
      explicit: { tone: "formal" },
      corrections,
    });

    expect(memory.applicableCorrections).toEqual(corrections);
  });
});

describe("selectApplicableCorrections", () => {
  const baseCorrection = (sourceTerm: string): TranslationCorrection => ({
    sourceLanguage: "ja",
    targetLanguage: "pt-br",
    sourceTerm,
    targetTerm: `${sourceTerm}-rendering`,
  });

  it("keeps only corrections whose source term literally appears in the message", () => {
    const corrections = [baseCorrection("synthetic-match"), baseCorrection("synthetic-no-match")];

    const selected = selectApplicableCorrections(
      corrections,
      "a message with synthetic-match in it",
    );

    expect(selected).toEqual([baseCorrection("synthetic-match")]);
  });

  it("returns an empty array when no correction's source term matches", () => {
    const corrections = [baseCorrection("unrelated-term")];

    expect(selectApplicableCorrections(corrections, "a message with nothing relevant")).toEqual([]);
  });

  it("caps the result at MAX_PROMPT_CORRECTIONS", () => {
    const corrections = Array.from({ length: MAX_PROMPT_CORRECTIONS + 5 }, (_, index) =>
      baseCorrection(`term-${index}`),
    );
    const sourceText = corrections.map((correction) => correction.sourceTerm).join(" ");

    const selected = selectApplicableCorrections(corrections, sourceText);

    expect(selected).toHaveLength(MAX_PROMPT_CORRECTIONS);
  });

  it("honors a custom, lower limit", () => {
    const corrections = [baseCorrection("one"), baseCorrection("two"), baseCorrection("three")];
    const sourceText = "one two three";

    expect(selectApplicableCorrections(corrections, sourceText, 2)).toHaveLength(2);
  });

  it("preserves the input order (assumed pre-sorted by the repository layer) among matches", () => {
    const corrections = [
      baseCorrection("first"),
      baseCorrection("second"),
      baseCorrection("third"),
    ];
    const sourceText = "third first second";

    const selected = selectApplicableCorrections(corrections, sourceText);

    expect(selected.map((correction) => correction.sourceTerm)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("never mutates the input array", () => {
    const corrections = [baseCorrection("synthetic")];
    const original = [...corrections];

    selectApplicableCorrections(corrections, "synthetic");

    expect(corrections).toEqual(original);
  });
});
