import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";

/**
 * All IDs and text below are obviously synthetic — no real Telegram
 * chat/user ID and no real family message ever appears in this file.
 */

const WEBHOOK_SECRET = "synthetic-test-webhook-secret-001";
const CHAT_ID = -1008000000001;
const USER_ID = 750000001;

interface RawUpdateFixture {
  update_id: number;
  message: Record<string, unknown>;
}

function buildUpdate(
  overrides: {
    updateId?: number;
    text?: unknown;
    isBot?: boolean;
    chatId?: number;
  } = {},
): RawUpdateFixture {
  const {
    updateId = 930000001,
    text = "こんにちは、元気ですか?",
    isBot = false,
    chatId = CHAT_ID,
  } = overrides;

  return {
    update_id: updateId,
    message: {
      message_id: 610000001,
      date: 1700000000,
      chat: { id: chatId, type: "group" },
      from: { id: USER_ID, is_bot: isBot, first_name: "Test User" },
      text,
    },
  };
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, ...overrides };
}

function webhookRequest(body: unknown, secretHeader?: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (secretHeader !== null) {
    headers.set("X-Telegram-Bot-Api-Secret-Token", secretHeader ?? WEBHOOK_SECRET);
  }
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function callWorker(request: Request, envValue: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, envValue, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM processed_updates"),
    env.DB.prepare("DELETE FROM allowed_chats"),
  ]);
});

describe("POST /telegram/webhook — secret verification", () => {
  it("accepts a request with the correct secret for an allowlisted chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ID).run();

    const response = await callWorker(webhookRequest(buildUpdate()), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "accepted" });
  });

  it("rejects a request missing the secret header", async () => {
    const response = await callWorker(webhookRequest(buildUpdate(), null), testEnv());
    expect(response.status).toBe(401);
  });

  it("rejects a request with a mismatched secret", async () => {
    const response = await callWorker(webhookRequest(buildUpdate(), "wrong-secret"), testEnv());
    expect(response.status).toBe(401);
  });

  it("fails safely (401) when TELEGRAM_WEBHOOK_SECRET is not configured", async () => {
    // The real `env` (no override) has no TELEGRAM_WEBHOOK_SECRET set, since
    // it's not registered — that's exactly the "not configured" case.
    const response = await callWorker(webhookRequest(buildUpdate()), env);
    expect(response.status).toBe(401);
  });

  it("fails safely (401) when TELEGRAM_WEBHOOK_SECRET is an empty string", async () => {
    const response = await callWorker(
      webhookRequest(buildUpdate()),
      testEnv({ TELEGRAM_WEBHOOK_SECRET: "" }),
    );
    expect(response.status).toBe(401);
  });

  it("never touches D1 on an authentication failure", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ID).run();

    await callWorker(webhookRequest(buildUpdate(), "wrong-secret"), testEnv());

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM processed_updates",
    ).first<number>("count");
    expect(count).toBe(0);
  });
});

describe("POST /telegram/webhook — payload validation", () => {
  it("rejects malformed JSON with 400", async () => {
    const response = await callWorker(webhookRequest("{not-valid-json"), testEnv());
    expect(response.status).toBe(400);
  });

  it("rejects a structurally invalid Telegram Update with 400", async () => {
    const response = await callWorker(webhookRequest({ message: {} }), testEnv());
    expect(response.status).toBe(400);
  });
});

describe("POST /telegram/webhook — ignored-but-accepted updates", () => {
  it("ignores an unsupported update (no text field) with 200", async () => {
    const update = buildUpdate();
    delete update.message.text;

    const response = await callWorker(webhookRequest(update), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:unsupported" });
  });

  it("ignores a message sent by the bot itself with 200", async () => {
    const response = await callWorker(webhookRequest(buildUpdate({ isBot: true })), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:self" });
  });

  it("ignores an update from a chat that was never allowlisted, with 200", async () => {
    const response = await callWorker(webhookRequest(buildUpdate()), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:not-allowlisted" });
  });

  it("ignores an update from a disabled (soft-deleted) chat with 200", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id, enabled) VALUES (?1, 0)")
      .bind(CHAT_ID)
      .run();

    const response = await callWorker(webhookRequest(buildUpdate()), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:not-allowlisted" });
  });

  it("accepts the first valid update and records it for dedupe", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ID).run();

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000002 })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "accepted" });

    const recorded = await env.DB.prepare(
      "SELECT 1 AS found FROM processed_updates WHERE update_id = ?1",
    )
      .bind(930000002)
      .first();
    expect(recorded).not.toBeNull();
  });

  it("treats a redelivered update_id as a duplicate on the second delivery", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ID).run();

    const first = await callWorker(webhookRequest(buildUpdate({ updateId: 930000003 })), testEnv());
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ outcome: "accepted" });

    const second = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000003 })),
      testEnv(),
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ outcome: "ignored:duplicate" });
  });

  it("handles a negative group chat_id correctly end to end", async () => {
    const negativeChatId = -1007777777777;
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)")
      .bind(negativeChatId)
      .run();

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000004, chatId: negativeChatId })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "accepted" });
  });
});

describe("POST /telegram/webhook — D1 failure handling", () => {
  it("returns 500 (never a 2xx) when D1 access fails", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });

    try {
      const response = await callWorker(webhookRequest(buildUpdate()), testEnv());
      expect(response.status).toBe(500);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("existing routes are unaffected by the webhook boundary", () => {
  it("GET /health still returns 200 with the expected body", async () => {
    const response = await callWorker(new Request("https://example.com/health"), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "telegram-translation-ptbr-ja",
    });
  });

  it("unknown paths still return 404", async () => {
    const response = await callWorker(new Request("https://example.com/nope"), testEnv());
    expect(response.status).toBe(404);
  });

  it("GET /telegram/webhook (wrong method) returns 404, not the webhook handler", async () => {
    const response = await callWorker(
      new Request("https://example.com/telegram/webhook"),
      testEnv(),
    );
    expect(response.status).toBe(404);
  });
});
