import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAllowedChatState,
  isChatAllowed,
  setAllowedChatEnabled,
} from "../../../src/infrastructure/d1/allowed-chats";
import {
  hasProcessedUpdate,
  recordUpdateIfNew,
  releaseProcessedUpdate,
} from "../../../src/infrastructure/d1/processed-updates";
import {
  getSpeakerProfile,
  upsertObservedSpeakerStyle,
  upsertSpeakerProfile,
} from "../../../src/infrastructure/d1/speaker-profiles";
import { TransientUpstreamError } from "../../../src/shared/errors";

const CHAT_ONE = -1009000000001;
const CHAT_TWO = -1009000000002;
const USER_ONE = 800000001;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM speaker_preferences"),
    env.DB.prepare("DELETE FROM translation_corrections"),
    env.DB.prepare("DELETE FROM speaker_profiles"),
    env.DB.prepare("DELETE FROM processed_updates"),
    env.DB.prepare("DELETE FROM allowed_chats"),
  ]);
});

describe("D1 migrations 0001–0004 applied in order", () => {
  it("creates every Phase 2, Phase 5, Phase 6, and Phase 7 table plus the migration ledger", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('allowed_chats', 'processed_updates', 'speaker_profiles', 'speaker_preferences', 'translation_corrections', 'bot_admins', 'rate_limit_counters', 'openai_daily_usage', 'd1_migrations') ORDER BY name",
    ).all();

    expect(rows.results.map((row) => row.name)).toEqual([
      "allowed_chats",
      "bot_admins",
      "d1_migrations",
      "openai_daily_usage",
      "processed_updates",
      "rate_limit_counters",
      "speaker_preferences",
      "speaker_profiles",
      "translation_corrections",
    ]);
  });

  it("recorded all four migrations in the ledger", async () => {
    const rows = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
    expect(rows.results.map((row) => row.name)).toEqual([
      "0001_initial.sql",
      "0002_speaker_memory.sql",
      "0003_commands.sql",
      "0004_reliability.sql",
    ]);
  });

  it("keeps a Phase 2-shaped insert (no observed columns) working after the Phase 5 migration", async () => {
    // Simulates "an existing row survives the migration": the Phase 2
    // column set alone must still be a valid insert once 0002 has added
    // observed_tone/observed_emoji_usage as nullable columns.
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(CHAT_ONE, USER_ONE, "Pre-Phase-5 Speaker", "ja")
      .run();

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      displayName: "Pre-Phase-5 Speaker",
      primaryLanguage: "ja",
      observedTone: null,
      observedEmojiUsage: null,
    });
  });
});

describe("allowed chats repository", () => {
  it("returns true for an enabled allowlisted chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id, label) VALUES (?1, ?2)")
      .bind(CHAT_ONE, "Synthetic family group")
      .run();

    await expect(isChatAllowed(env.DB, CHAT_ONE)).resolves.toBe(true);
  });

  it("returns false for a missing chat", async () => {
    await expect(isChatAllowed(env.DB, CHAT_ONE)).resolves.toBe(false);
  });

  it("returns false for a disabled chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id, label, enabled) VALUES (?1, ?2, 0)")
      .bind(CHAT_ONE, "Disabled synthetic group")
      .run();

    await expect(isChatAllowed(env.DB, CHAT_ONE)).resolves.toBe(false);
  });
});

describe("allowed chats repository — Phase 6 three-state read and setAllowedChatEnabled", () => {
  it("returns 'missing' for a chat with no row", async () => {
    await expect(getAllowedChatState(env.DB, CHAT_ONE)).resolves.toBe("missing");
  });

  it("returns 'enabled' for an enabled chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ONE).run();
    await expect(getAllowedChatState(env.DB, CHAT_ONE)).resolves.toBe("enabled");
  });

  it("returns 'disabled' for a chat with an existing but disabled row", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id, enabled) VALUES (?1, 0)")
      .bind(CHAT_ONE)
      .run();
    await expect(getAllowedChatState(env.DB, CHAT_ONE)).resolves.toBe("disabled");
  });

  it("setAllowedChatEnabled(false) disables an existing enabled chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ONE).run();

    await setAllowedChatEnabled(env.DB, CHAT_ONE, false);

    await expect(getAllowedChatState(env.DB, CHAT_ONE)).resolves.toBe("disabled");
  });

  it("setAllowedChatEnabled(true) re-enables an existing disabled chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id, enabled) VALUES (?1, 0)")
      .bind(CHAT_ONE)
      .run();

    await setAllowedChatEnabled(env.DB, CHAT_ONE, true);

    await expect(getAllowedChatState(env.DB, CHAT_ONE)).resolves.toBe("enabled");
  });

  it("setAllowedChatEnabled never creates a row for a chat that was never allowlisted", async () => {
    await setAllowedChatEnabled(env.DB, CHAT_ONE, true);

    await expect(getAllowedChatState(env.DB, CHAT_ONE)).resolves.toBe("missing");
  });

  it("only changes the targeted chat, leaving others untouched", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ONE).run();
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_TWO).run();

    await setAllowedChatEnabled(env.DB, CHAT_ONE, false);

    await expect(getAllowedChatState(env.DB, CHAT_ONE)).resolves.toBe("disabled");
    await expect(getAllowedChatState(env.DB, CHAT_TWO)).resolves.toBe("enabled");
  });
});

describe("processed updates repository", () => {
  it("records the first delivery and rejects a duplicate atomically", async () => {
    await expect(recordUpdateIfNew(env.DB, 910000001)).resolves.toBe(true);
    await expect(hasProcessedUpdate(env.DB, 910000001)).resolves.toBe(true);
    await expect(recordUpdateIfNew(env.DB, 910000001)).resolves.toBe(false);
  });

  it("reports an unseen update as not processed", async () => {
    await expect(hasProcessedUpdate(env.DB, 910000002)).resolves.toBe(false);
  });

  it("enforces update_id uniqueness at the SQL boundary", async () => {
    await env.DB.prepare("INSERT INTO processed_updates (update_id) VALUES (?1)")
      .bind(910000003)
      .run();

    await expect(
      env.DB.prepare("INSERT INTO processed_updates (update_id) VALUES (?1)").bind(910000003).run(),
    ).rejects.toThrow();
  });

  // Phase 7: explicit concurrency verification for the same primitive the
  // webhook relies on to guarantee "exactly once" processing under a
  // near-simultaneous Telegram redelivery — see docs/architecture.md,
  // "Concurrent dedupe verification".
  it("under concurrent delivery, exactly one of several simultaneous reservations for the same update_id succeeds", async () => {
    const updateId = 910000009;
    const attempts = 8;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => recordUpdateIfNew(env.DB, updateId)),
    );

    const successCount = results.filter((succeeded) => succeeded).length;
    expect(successCount).toBe(1);
    expect(results.filter((succeeded) => !succeeded)).toHaveLength(attempts - 1);

    const rowCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM processed_updates WHERE update_id = ?1",
    )
      .bind(updateId)
      .first<number>("count");
    expect(rowCount).toBe(1);
  });

  it("under concurrent delivery for distinct update_ids, every reservation succeeds independently", async () => {
    const updateIds = [910000010, 910000011, 910000012, 910000013];

    const results = await Promise.all(updateIds.map((id) => recordUpdateIfNew(env.DB, id)));

    expect(results).toEqual([true, true, true, true]);
  });
});

describe("releaseProcessedUpdate — dedupe reservation release", () => {
  it("removes a reservation and returns true so a redelivery can be reprocessed", async () => {
    await expect(recordUpdateIfNew(env.DB, 910000004)).resolves.toBe(true);

    await expect(releaseProcessedUpdate(env.DB, 910000004)).resolves.toBe(true);

    await expect(hasProcessedUpdate(env.DB, 910000004)).resolves.toBe(false);
    await expect(recordUpdateIfNew(env.DB, 910000004)).resolves.toBe(true);
  });

  it("returns false without erroring when releasing an update that was never recorded", async () => {
    await expect(releaseProcessedUpdate(env.DB, 910000005)).resolves.toBe(false);
  });

  it("returns false (not an error) when releasing the same reservation twice", async () => {
    await recordUpdateIfNew(env.DB, 910000006);

    await expect(releaseProcessedUpdate(env.DB, 910000006)).resolves.toBe(true);
    await expect(releaseProcessedUpdate(env.DB, 910000006)).resolves.toBe(false);
  });

  it("only releases the targeted update_id, leaving other reservations intact", async () => {
    await recordUpdateIfNew(env.DB, 910000007);
    await recordUpdateIfNew(env.DB, 910000008);

    await releaseProcessedUpdate(env.DB, 910000007);

    await expect(hasProcessedUpdate(env.DB, 910000007)).resolves.toBe(false);
    await expect(hasProcessedUpdate(env.DB, 910000008)).resolves.toBe(true);
  });
});

describe("speaker profiles repository", () => {
  it("returns null for a missing profile", async () => {
    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toBeNull();
  });

  it("inserts and reads a profile round-trip", async () => {
    await upsertSpeakerProfile(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
    });

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
    });
  });

  it("updates an existing profile with the same composite key", async () => {
    await upsertSpeakerProfile(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
    });
    await upsertSpeakerProfile(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Updated Synthetic Speaker",
      primaryLanguage: "pt-br",
    });

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      displayName: "Updated Synthetic Speaker",
      primaryLanguage: "pt-br",
    });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ONE, USER_ONE)
      .first<number>("count");
    expect(count).toBe(1);
  });

  it("keeps the same user separate across chats", async () => {
    await upsertSpeakerProfile(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Speaker in chat one",
      primaryLanguage: "ja",
    });
    await upsertSpeakerProfile(env.DB, {
      chatId: CHAT_TWO,
      userId: USER_ONE,
      displayName: "Speaker in chat two",
      primaryLanguage: "pt-br",
    });

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      displayName: "Speaker in chat one",
    });
    await expect(getSpeakerProfile(env.DB, CHAT_TWO, USER_ONE)).resolves.toMatchObject({
      displayName: "Speaker in chat two",
    });
  });

  it("enforces the composite primary key at the SQL boundary", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name) VALUES (?1, ?2, ?3)",
    );
    await insert.bind(CHAT_ONE, USER_ONE, "Synthetic Speaker").run();

    await expect(
      insert.bind(CHAT_ONE, USER_ONE, "Duplicate Synthetic Speaker").run(),
    ).rejects.toThrow();
  });
});

describe("speaker profiles repository — Phase 5 observed style", () => {
  it("returns null observed fields for a profile that predates any observation", async () => {
    await upsertSpeakerProfile(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
    });

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      observedTone: null,
      observedEmojiUsage: null,
    });
  });

  it("inserts a fresh profile with observed style via upsertObservedSpeakerStyle", async () => {
    await upsertObservedSpeakerStyle(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
      observedTone: "casual",
      observedEmojiUsage: "light",
    });

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
      observedTone: "casual",
      observedEmojiUsage: "light",
    });
  });

  it("replaces the observed style with the latest value on a second observation (no history kept)", async () => {
    await upsertObservedSpeakerStyle(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Synthetic Speaker",
      primaryLanguage: "ja",
      observedTone: "casual",
      observedEmojiUsage: "none",
    });
    await upsertObservedSpeakerStyle(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Synthetic Speaker",
      primaryLanguage: "pt-br",
      observedTone: "formal",
      observedEmojiUsage: "frequent",
    });

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      primaryLanguage: "pt-br",
      observedTone: "formal",
      observedEmojiUsage: "frequent",
    });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ONE, USER_ONE)
      .first<number>("count");
    expect(count).toBe(1);
  });

  it("keeps observed style separate across chats for the same user", async () => {
    await upsertObservedSpeakerStyle(env.DB, {
      chatId: CHAT_ONE,
      userId: USER_ONE,
      displayName: "Speaker in chat one",
      primaryLanguage: "ja",
      observedTone: "casual",
      observedEmojiUsage: "none",
    });
    await upsertObservedSpeakerStyle(env.DB, {
      chatId: CHAT_TWO,
      userId: USER_ONE,
      displayName: "Speaker in chat two",
      primaryLanguage: "pt-br",
      observedTone: "formal",
      observedEmojiUsage: "frequent",
    });

    await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).resolves.toMatchObject({
      observedTone: "casual",
      observedEmojiUsage: "none",
    });
    await expect(getSpeakerProfile(env.DB, CHAT_TWO, USER_ONE)).resolves.toMatchObject({
      observedTone: "formal",
      observedEmojiUsage: "frequent",
    });
  });

  it("rejects an invalid observed_tone at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO speaker_profiles (chat_id, user_id, display_name, observed_tone) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(CHAT_ONE, USER_ONE, "Synthetic Speaker", "very-casual")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an invalid observed_emoji_usage at the SQL boundary", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO speaker_profiles (chat_id, user_id, display_name, observed_emoji_usage) VALUES (?1, ?2, ?3, ?4)",
      )
        .bind(CHAT_ONE, USER_ONE, "Synthetic Speaker", "lots")
        .run(),
    ).rejects.toThrow();
  });

  // Phase 5 review, Issue 1: a raw D1 query/runtime failure (not a
  // malformed row) must be classified as transient and retryable, so the
  // webhook's dedupe-reservation release logic can act on it.
  it("classifies a raw D1 query failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(getSpeakerProfile(env.DB, CHAT_ONE, USER_ONE)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
