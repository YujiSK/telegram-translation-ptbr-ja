import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isBotAdmin } from "../../../src/infrastructure/d1/bot-admins";
import { TransientUpstreamError } from "../../../src/shared/errors";

/** All user IDs below are obviously synthetic — never a real Telegram user ID. */
const ADMIN_USER = 800200001;
const NON_ADMIN_USER = 800200002;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM bot_admins").run();
});

describe("isBotAdmin", () => {
  it("returns false for a user with no bot_admins row", async () => {
    await expect(isBotAdmin(env.DB, NON_ADMIN_USER)).resolves.toBe(false);
  });

  it("returns true for a user with a bot_admins row", async () => {
    await env.DB.prepare("INSERT INTO bot_admins (user_id) VALUES (?1)").bind(ADMIN_USER).run();

    await expect(isBotAdmin(env.DB, ADMIN_USER)).resolves.toBe(true);
  });

  it("does not treat an unrelated user as an admin", async () => {
    await env.DB.prepare("INSERT INTO bot_admins (user_id) VALUES (?1)").bind(ADMIN_USER).run();

    await expect(isBotAdmin(env.DB, NON_ADMIN_USER)).resolves.toBe(false);
  });

  it("rejects a non-positive user_id at the SQL boundary", async () => {
    await expect(
      env.DB.prepare("INSERT INTO bot_admins (user_id) VALUES (?1)").bind(0).run(),
    ).rejects.toThrow();
  });

  it("classifies a raw D1 query failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(isBotAdmin(env.DB, ADMIN_USER)).rejects.toBeInstanceOf(TransientUpstreamError);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
