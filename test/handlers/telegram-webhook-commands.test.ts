import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";

/**
 * Phase 6 command surface, end to end. All IDs, Secret-shaped values, and
 * message text below are obviously synthetic. OpenAI is never reached by
 * any test in this file — a command message never triggers a translation
 * call, and every test here asserts that with a `mockFetchDispatch` spy
 * that throws on any unexpected OpenAI/Telegram call.
 */

const WEBHOOK_SECRET = "synthetic-test-webhook-secret-002";
const TELEGRAM_BOT_TOKEN = "0000000000:FAKE-TEST-COMMANDS-TOKEN-not-a-real-secret";
const CHAT_ID = -1009900000001;
const USER_ID = 790000001;
const ADMIN_USER_ID = 790000002;
const MESSAGE_ID = 640000001;

interface RawUpdateFixture {
  update_id: number;
  message: Record<string, unknown>;
}

function buildUpdate(
  overrides: {
    updateId?: number;
    text?: unknown;
    userId?: number;
    chatId?: number;
  } = {},
): RawUpdateFixture {
  const { updateId = 950000001, text = "/help", userId = USER_ID, chatId = CHAT_ID } = overrides;

  return {
    update_id: updateId,
    message: {
      message_id: MESSAGE_ID,
      date: 1700000000,
      chat: { id: chatId, type: "group" },
      from: { id: userId, is_bot: false, first_name: "Test User" },
      text,
    },
  };
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OPENAI_API_KEY: "synthetic-test-openai-key-unused-001",
    TELEGRAM_BOT_TOKEN,
    ...overrides,
  };
}

function webhookRequest(body: unknown): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
  });
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

async function isUpdateRecorded(updateId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS found FROM processed_updates WHERE update_id = ?1")
    .bind(updateId)
    .first();
  return row !== null;
}

async function allowlistChat(chatId: number = CHAT_ID, enabled = true): Promise<void> {
  await env.DB.prepare("INSERT INTO allowed_chats (chat_id, enabled) VALUES (?1, ?2)")
    .bind(chatId, enabled ? 1 : 0)
    .run();
}

async function makeAdmin(userId: number = ADMIN_USER_ID): Promise<void> {
  await env.DB.prepare("INSERT INTO bot_admins (user_id) VALUES (?1)").bind(userId).run();
}

function mockFetchDispatch(handlers: {
  openai?: (url: string, init: RequestInit) => Response | Promise<Response>;
  telegram?: (url: string, init: RequestInit) => Response | Promise<Response>;
}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.startsWith("https://api.openai.com/")) {
        if (!handlers.openai) {
          throw new Error(`unexpected OpenAI fetch call in test: ${url}`);
        }
        return handlers.openai(url, init ?? {});
      }
      if (url.startsWith("https://api.telegram.org/")) {
        if (!handlers.telegram) {
          throw new Error(`unexpected Telegram fetch call in test: ${url}`);
        }
        return handlers.telegram(url, init ?? {});
      }
      throw new Error(`unexpected fetch call to an unknown host in test: ${url}`);
    });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function telegramSendMessageResponse(messageId = 999999002): Response {
  return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: CHAT_ID } } });
}

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("expected a string request body");
  }
  return body;
}

/** Mirrors `test/handlers/telegram-webhook.test.ts`'s helper of the same name. */
function mockD1PrepareFailureFor(matchSubstring: string) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(matchSubstring)) {
      throw new Error("synthetic D1 outage");
    }
    return originalPrepare(query);
  });
}

/** Mirrors `test/handlers/telegram-webhook.test.ts`'s fixed-row fake, used to simulate a malformed D1 row. */
class FixedRowStatement implements D1PreparedStatement {
  constructor(private readonly row: Record<string, unknown> | null) {}

  bind(..._values: unknown[]): D1PreparedStatement {
    return this;
  }

  first<T = unknown>(_colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first(): Promise<unknown> {
    return Promise.resolve(this.row);
  }

  run(): never {
    throw new Error("FixedRowStatement.run() is not implemented in this test fake");
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve({
      results: (this.row === null ? [] : [this.row]) as T[],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    });
  }

  raw(): never {
    throw new Error("FixedRowStatement.raw() is not implemented in this test fake");
  }
}

function mockD1PrepareRowFor(matchSubstring: string, row: Record<string, unknown> | null) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(matchSubstring)) {
      return new FixedRowStatement(row);
    }
    return originalPrepare(query);
  });
}

async function getStoredProfile(): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    "SELECT display_name, observed_tone, observed_emoji_usage FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2",
  )
    .bind(CHAT_ID, USER_ID)
    .first();
  return row;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM speaker_preferences"),
    env.DB.prepare("DELETE FROM translation_corrections"),
    env.DB.prepare("DELETE FROM speaker_profiles"),
    env.DB.prepare("DELETE FROM processed_updates"),
    env.DB.prepare("DELETE FROM allowed_chats"),
    env.DB.prepare("DELETE FROM bot_admins"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /telegram/webhook — /help", () => {
  it("replies with the help text and never calls OpenAI", async () => {
    await allowlistChat();
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000010, text: "/help" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:handled" });
    expect(telegramHandler).toHaveBeenCalledTimes(1);
    const call = telegramHandler.mock.calls[0];
    if (call === undefined) throw new Error("expected a Telegram call");
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { text: string };
    expect(body.text).toContain("/remember");
    expect(body.text).toContain("/correct");
  });
});

describe("POST /telegram/webhook — unknown command", () => {
  it("replies 'Unknown command. Use /help.' and never calls OpenAI or D1 writes", async () => {
    await allowlistChat();
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000011, text: "/bogus" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:unknown" });
    const call = telegramHandler.mock.calls[0];
    if (call === undefined) throw new Error("expected a Telegram call");
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { text: string };
    expect(body.text).toBe("Unknown command. Use /help.");
  });
});

describe("POST /telegram/webhook — malformed command syntax", () => {
  it("replies with usage text and never writes a preference", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000012, text: "/remember tone super-formal" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:invalid" });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ID, USER_ID)
      .first<number>("count");
    expect(count).toBe(0);
  });
});

describe("POST /telegram/webhook — /remember", () => {
  it("stores an explicit tone preference", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000013, text: "/remember tone formal" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:handled" });
    const row = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = ?3",
    )
      .bind(CHAT_ID, USER_ID, "tone")
      .first<string>("preference_value");
    expect(row).toBe("formal");
  });

  it("keeps preferences scoped separately across chats for the same user", async () => {
    const otherChatId = -1009900000099;
    await allowlistChat(CHAT_ID);
    await allowlistChat(otherChatId);
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000014, text: "/remember tone formal", chatId: CHAT_ID }),
      ),
      testEnv(),
    );
    await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000015, text: "/remember tone casual", chatId: otherChatId }),
      ),
      testEnv(),
    );

    const rowOne = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(CHAT_ID, USER_ID)
      .first<string>("preference_value");
    const rowTwo = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(otherChatId, USER_ID)
      .first<string>("preference_value");
    expect(rowOne).toBe("formal");
    expect(rowTwo).toBe("casual");
  });

  it("keeps preferences scoped separately across users in the same chat", async () => {
    const otherUserId = 790000098;
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000016, text: "/remember tone formal", userId: USER_ID }),
      ),
      testEnv(),
    );
    await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000017, text: "/remember tone casual", userId: otherUserId }),
      ),
      testEnv(),
    );

    const rowOne = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(CHAT_ID, USER_ID)
      .first<string>("preference_value");
    const rowTwo = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(CHAT_ID, otherUserId)
      .first<string>("preference_value");
    expect(rowOne).toBe("formal");
    expect(rowTwo).toBe("casual");
  });
});

describe("POST /telegram/webhook — /forget", () => {
  it("removes a stored preference", async () => {
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(CHAT_ID, USER_ID, "tone", "formal")
      .run();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000018, text: "/forget tone" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:handled" });
    const row = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(CHAT_ID, USER_ID)
      .first();
    expect(row).toBeNull();
  });

  it("is idempotent (200 command:handled) when the preference was never set", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000019, text: "/forget tone" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:handled" });
  });

  it("removes exactly the scoped correction, leaving other users/chats untouched", async () => {
    const otherUserId = 790000097;
    await allowlistChat();
    await env.DB.prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, 'ja', 'pt-br', 'お母さん', 'mãe')`,
    )
      .bind(CHAT_ID, USER_ID)
      .run();
    await env.DB.prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, 'ja', 'pt-br', 'お母さん', 'outra-mae')`,
    )
      .bind(CHAT_ID, otherUserId)
      .run();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000020, text: "/forget correction ja pt-br お母さん" }),
      ),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const ownRow = await env.DB.prepare(
      "SELECT 1 AS found FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ID, USER_ID)
      .first();
    expect(ownRow).toBeNull();
    const otherRow = await env.DB.prepare(
      "SELECT 1 AS found FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ID, otherUserId)
      .first();
    expect(otherRow).not.toBeNull();
  });
});

describe("POST /telegram/webhook — /forgetme", () => {
  it("does not delete anything without confirm", async () => {
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, 'tone', 'formal')",
    )
      .bind(CHAT_ID, USER_ID)
      .run();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000021, text: "/forgetme" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ID, USER_ID)
      .first();
    expect(row).not.toBeNull();
  });

  it("deletes profile, preferences, and corrections when confirmed", async () => {
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, observed_tone, observed_emoji_usage) VALUES (?1, ?2, ?3, 'casual', 'none')",
    )
      .bind(CHAT_ID, USER_ID, "Synthetic Speaker")
      .run();
    await env.DB.prepare(
      "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, 'tone', 'formal')",
    )
      .bind(CHAT_ID, USER_ID)
      .run();
    await env.DB.prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, 'ja', 'pt-br', 'お母さん', 'mãe')`,
    )
      .bind(CHAT_ID, USER_ID)
      .run();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000022, text: "/forgetme confirm" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(getStoredProfile()).resolves.toBeNull();
    const prefRow = await env.DB.prepare(
      "SELECT 1 AS found FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ID, USER_ID)
      .first();
    expect(prefRow).toBeNull();
    const correctionRow = await env.DB.prepare(
      "SELECT 1 AS found FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ID, USER_ID)
      .first();
    expect(correctionRow).toBeNull();
  });

  it("never touches another user's data, another chat's data, allowed_chats, or bot_admins", async () => {
    const otherUserId = 790000096;
    const otherChatId = -1009900000098;
    await allowlistChat(CHAT_ID);
    await allowlistChat(otherChatId);
    await makeAdmin();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name) VALUES (?1, ?2, ?3)",
    )
      .bind(CHAT_ID, USER_ID, "Synthetic Speaker")
      .run();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name) VALUES (?1, ?2, ?3)",
    )
      .bind(CHAT_ID, otherUserId, "Other Speaker")
      .run();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name) VALUES (?1, ?2, ?3)",
    )
      .bind(otherChatId, USER_ID, "Same speaker, other chat")
      .run();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000023, text: "/forgetme confirm" })),
      testEnv(),
    );

    const otherUserRow = await env.DB.prepare(
      "SELECT 1 AS found FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(CHAT_ID, otherUserId)
      .first();
    expect(otherUserRow).not.toBeNull();
    const otherChatRow = await env.DB.prepare(
      "SELECT 1 AS found FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2",
    )
      .bind(otherChatId, USER_ID)
      .first();
    expect(otherChatRow).not.toBeNull();
    const allowedChatsCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM allowed_chats",
    ).first<number>("count");
    expect(allowedChatsCount).toBe(2);
    const adminRow = await env.DB.prepare("SELECT 1 AS found FROM bot_admins WHERE user_id = ?1")
      .bind(ADMIN_USER_ID)
      .first();
    expect(adminRow).not.toBeNull();
  });
});

describe("POST /telegram/webhook — /correct", () => {
  it("stores a ja -> pt-br correction", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000024, text: "/correct ja pt-br お母さん => mãe" }),
      ),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT target_term FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2 AND source_term = 'お母さん'",
    )
      .bind(CHAT_ID, USER_ID)
      .first<string>("target_term");
    expect(row).toBe("mãe");
  });

  it("stores a pt-br -> ja correction", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000025, text: "/correct pt-br ja mãe => お母さん" }),
      ),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT target_term FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2 AND source_term = 'mãe'",
    )
      .bind(CHAT_ID, USER_ID)
      .first<string>("target_term");
    expect(row).toBe("お母さん");
  });

  it("upserts (updates target_term) on a re-submission of the same source term and direction", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000026, text: "/correct ja pt-br termo => first" }),
      ),
      testEnv(),
    );
    await callWorker(
      webhookRequest(
        buildUpdate({ updateId: 950000027, text: "/correct ja pt-br termo => second" }),
      ),
      testEnv(),
    );

    const rows = await env.DB.prepare(
      "SELECT target_term FROM translation_corrections WHERE chat_id = ?1 AND user_id = ?2 AND source_term = 'termo'",
    )
      .bind(CHAT_ID, USER_ID)
      .all<{ target_term: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.target_term).toBe("second");
  });
});

describe("POST /telegram/webhook — /status", () => {
  it("reports chat state, effective settings (explicit over observed), and a correction count only", async () => {
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, observed_tone, observed_emoji_usage) VALUES (?1, ?2, ?3, 'casual', 'frequent')",
    )
      .bind(CHAT_ID, USER_ID, "Synthetic Speaker")
      .run();
    await env.DB.prepare(
      "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, 'tone', 'formal')",
    )
      .bind(CHAT_ID, USER_ID)
      .run();
    await env.DB.prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, 'ja', 'pt-br', 'segredo-privado', 'termo-privado')`,
    )
      .bind(CHAT_ID, USER_ID)
      .run();
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000028, text: "/status" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const call = telegramHandler.mock.calls[0];
    if (call === undefined) throw new Error("expected a Telegram call");
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { text: string };
    expect(body.text).toContain("Chat: enabled");
    expect(body.text).toContain("Tone: formal (explicit)");
    expect(body.text).toContain("Emoji usage: frequent (observed)");
    expect(body.text).toContain("Stored corrections: 1");
    expect(body.text).not.toContain("segredo-privado");
    expect(body.text).not.toContain("termo-privado");
    expect(body.text).not.toContain(String(CHAT_ID));
    expect(body.text).not.toContain(String(USER_ID));
  });
});

describe("POST /telegram/webhook — /profile", () => {
  it("shows a safe message when no profile exists yet", async () => {
    await allowlistChat();
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000029, text: "/profile" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const call = telegramHandler.mock.calls[0];
    if (call === undefined) throw new Error("expected a Telegram call");
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { text: string };
    expect(body.text).toContain("No observed profile yet");
    expect(body.text).not.toContain(String(CHAT_ID));
    expect(body.text).not.toContain(String(USER_ID));
  });

  it("does not expose another user's data or correction text", async () => {
    const otherUserId = 790000095;
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, observed_tone) VALUES (?1, ?2, ?3, 'formal')",
    )
      .bind(CHAT_ID, otherUserId, "Other Speaker Name")
      .run();
    await env.DB.prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, 'ja', 'pt-br', 'private-term', 'private-rendering')`,
    )
      .bind(CHAT_ID, USER_ID)
      .run();
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000030, text: "/profile" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    const call = telegramHandler.mock.calls[0];
    if (call === undefined) throw new Error("expected a Telegram call");
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { text: string };
    expect(body.text).not.toContain("Other Speaker Name");
    expect(body.text).not.toContain("private-term");
    expect(body.text).not.toContain("private-rendering");
    expect(body.text).toContain("Stored corrections: 1");
  });
});

describe("POST /telegram/webhook — admin authorization", () => {
  it("denies /enable for a non-admin caller and does not change allowed_chats", async () => {
    await allowlistChat(CHAT_ID, false);
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000031, text: "/enable" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:forbidden" });
    const call = telegramHandler.mock.calls[0];
    if (call === undefined) throw new Error("expected a Telegram call");
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { text: string };
    expect(body.text).toBe("This command is restricted to bot admins.");
    const row = await env.DB.prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1")
      .bind(CHAT_ID)
      .first<number>("enabled");
    expect(row).toBe(0);
  });

  it("denies /disable for a non-admin caller and does not change allowed_chats", async () => {
    await allowlistChat(CHAT_ID, true);
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000032, text: "/disable" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:forbidden" });
    const row = await env.DB.prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1")
      .bind(CHAT_ID)
      .first<number>("enabled");
    expect(row).toBe(1);
  });

  it("an unknown chat cannot self-allowlist, even for an admin caller", async () => {
    await makeAdmin(USER_ID);
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000033, text: "/enable" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:not-allowlisted" });
    expect(telegramHandler).not.toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT 1 AS found FROM allowed_chats WHERE chat_id = ?1")
      .bind(CHAT_ID)
      .first();
    expect(row).toBeNull();
  });

  it("a known but disabled chat can be re-enabled by an admin", async () => {
    await allowlistChat(CHAT_ID, false);
    await makeAdmin(USER_ID);
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000034, text: "/enable" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:handled" });
    const row = await env.DB.prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1")
      .bind(CHAT_ID)
      .first<number>("enabled");
    expect(row).toBe(1);
  });

  it("a disabled chat drops normal text without translating", async () => {
    await allowlistChat(CHAT_ID, false);
    const fetchSpy = mockFetchDispatch({});

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000035, text: "こんにちは" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:not-allowlisted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a disabled chat drops a normal (non-/enable) command", async () => {
    await allowlistChat(CHAT_ID, false);
    const fetchSpy = mockFetchDispatch({});

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000036, text: "/status" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:not-allowlisted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Phase 6 review, Issue 2: "/enable garbage" is a usage-error, not a
  // valid parsed /enable — a disabled chat must never let it through the
  // /enable exception, even for an admin caller. No admin lookup, no D1
  // mutation, no Telegram reply, and no dedupe reservation.
  it("a known disabled chat drops '/enable garbage' — never a valid parsed /enable, even for an admin", async () => {
    await allowlistChat(CHAT_ID, false);
    await makeAdmin(USER_ID);
    const fetchSpy = mockFetchDispatch({});
    const updateId = 950000046;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/enable garbage" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:not-allowlisted" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1")
      .bind(CHAT_ID)
      .first<number>("enabled");
    expect(row).toBe(0);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
  });
});

describe("POST /telegram/webhook — commands never invoke OpenAI or the observed-style write path", () => {
  it("never calls OpenAI for any recognized command", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000037, text: "/help" })),
      testEnv(),
    );

    const openaiCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.startsWith("https://api.openai.com/");
    });
    expect(openaiCalls).toHaveLength(0);
  });

  it("never calls OpenAI for an unknown command", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000038, text: "/bogus" })),
      testEnv(),
    );

    const openaiCalls = fetchSpy.mock.calls.filter(([input]) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.startsWith("https://api.openai.com/");
    });
    expect(openaiCalls).toHaveLength(0);
  });

  it("never writes speaker_profiles' observed-style columns from a command", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000039, text: "/remember tone formal" })),
      testEnv(),
    );

    await expect(getStoredProfile()).resolves.toBeNull();
  });
});

describe("POST /telegram/webhook — command dedupe and retry semantics", () => {
  it("does not repeat a mutation or reply on a redelivered command update_id", async () => {
    await allowlistChat();
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({ telegram: telegramHandler });
    const updateId = 950000040;

    const first = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/remember tone formal" })),
      testEnv(),
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ outcome: "command:handled" });

    const second = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/remember tone formal" })),
      testEnv(),
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ outcome: "ignored:duplicate" });

    expect(telegramHandler).toHaveBeenCalledTimes(1);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(CHAT_ID, USER_ID)
      .first<number>("count");
    expect(count).toBe(1);
  });

  it("releases the dedupe reservation on a transient D1 command-mutation failure, and a redelivery then succeeds", async () => {
    await allowlistChat();
    const updateId = 950000041;
    const failingPrepare = mockD1PrepareFailureFor("INSERT INTO speaker_preferences");
    const fetchSpy = mockFetchDispatch({});

    const first = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/remember tone formal" })),
      testEnv(),
    );
    expect(first.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
    failingPrepare.mockRestore();

    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });
    const second = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/remember tone formal" })),
      testEnv(),
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ outcome: "command:handled" });
    const row = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(CHAT_ID, USER_ID)
      .first<string>("preference_value");
    expect(row).toBe("formal");
  });

  it("keeps the dedupe reservation on a malformed D1 row during command execution (permanent failure)", async () => {
    await allowlistChat();
    const updateId = 950000042;
    const malformedRowPrepare = mockD1PrepareRowFor("FROM speaker_preferences WHERE chat_id", {
      chat_id: CHAT_ID,
      user_id: USER_ID,
      preference_key: "tone",
      preference_value: "super-formal", // invalid enum value — malformed row
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
    });
    const fetchSpy = mockFetchDispatch({});

    try {
      const response = await callWorker(
        webhookRequest(buildUpdate({ updateId, text: "/status" })),
        testEnv(),
      );

      expect(response.status).toBe(500);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
    } finally {
      malformedRowPrepare.mockRestore();
    }
  });

  it("releases the dedupe reservation on a transient Telegram reply failure during a command", async () => {
    await allowlistChat();
    const updateId = 950000043;
    mockFetchDispatch({
      telegram: () => Promise.resolve(jsonResponse({ ok: false, error_code: 503 }, 503)),
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/remember tone formal" })),
      testEnv(),
    );

    expect(response.status).toBe(500);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
    // The mutation itself already succeeded (idempotent), even though the reply failed.
    const row = await env.DB.prepare(
      "SELECT preference_value FROM speaker_preferences WHERE chat_id = ?1 AND user_id = ?2 AND preference_key = 'tone'",
    )
      .bind(CHAT_ID, USER_ID)
      .first<string>("preference_value");
    expect(row).toBe("formal");
  }, 15000);
});

// Phase 6 review, Issue 1: once `/disable`'s D1 mutation succeeds, the
// chat is already disabled, so a Telegram redelivery of this same update
// can never reach the command path again (the webhook drops every update
// for a disabled chat except a valid /enable). A transient reply failure
// at that point must therefore keep the dedupe reservation instead of
// releasing it — unlike every other command mutation, including /enable.
describe("POST /telegram/webhook — /disable reply-failure dedupe exception (Phase 6 review, Issue 1)", () => {
  it("releases the dedupe reservation on a transient D1 failure in the disable mutation itself, and a redelivery then succeeds", async () => {
    await allowlistChat(CHAT_ID, true);
    await makeAdmin(USER_ID);
    const updateId = 950000047;
    const failingPrepare = mockD1PrepareFailureFor("UPDATE allowed_chats");
    const fetchSpy = mockFetchDispatch({});

    const first = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/disable" })),
      testEnv(),
    );
    expect(first.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    const rowAfterFirst = await env.DB.prepare(
      "SELECT enabled FROM allowed_chats WHERE chat_id = ?1",
    )
      .bind(CHAT_ID)
      .first<number>("enabled");
    expect(rowAfterFirst).toBe(1);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
    failingPrepare.mockRestore();

    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });
    const second = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/disable" })),
      testEnv(),
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ outcome: "command:handled" });
    const rowAfterSecond = await env.DB.prepare(
      "SELECT enabled FROM allowed_chats WHERE chat_id = ?1",
    )
      .bind(CHAT_ID)
      .first<number>("enabled");
    expect(rowAfterSecond).toBe(0);
  });

  it("keeps the dedupe reservation on a transient Telegram reply failure after the disable mutation succeeds", async () => {
    await allowlistChat(CHAT_ID, true);
    await makeAdmin(USER_ID);
    const updateId = 950000048;
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse({ ok: false, error_code: 503 }, 503)),
    );
    mockFetchDispatch({ telegram: telegramHandler });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/disable" })),
      testEnv(),
    );

    expect(response.status).toBe(500);
    // The mutation already succeeded — the chat is disabled now, even
    // though the confirmation reply failed.
    const row = await env.DB.prepare("SELECT enabled FROM allowed_chats WHERE chat_id = ?1")
      .bind(CHAT_ID)
      .first<number>("enabled");
    expect(row).toBe(0);
    // Unlike a normal command, the reservation is KEPT — not released —
    // because a redelivery could never reach the command path again now
    // that this chat is disabled (only /enable would get through).
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
    expect(telegramHandler).toHaveBeenCalledTimes(1);

    // A redelivery of the same update_id is now a harmless duplicate —
    // routing never reaches the command path again (disabled chat, and
    // this update's text is /disable, not /enable) — so the reply is
    // never retried, exactly as intended.
    telegramHandler.mockClear();
    const redelivery = await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "/disable" })),
      testEnv(),
    );
    expect(redelivery.status).toBe(200);
    await expect(redelivery.json()).resolves.toMatchObject({ outcome: "ignored:not-allowlisted" });
    expect(telegramHandler).not.toHaveBeenCalled();
  }, 15000);
});

describe("POST /telegram/webhook — command path never requires OPENAI_API_KEY", () => {
  it("handles a command successfully even when OPENAI_API_KEY is missing", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000044, text: "/help" })),
      testEnv({ OPENAI_API_KEY: "" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "command:handled" });
  });

  it("returns 500 without calling Telegram when TELEGRAM_BOT_TOKEN is missing for a command", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 950000045, text: "/help" })),
      testEnv({ TELEGRAM_BOT_TOKEN: "" }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
