import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { forgetSpeakerData } from "../../../src/infrastructure/d1/forget-me";
import {
  getSpeakerProfile,
  upsertObservedSpeakerStyle,
} from "../../../src/infrastructure/d1/speaker-profiles";
import {
  getSpeakerPreferences,
  upsertSpeakerPreference,
} from "../../../src/infrastructure/d1/speaker-preferences";
import {
  listTranslationCorrections,
  upsertTranslationCorrection,
} from "../../../src/infrastructure/d1/translation-corrections";
import { TransientUpstreamError } from "../../../src/shared/errors";

/** All chat/user IDs below are obviously synthetic. */
const CHAT_ONE = -1009300000001;
const CHAT_TWO = -1009300000002;
const USER_ONE = 800300001;
const USER_TWO = 800300002;

async function seedFullSpeakerData(chatId: number, userId: number): Promise<void> {
  await upsertObservedSpeakerStyle(env.DB, {
    chatId,
    userId,
    displayName: "Synthetic Speaker",
    primaryLanguage: "ja",
    observedTone: "casual",
    observedEmojiUsage: "light",
  });
  await upsertSpeakerPreference(env.DB, { chatId, userId, key: "tone", value: "formal" });
  await upsertTranslationCorrection(env.DB, {
    chatId,
    userId,
    sourceLanguage: "ja",
    targetLanguage: "pt-br",
    sourceTerm: "synthetic-term",
    targetTerm: "termo-sintetico",
  });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM speaker_preferences"),
    env.DB.prepare("DELETE FROM translation_corrections"),
    env.DB.prepare("DELETE FROM speaker_profiles"),
  ]);
});

describe("forgetSpeakerData — Phase 6 /forgetme confirm", () => {
  it("deletes the profile, preferences, and corrections for the scoped (chat, user)", async () => {
    await seedFullSpeakerData(CHAT_ONE, USER_ONE);

    await forgetSpeakerData(env.DB, CHAT_ONE, USER_ONE);

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toBeNull();
    await expect(getSpeakerPreferences(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual({});
    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_ONE)).resolves.toEqual([]);
  });

  it("is idempotent when nothing was ever stored", async () => {
    await expect(forgetSpeakerData(env.DB, CHAT_ONE, USER_ONE)).resolves.toBeUndefined();
  });

  it("never touches another user's data in the same chat", async () => {
    await seedFullSpeakerData(CHAT_ONE, USER_ONE);
    await seedFullSpeakerData(CHAT_ONE, USER_TWO);

    await forgetSpeakerData(env.DB, CHAT_ONE, USER_ONE);

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_TWO)).resolves.not.toBeNull();
    await expect(getSpeakerPreferences(env.DB, CHAT_ONE, USER_TWO)).resolves.toEqual({
      tone: "formal",
    });
    await expect(listTranslationCorrections(env.DB, CHAT_ONE, USER_TWO)).resolves.toHaveLength(1);
  });

  it("never touches the same user's data in another chat", async () => {
    await seedFullSpeakerData(CHAT_ONE, USER_ONE);
    await seedFullSpeakerData(CHAT_TWO, USER_ONE);

    await forgetSpeakerData(env.DB, CHAT_ONE, USER_ONE);

    await expect(getSpeakerProfile(env.DB, CHAT_TWO, USER_ONE)).resolves.not.toBeNull();
    await expect(getSpeakerPreferences(env.DB, CHAT_TWO, USER_ONE)).resolves.toEqual({
      tone: "formal",
    });
    await expect(listTranslationCorrections(env.DB, CHAT_TWO, USER_ONE)).resolves.toHaveLength(1);
  });

  it("never touches allowed_chats, processed_updates, or bot_admins", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ONE).run();
    await env.DB.prepare("INSERT INTO processed_updates (update_id) VALUES (?1)").bind(1).run();
    await env.DB.prepare("INSERT INTO bot_admins (user_id) VALUES (?1)").bind(USER_ONE).run();
    await seedFullSpeakerData(CHAT_ONE, USER_ONE);

    try {
      await forgetSpeakerData(env.DB, CHAT_ONE, USER_ONE);

      const allowedChatCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM allowed_chats WHERE chat_id = ?1",
      )
        .bind(CHAT_ONE)
        .first<number>("count");
      expect(allowedChatCount).toBe(1);

      const processedUpdateCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM processed_updates WHERE update_id = ?1",
      )
        .bind(1)
        .first<number>("count");
      expect(processedUpdateCount).toBe(1);

      const botAdminCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM bot_admins WHERE user_id = ?1",
      )
        .bind(USER_ONE)
        .first<number>("count");
      expect(botAdminCount).toBe(1);
    } finally {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM processed_updates"),
        env.DB.prepare("DELETE FROM allowed_chats"),
        env.DB.prepare("DELETE FROM bot_admins"),
      ]);
    }
  });

  it("rolls back the whole batch (all-or-nothing) if one statement fails", async () => {
    await seedFullSpeakerData(CHAT_ONE, USER_ONE);
    const batchSpy = vi.spyOn(env.DB, "batch").mockImplementation(() => {
      throw new Error("synthetic mid-batch D1 failure");
    });

    try {
      await expect(forgetSpeakerData(env.DB, CHAT_ONE, USER_ONE)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      batchSpy.mockRestore();
    }

    // Nothing was actually deleted, since the real batch() never ran.
    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.not.toBeNull();
  });

  it("classifies a raw D1 batch failure as transient", async () => {
    const batchSpy = vi.spyOn(env.DB, "batch").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(forgetSpeakerData(env.DB, CHAT_ONE, USER_ONE)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      batchSpy.mockRestore();
    }
  });
});
