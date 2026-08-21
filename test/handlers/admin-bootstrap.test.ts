import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";

/**
 * Phase 8A: `POST /admin/bootstrap` end to end. Every test that could
 * reach the network installs a `globalThis.fetch` spy that throws on any
 * call — this endpoint must never call Telegram or OpenAI. All IDs and
 * Secret-shaped values below are obviously synthetic.
 */

const SETUP_ADMIN_SECRET = "synthetic-setup-admin-secret-e2e-001";
const HEADER = "X-Setup-Admin-Secret";
const ADMIN_USER_ID = 800400001;
const CHAT_ID = -1008400001;

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, SETUP_ADMIN_SECRET, ...overrides };
}

/** The base `env` never has `SETUP_ADMIN_SECRET` set (it's a Secret, not a `wrangler.jsonc` var) — this omits it entirely, rather than setting it to `undefined`, which `exactOptionalPropertyTypes` forbids. */
function testEnvWithoutSetupSecret(): Env {
  return { ...env };
}

function bootstrapRequest(body: unknown, options: { secretHeader?: string | null } = {}): Request {
  const { secretHeader = SETUP_ADMIN_SECRET } = options;
  const headers = new Headers({ "content-type": "application/json" });
  if (secretHeader !== null) {
    headers.set(HEADER, secretHeader);
  }
  return new Request("https://example.com/admin/bootstrap", {
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

function throwingFetchSpy() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    throw new Error(`unexpected fetch call in test: ${url}`);
  });
}

/** Mirrors telegram-webhook-security.test.ts's D1-outage fake. */
function mockD1PrepareFailureFor(matchSubstring: string) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(matchSubstring)) {
      throw new Error("synthetic D1 outage");
    }
    return originalPrepare(query);
  });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bot_admins"),
    env.DB.prepare("DELETE FROM allowed_chats"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /admin/bootstrap — authentication", () => {
  it("rejects a request when SETUP_ADMIN_SECRET is not configured, before any D1 access", async () => {
    const fetchSpy = throwingFetchSpy();
    const response = await callWorker(
      bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }),
      testEnvWithoutSetupSecret(),
    );

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isBotAdminRow(ADMIN_USER_ID)).resolves.toBe(false);
  });

  it("rejects a request missing the auth header, before the body is read or any D1 access", async () => {
    const fetchSpy = throwingFetchSpy();
    const response = await callWorker(
      bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }, { secretHeader: null }),
      testEnv(),
    );

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isBotAdminRow(ADMIN_USER_ID)).resolves.toBe(false);
  });

  it("rejects a request with the wrong secret, before any D1 access", async () => {
    const fetchSpy = throwingFetchSpy();
    const response = await callWorker(
      bootstrapRequest(
        { adminUserId: ADMIN_USER_ID, chatId: CHAT_ID },
        { secretHeader: "wrong-secret-value-not-the-real-one" },
      ),
      testEnv(),
    );

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isBotAdminRow(ADMIN_USER_ID)).resolves.toBe(false);
  });

  it("returns a generic 401 body with no detail about the mechanism", async () => {
    const response = await callWorker(
      bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }, { secretHeader: null }),
      testEnv(),
    );
    await expect(response.json()).resolves.toEqual({
      error: { message: "Unauthorized", code: "UNAUTHORIZED" },
    });
  });
});

describe("POST /admin/bootstrap — request validation", () => {
  it("rejects malformed JSON with 400", async () => {
    const response = await callWorker(bootstrapRequest("not valid json {"), testEnv());
    expect(response.status).toBe(400);
  });

  it("rejects an invalid adminUserId with 400", async () => {
    const response = await callWorker(
      bootstrapRequest({ adminUserId: -1, chatId: CHAT_ID }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    await expect(isBotAdminRow(ADMIN_USER_ID)).resolves.toBe(false);
  });

  it("rejects an invalid chatId with 400", async () => {
    const response = await callWorker(
      bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: 0 }),
      testEnv(),
    );
    expect(response.status).toBe(400);
    await expect(chatEnabled(CHAT_ID)).resolves.toBeNull();
  });

  it("rejects a missing adminUserId with 400", async () => {
    const response = await callWorker(bootstrapRequest({ chatId: CHAT_ID }), testEnv());
    expect(response.status).toBe(400);
  });
});

describe("POST /admin/bootstrap — successful bootstrap", () => {
  it("registers the admin and enables the chat, returning a generic 200 body", async () => {
    const fetchSpy = throwingFetchSpy();
    const response = await callWorker(
      bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", result: "bootstrap-complete" });
    await expect(isBotAdminRow(ADMIN_USER_ID)).resolves.toBe(true);
    await expect(chatEnabled(CHAT_ID)).resolves.toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("repeating the same request is idempotent — no duplicate rows, still 200", async () => {
    await callWorker(bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }), testEnv());
    const second = await callWorker(
      bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }),
      testEnv(),
    );

    expect(second.status).toBe(200);
    const adminCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bot_admins WHERE user_id = ?1",
    )
      .bind(ADMIN_USER_ID)
      .first<number>("count");
    expect(adminCount).toBe(1);
  });

  it("re-enables a pre-existing disabled chat", async () => {
    await env.DB.prepare("INSERT INTO allowed_chats (chat_id, enabled) VALUES (?1, 0)")
      .bind(CHAT_ID)
      .run();

    const response = await callWorker(
      bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(chatEnabled(CHAT_ID)).resolves.toBe(1);
  });
});

describe("POST /admin/bootstrap — D1 failure handling", () => {
  it("returns a generic 500 on a transient D1 failure, with no Secret or raw error leak", async () => {
    const failingPrepare = mockD1PrepareFailureFor("INSERT INTO bot_admins");
    try {
      const response = await callWorker(
        bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }),
        testEnv(),
      );
      expect(response.status).toBe(500);
      const bodyText = await response.clone().text();
      await expect(response.json()).resolves.toEqual({
        error: { message: "Internal Server Error", code: "INTERNAL_ERROR" },
      });
      expect(bodyText).not.toContain(SETUP_ADMIN_SECRET);
      expect(bodyText).not.toContain("synthetic D1 outage");
    } finally {
      failingPrepare.mockRestore();
    }
  });
});

describe("POST /admin/bootstrap — routing isolation", () => {
  it("is not reachable via GET", async () => {
    const headers = new Headers({ [HEADER]: SETUP_ADMIN_SECRET });
    const response = await callWorker(
      new Request("https://example.com/admin/bootstrap", { method: "GET", headers }),
      testEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("does not disturb the existing /health route", async () => {
    const response = await callWorker(
      new Request("https://example.com/health", { method: "GET" }),
      testEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("does not disturb the existing /telegram/webhook route (still requires its own secret)", async () => {
    const response = await callWorker(
      new Request("https://example.com/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      }),
      testEnv(),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /admin/bootstrap — structured logging", () => {
  it("never logs the setup secret, the submitted adminUserId/chatId, or a raw error message", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const failingPrepare = mockD1PrepareFailureFor("INSERT INTO bot_admins");

    try {
      await callWorker(
        bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }),
        testEnv(),
      );
    } finally {
      failingPrepare.mockRestore();
    }
    await callWorker(bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }), testEnv());

    const loggedLines = consoleSpy.mock.calls.map((call) => call.join(" "));
    for (const line of loggedLines) {
      expect(line).not.toContain(SETUP_ADMIN_SECRET);
      expect(line).not.toContain(String(ADMIN_USER_ID));
      expect(line).not.toContain(String(CHAT_ID));
      expect(line).not.toContain("synthetic D1 outage");
    }
    consoleSpy.mockRestore();
  });

  it("logs exactly one structured line for a successful bootstrap", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callWorker(bootstrapRequest({ adminUserId: ADMIN_USER_ID, chatId: CHAT_ID }), testEnv());

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed.event).toBe("admin_bootstrap");
    expect(parsed.outcome).toBe("bootstrap-complete");
    expect(parsed.status).toBe(200);
    expect(parsed).not.toHaveProperty("adminUserId");
    expect(parsed).not.toHaveProperty("chatId");
    consoleSpy.mockRestore();
  });
});
