import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getSpeakerPreference,
  getSpeakerPreferences,
  upsertSpeakerPreference,
} from "../../../src/infrastructure/d1/speaker-preferences";
import {
  listTranslationCorrections,
  upsertTranslationCorrection,
} from "../../../src/infrastructure/d1/translation-corrections";

/**
 * All chat/user IDs and correction terms below are obviously synthetic.
 */

const CHAT_ONE = -1009100000001;
const CHAT_TWO = -1009100000002;
const USER_ONE = 800100001;
const USER_TWO = 800100002;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM speaker_preferences"),
    env.DB.prepare("DELETE FROM translation_corrections"),
  ]);
});

describe("speaker preferences repository", () => {
  it("returns an empty preferences object when nothing is set", async () => {
    await expect(getSpeakerPreferences(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual({});
  });

  it("returns null for an unset individual preference key", async () => {
    await expect(getSpeakerPreference(env.DB, CHAT_ONE, USER_ONE, "tone")).resolves.toBeNull();
  });

  it("inserts a tone preference and reads it back", async () => {
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "tone",
      value: "formal",
    });

    await expect(getSpeakerPreference(env.DB, CHAT_ONE, USER_ONE, "tone")).resolves.toBe("formal");
    await expect(getSpeakerPreferences(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual({
      tone: "formal",
    });
  });

  it("inserts an emoji_usage preference and reads it back", async () => {
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "emoji_usage",
      value: "frequent",
    });

    await expect(getSpeakerPreferences(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual({
      emojiUsage: "frequent",
    });
  });

  it("returns both preferences together once both are set", async () => {
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "tone",
      value: "casual",
    });
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "emoji_usage",
      value: "none",
    });

    await expect(getSpeakerPreferences(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual({
      tone: "casual",
      emojiUsage: "none",
    });
  });

  it("upserts (updates value and updated_at) on a re-set of the same key", async () => {
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "tone",
      value: "casual",
    });
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "tone",
      value: "formal",
    });

    await expect(getSpeakerPreference(env.DB, CHAT_ONE, USER_ONE, "tone")).resolves.toBe("formal");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = ?3",
    )
      .bind(CHAT_ONE, USER_ONE, "tone")
      .first<number>("count");
    expect(count).toBe(1);
  });

  it("keeps preferences separate across chats for the same user", async () => {
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "tone",
      value: "casual",
    });
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_TWO,
      userId: USER_ONE,
      key: "tone",
      value: "formal",
    });

    await expect(getSpeakerPreference(env.DB, CHAT_ONE, USER_ONE, "tone")).resolves.toBe("casual");
    await expect(getSpeakerPreference(env.DB, CHAT_TWO, USER_ONE, "tone")).resolves.toBe("formal");
  });

  it("keeps preferences separate across users in the same chat", async () => {
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      key: "tone",
      value: "casual",
    });
    await upsertSpeakerPreference(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_TWO,
      key: "tone",
      value: "formal",
    });

    await expect(getSpeakerPreference(env.DB, CHAT_ONE, USER_ONE, "tone")).resolves.toBe("casual");
    await expect(getSpeakerPreference(env.DB, CHAT_ONE, USER_TWO, "tone")).resolves.toBe("formal");
  });

  it("rejects an unknown preference key at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(CHAT_ONE, USER_ONE, "favorite_color", "blue")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a value that doesn't belong to its key's enum at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(CHAT_ONE, USER_ONE, "tone", "frequent")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a chat_id of zero at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(0, USER_ONE, "tone", "casual")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a non-positive user_id at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(CHAT_ONE, 0, "tone", "casual")
        .run(),
    ).rejects.toThrow();
  });
});

describe("translation corrections repository", () => {
  it("returns an empty list when nothing is stored", async () => {
    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual([]);
  });

  it("inserts a ja -> pt-br correction and reads it back", async () => {
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "synthetic-ja-term",
      targetTerm: "termo-sintetico",
    });

    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual([
      {
        sourceLanguage: "ja",
        targetLanguage: "pt-br",
        sourceTerm: "synthetic-ja-term",
        targetTerm: "termo-sintetico",
      },
    ]);
  });

  it("inserts a pt-br -> ja correction and reads it back", async () => {
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "pt-br",
      targetLanguage: "ja",
      sourceTerm: "termo-sintetico-2",
      targetTerm: "合成用語2",
    });

    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual([
      {
        sourceLanguage: "pt-br",
        targetLanguage: "ja",
        sourceTerm: "termo-sintetico-2",
        targetTerm: "合成用語2",
      },
    ]);
  });

  it("upserts (updates target_term) on a re-submission of the same source term", async () => {
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "synthetic-term",
      targetTerm: "first-rendering",
    });
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "synthetic-term",
      targetTerm: "corrected-rendering",
    });

    const corrections = await listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.targetTerm).toBe("corrected-rendering");
  });

  it("filters by direction when requested", async () => {
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "ja-term",
      targetTerm: "pt-rendering",
    });
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "pt-br",
      targetLanguage: "ja",
      sourceTerm: "pt-term",
      targetTerm: "ja-rendering",
    });

    const jaToPtBr = await listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE, {
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
    });
    expect(jaToPtBr).toEqual([
      {
        sourceLanguage: "ja",
        targetLanguage: "pt-br",
        sourceTerm: "ja-term",
        targetTerm: "pt-rendering",
      },
    ]);

    const ptBrToJa = await listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE, {
      sourceLanguage: "pt-br",
      targetLanguage: "ja",
    });
    expect(ptBrToJa).toEqual([
      {
        sourceLanguage: "pt-br",
        targetLanguage: "ja",
        sourceTerm: "pt-term",
        targetTerm: "ja-rendering",
      },
    ]);
  });

  it("orders results deterministically: most recently updated first, then source_term", async () => {
    // updated_at has only second-level resolution (TEXT DEFAULT
    // CURRENT_TIMESTAMP, matching every other table in this schema), so
    // this test sets it explicitly via raw SQL rather than relying on
    // real wall-clock gaps between fast repository calls.
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "b-term",
      targetTerm: "b-rendering",
    });
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "a-term",
      targetTerm: "a-rendering",
    });
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "c-term",
      targetTerm: "c-rendering",
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE translation_corrections SET updated_at = ?1 WHERE chat_id = ?2 AND user_id = ?3 AND source_term = ?4",
      ).bind("2026-01-01 00:00:03", CHAT_ONE, USER_ONE, "a-term"),
      env.DB.prepare(
        "UPDATE translation_corrections SET updated_at = ?1 WHERE chat_id = ?2 AND user_id = ?3 AND source_term = ?4",
      ).bind("2026-01-01 00:00:02", CHAT_ONE, USER_ONE, "b-term"),
      env.DB.prepare(
        "UPDATE translation_corrections SET updated_at = ?1 WHERE chat_id = ?2 AND user_id = ?3 AND source_term = ?4",
      ).bind("2026-01-01 00:00:01", CHAT_ONE, USER_ONE, "c-term"),
    ]);

    const corrections = await listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE);
    expect(corrections.map((correction) => correction.sourceTerm)).toEqual([
      "a-term",
      "b-term",
      "c-term",
    ]);
  });

  it("breaks an updated_at tie by source_term ascending", async () => {
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "z-term",
      targetTerm: "z-rendering",
    });
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "y-term",
      targetTerm: "y-rendering",
    });
    await env.DB.prepare(
      "UPDATE translation_corrections SET updated_at = ?1 WHERE chat_id = ?2 AND user_id = ?3",
    )
      .bind("2026-01-01 00:00:00", CHAT_ONE, USER_ONE)
      .run();

    const corrections = await listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE);
    expect(corrections.map((correction) => correction.sourceTerm)).toEqual(["y-term", "z-term"]);
  });

  it("keeps corrections separate across chats for the same user", async () => {
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "chat-one-term",
      targetTerm: "chat-one-rendering",
    });
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_TWO,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "chat-two-term",
      targetTerm: "chat-two-rendering",
    });

    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual([
      expect.objectContaining({ sourceTerm: "chat-one-term" }),
    ]);
    await expect(listTranslationCorrections(env.DB, CHAT_TWO, USER_ONE)).resolves.toEqual([
      expect.objectContaining({ sourceTerm: "chat-two-term" }),
    ]);
  });

  it("keeps corrections separate across users in the same chat", async () => {
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "user-one-term",
      targetTerm: "user-one-rendering",
    });
    await upsertTranslationCorrection(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_TWO,
      sourceLanguage: "ja",
      targetLanguage: "pt-br",
      sourceTerm: "user-two-term",
      targetTerm: "user-two-rendering",
    });

    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual([
      expect.objectContaining({ sourceTerm: "user-one-term" }),
    ]);
    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_TWO)).resolves.toEqual([
      expect.objectContaining({ sourceTerm: "user-two-term" }),
    ]);
  });

  it("rejects a same-language direction (ja -> ja) at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(CHAT_ONE, USER_ONE, "ja", "ja", "term", "rendering")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an 'other' language direction at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(CHAT_ONE, USER_ONE, "other", "ja", "term", "rendering")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an empty (whitespace-only) source_term at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(CHAT_ONE, USER_ONE, "ja", "pt-br", "   ", "rendering")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an empty (whitespace-only) target_term at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(CHAT_ONE, USER_ONE, "ja", "pt-br", "term", "   ")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a source_term longer than the 100-character ceiling at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(CHAT_ONE, USER_ONE, "ja", "pt-br", "x".repeat(101), "rendering")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects a target_term longer than the 100-character ceiling at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(CHAT_ONE, USER_ONE, "ja", "pt-br", "term", "x".repeat(101))
        .run(),
    ).rejects.toThrow();
  });

  it("accepts a source_term exactly at the 100-character ceiling", async () => {
    await expect(
      upsertTranslationCorrection(env.DB, {
        chatId: CHAT_ONE,
        userId: USER_ONE,
        sourceLanguage: "ja",
        targetLanguage: "pt-br",
        sourceTerm: "x".repeat(100),
        targetTerm: "rendering",
      }),
    ).resolves.toBeUndefined();
  });
});
