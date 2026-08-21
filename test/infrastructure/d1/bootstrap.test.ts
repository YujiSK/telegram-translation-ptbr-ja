import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapAdminAndChat } from "../../../src/infrastructure/d1/bootstrap";
import { TransientUpstreamError } from "../../../src/shared/errors";

/** All IDs below are obviously synthetic — never a real Telegram user/chat ID. */
const ADMIN_USER_ID = 800300001;
const CHAT_ID = -1008300001;
const OTHER_ADMIN_USER_ID = 800300002;
const OTHER_CHAT_ID = -1008300002;

async function isBotAdminRow(userId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS found FROM bot_admins WHERE user_id = ?1")
    .bind(userId)
    .first();
  return row !== null;
}

async function chatEnabled(chatId: number): Promise<number | null> {
  return env.DB.prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1")
    .bind(chatId)
    .first<number>("enabled");
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bot_admins"),
    env.DB.prepare("DELETE FROM allowed_chats"),
  ]);
});

describe("bootstrapAdminAndChat", () => {
  it("registers a new admin and a new enabled chat", async () => {
    await bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, CHAT_ID);

    await expect(isBotAdminRow(ADMIN_USER_ID)).resolves.toBe(true);
    await expect(chatEnabled(CHAT_ID)).resolves.toBe(1);
  });

  it("is idempotent: repeating the same call creates no duplicate rows", async () => {
    await bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, CHAT_ID);
    await bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, CHAT_ID);

    const adminCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bot_admins WHERE user_id = ?1",
    )
      .bind(ADMIN_USER_ID)
      .first<number>("count");
    const chatCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM allowed_chats WHERE chat_id = ?1",
    )
      .bind(CHAT_ID)
      .first<number>("count");
    expect(adminCount).toBe(1);
    expect(chatCount).toBe(1);
  });

  it("re-enables a pre-existing disabled chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id, enabled) VALUES (?1, 0)")
      .bind(CHAT_ID)
      .run();

    await bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, CHAT_ID);

    await expect(chatEnabled(CHAT_ID)).resolves.toBe(1);
  });

  it("does not duplicate an already-registered admin when bootstrapping a second chat", async () => {
    await bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, CHAT_ID);
    await bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, OTHER_CHAT_ID);

    const adminCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bot_admins WHERE user_id = ?1",
    )
      .bind(ADMIN_USER_ID)
      .first<number>("count");
    expect(adminCount).toBe(1);
    await expect(chatEnabled(CHAT_ID)).resolves.toBe(1);
    await expect(chatEnabled(OTHER_CHAT_ID)).resolves.toBe(1);
  });

  it("does not affect an unrelated admin or chat", async () => {
    await bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, CHAT_ID);

    await expect(isBotAdminRow(OTHER_ADMIN_USER_ID)).resolves.toBe(false);
    await expect(chatEnabled(OTHER_CHAT_ID)).resolves.toBeNull();
  });

  it("classifies a raw D1 batch failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(bootstrapAdminAndChat(env.DB, ADMIN_USER_ID, CHAT_ID)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }

    await expect(isBotAdminRow(ADMIN_USER_ID)).resolves.toBe(false);
    await expect(chatEnabled(CHAT_ID)).resolves.toBeNull();
  });
});
