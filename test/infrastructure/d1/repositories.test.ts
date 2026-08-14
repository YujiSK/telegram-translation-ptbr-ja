import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { isChatAllowed } from "../../../src/infrastructure/d1/allowed-chats";
import {
  hasProcessedUpdate,
  recordUpdateIfNew,
  releaseProcessedUpdate,
} from "../../../src/infrastructure/d1/processed-updates";
import {
  getSpeakerProfile,
  upsertSpeakerProfile,
} from "../../../src/infrastructure/d1/speaker-profiles";

const CHAT_ONE = -1009000000001;
const CHAT_TWO = -1009000000002;
const USER_ONE = 800000001;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM speaker_profiles"),
    env.DB.prepare("DELETE FROM processed_updates"),
    env.DB.prepare("DELETE FROM allowed_chats"),
  ]);
});

describe("initial D1 migration", () => {
  it("creates the three Phase 2 tables and the migration ledger", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('allowed_chats', 'processed_updates', 'speaker_profiles', 'd1_migrations') ORDER BY name",
    ).all();

    expect(rows.results.map((row) => row.name)).toEqual([
      "allowed_chats",
      "d1_migrations",
      "processed_updates",
      "speaker_profiles",
    ]);
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
