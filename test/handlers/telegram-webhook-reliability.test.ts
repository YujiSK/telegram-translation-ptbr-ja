import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";

/**
 * Phase 7 rate limiting / usage ceiling, end to end. All IDs and
 * Secret-shaped values below are obviously synthetic. Every test that
 * could reach OpenAI or Telegram installs its own `mockFetchDispatch`
 * spy that throws on any unexpected call, so a wiring bug that causes an
 * unintended real network call fails the test loudly instead of
 * silently succeeding.
 */

const WEBHOOK_SECRET = "synthetic-test-webhook-secret-003";
const TELEGRAM_BOT_TOKEN = "0000000000:FAKE-TEST-RELIABILITY-TOKEN-not-a-real-secret";
const OPENAI_API_KEY = "synthetic-test-openai-key-reliability-001";
const CHAT_ID = -1009500000001;
const OTHER_CHAT_ID = -1009500000002;
const USER_ID = 791000001;
const MESSAGE_ID = 650000001;

interface RawUpdateFixture {
  update_id: number;
  message: Record<string, unknown>;
}

function buildUpdate(
  overrides: {
    updateId?: number;
    text?: unknown;
    chatId?: number;
  } = {},
): RawUpdateFixture {
  const { updateId = 960000001, text = "こんにちは", chatId = CHAT_ID } = overrides;

  return {
    update_id: updateId,
    message: {
      message_id: MESSAGE_ID,
      date: 1700000000,
      chat: { id: chatId, type: "group" },
      from: { id: USER_ID, is_bot: false, first_name: "Test User" },
      text,
    },
  };
}

/**
 * `wrangler types` generates each `vars` entry as its exact literal
 * value (e.g. `MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "60"`), not
 * `string` — accurate for the real deployed config, but too narrow for
 * a test that needs a small limit to exercise blocking behavior without
 * sending dozens of requests. `ReliabilityTestEnvOverrides` widens just
 * those three fields back to `string` for override purposes; the single
 * `as Env` below reflects that at runtime every `vars` entry is a plain
 * string regardless of what TypeScript narrowed it to at the
 * `wrangler.jsonc` default value — not an unsafe boundary cast.
 */
interface ReliabilityTestEnvOverrides {
  readonly TELEGRAM_WEBHOOK_SECRET?: string;
  readonly OPENAI_API_KEY?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE?: string;
  readonly MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE?: string;
  readonly MAX_OPENAI_ATTEMPTS_PER_DAY?: string;
}

function testEnv(overrides: ReliabilityTestEnvOverrides = {}): Env {
  return {
    ...env,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OPENAI_API_KEY,
    TELEGRAM_BOT_TOKEN,
    ...overrides,
  } as Env;
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

async function allowlistChat(chatId: number = CHAT_ID): Promise<void> {
  await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(chatId).run();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiStructuredResponse(payload: unknown, status = 200): Response {
  return jsonResponse(
    {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(payload) }],
        },
      ],
    },
    status,
  );
}

function openAiTranslatedResponse(): Response {
  return openAiStructuredResponse({
    detectedLanguage: "ja",
    action: "translate",
    targetLanguage: "pt-br",
    translatedText: "mensagem sintética de teste",
    styleSignals: { tone: "casual", emojiUsage: "none" },
  });
}

function telegramSendMessageResponse(messageId = 999999003): Response {
  return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: CHAT_ID } } });
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

/** Mirrors the other webhook test files' helper of the same name. */
function mockD1PrepareFailureFor(matchSubstring: string) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(matchSubstring)) {
      throw new Error("synthetic D1 outage");
    }
    return originalPrepare(query);
  });
}

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

/** Directly rewinds a counter's window/day to force a rollover on the next request, without waiting in real time. */
async function rewindCounterWindow(
  scopeType: "chat_updates" | "chat_openai",
  chatId: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE rate_limit_counters SET window_id = window_id - 1000000 WHERE scope_type = ?1 AND scope_id = ?2",
  )
    .bind(scopeType, chatId)
    .run();
}

async function rewindDailyUsageDay(): Promise<void> {
  await env.DB.prepare("UPDATE openai_daily_usage SET day_id = day_id - 1000000").run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM speaker_preferences"),
    env.DB.prepare("DELETE FROM translation_corrections"),
    env.DB.prepare("DELETE FROM speaker_profiles"),
    env.DB.prepare("DELETE FROM processed_updates"),
    env.DB.prepare("DELETE FROM allowed_chats"),
    env.DB.prepare("DELETE FROM bot_admins"),
    env.DB.prepare("DELETE FROM rate_limit_counters"),
    env.DB.prepare("DELETE FROM openai_daily_usage"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /telegram/webhook — per-chat inbound handled-update rate limit", () => {
  it("allows requests up to the configured limit, then rate-limits the next one", async () => {
    await allowlistChat();
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    const testConfig = testEnv({ MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "3" });

    for (let i = 0; i < 3; i += 1) {
      const response = await callWorker(
        webhookRequest(buildUpdate({ updateId: 960000010 + i })),
        testConfig,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.not.toMatchObject({ outcome: "ignored:rate-limited" });
    }

    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000013 })),
      testConfig,
    );
    expect(blocked.status).toBe(200);
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:rate-limited" });
  });

  it("never calls OpenAI or Telegram for a rate-limited request, and keeps its dedupe reservation", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    await callWorker(webhookRequest(buildUpdate({ updateId: 960000020 })), testConfig);

    const fetchSpy = mockFetchDispatch({});
    fetchSpy.mockClear();
    const blockedUpdateId = 960000021;
    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: blockedUpdateId })),
      testConfig,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:rate-limited" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(blockedUpdateId)).resolves.toBe(true);
  });

  it("allows requests again once the minute window rolls over", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    await callWorker(webhookRequest(buildUpdate({ updateId: 960000030 })), testConfig);
    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000031 })),
      testConfig,
    );
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:rate-limited" });

    await rewindCounterWindow("chat_updates", CHAT_ID);

    const afterRollover = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000032 })),
      testConfig,
    );
    expect(afterRollover.status).toBe(200);
    await expect(afterRollover.json()).resolves.not.toMatchObject({
      outcome: "ignored:rate-limited",
    });
  });

  it("tracks different chats independently", async () => {
    await allowlistChat(CHAT_ID);
    await allowlistChat(OTHER_CHAT_ID);
    const testConfig = testEnv({ MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000040, chatId: CHAT_ID })),
      testConfig,
    );
    const blockedSameChat = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000041, chatId: CHAT_ID })),
      testConfig,
    );
    await expect(blockedSameChat.json()).resolves.toMatchObject({
      outcome: "ignored:rate-limited",
    });

    const otherChat = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000042, chatId: OTHER_CHAT_ID })),
      testConfig,
    );
    expect(otherChat.status).toBe(200);
    await expect(otherChat.json()).resolves.toMatchObject({ outcome: "translated" });
  });

  it("does not double-consume the budget on a redelivered (duplicate) update_id", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    const updateId = 960000050;

    const first = await callWorker(webhookRequest(buildUpdate({ updateId })), testConfig);
    await expect(first.json()).resolves.not.toMatchObject({ outcome: "ignored:rate-limited" });

    // Redelivering the same update_id must be a plain duplicate, not a
    // second consumption of the same-chat budget.
    const redelivered = await callWorker(webhookRequest(buildUpdate({ updateId })), testConfig);
    await expect(redelivered.json()).resolves.toMatchObject({ outcome: "ignored:duplicate" });

    const count = await env.DB.prepare(
      "SELECT request_count FROM rate_limit_counters WHERE scope_type = 'chat_updates' AND scope_id = ?1",
    )
      .bind(CHAT_ID)
      .first<number>("request_count");
    expect(count).toBe(1);
  });

  it("applies to commands as well as ordinary text", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });
    await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000060, text: "/help" })),
      testConfig,
    );

    const fetchSpy = mockFetchDispatch({});
    fetchSpy.mockClear();
    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000061, text: "/help" })),
      testConfig,
    );
    expect(blocked.status).toBe(200);
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:rate-limited" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies a transient D1 failure in the counter as transient, releasing the dedupe reservation", async () => {
    await allowlistChat();
    const updateId = 960000070;
    const failingPrepare = mockD1PrepareFailureFor("INSERT INTO rate_limit_counters");
    const fetchSpy = mockFetchDispatch({});

    const response = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
    failingPrepare.mockRestore();

    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    const redelivery = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
    expect(redelivery.status).toBe(200);
    await expect(redelivery.json()).resolves.toMatchObject({ outcome: "translated" });
  });

  it("keeps the dedupe reservation on a malformed counter row (permanent failure)", async () => {
    await allowlistChat();
    const updateId = 960000071;
    const malformedRowPrepare = mockD1PrepareRowFor("INSERT INTO rate_limit_counters", {
      request_count: -1, // a real CHECK-constrained row can never be negative
    });
    const fetchSpy = mockFetchDispatch({});

    try {
      const response = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
      expect(response.status).toBe(500);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
    } finally {
      malformedRowPrepare.mockRestore();
    }
  });
});

describe("POST /telegram/webhook — OpenAI per-chat attempt burst limit", () => {
  it("allows attempts up to the limit, then blocks the next without fetching", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE: "2" });
    const openaiHandler = vi.fn(() => Promise.resolve(openAiTranslatedResponse()));
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 960000080 })), testConfig);
    await callWorker(webhookRequest(buildUpdate({ updateId: 960000081 })), testConfig);
    expect(openaiHandler).toHaveBeenCalledTimes(2);

    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000082 })),
      testConfig,
    );
    expect(blocked.status).toBe(200);
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:rate-limited" });
    expect(openaiHandler).toHaveBeenCalledTimes(2); // no third fetch
  });

  it("keeps the dedupe reservation for an OpenAI-burst-blocked update", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    await callWorker(webhookRequest(buildUpdate({ updateId: 960000090 })), testConfig);

    const blockedUpdateId = 960000091;
    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: blockedUpdateId })),
      testConfig,
    );
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:rate-limited" });
    await expect(isUpdateRecorded(blockedUpdateId)).resolves.toBe(true);
  });

  it("tracks different chats independently", async () => {
    await allowlistChat(CHAT_ID);
    await allowlistChat(OTHER_CHAT_ID);
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000100, chatId: CHAT_ID })),
      testConfig,
    );
    const blockedSameChat = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000101, chatId: CHAT_ID })),
      testConfig,
    );
    await expect(blockedSameChat.json()).resolves.toMatchObject({
      outcome: "ignored:rate-limited",
    });

    const otherChat = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000102, chatId: OTHER_CHAT_ID })),
      testConfig,
    );
    await expect(otherChat.json()).resolves.not.toMatchObject({ outcome: "ignored:rate-limited" });
  });

  it("resets once the minute window rolls over", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    await callWorker(webhookRequest(buildUpdate({ updateId: 960000110 })), testConfig);
    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000111 })),
      testConfig,
    );
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:rate-limited" });

    await rewindCounterWindow("chat_openai", CHAT_ID);

    const afterRollover = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000112 })),
      testConfig,
    );
    await expect(afterRollover.json()).resolves.not.toMatchObject({
      outcome: "ignored:rate-limited",
    });
  });

  it("commands never consume the OpenAI attempt budget", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE: "1" });
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000120, text: "/help" })),
      testConfig,
    );
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rate_limit_counters WHERE scope_type = 'chat_openai' AND scope_id = ?1",
    )
      .bind(CHAT_ID)
      .first<number>("count");
    expect(count ?? 0).toBe(0);
  });
});

describe("POST /telegram/webhook — global daily OpenAI attempt ceiling", () => {
  it("allows attempts up to the limit, then reports ignored:usage-limit without fetching", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_DAY: "2" });
    const openaiHandler = vi.fn(() => Promise.resolve(openAiTranslatedResponse()));
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 960000130 })), testConfig);
    await callWorker(webhookRequest(buildUpdate({ updateId: 960000131 })), testConfig);
    expect(openaiHandler).toHaveBeenCalledTimes(2);

    const blockedUpdateId = 960000132;
    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: blockedUpdateId })),
      testConfig,
    );
    expect(blocked.status).toBe(200);
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:usage-limit" });
    expect(openaiHandler).toHaveBeenCalledTimes(2);
    await expect(isUpdateRecorded(blockedUpdateId)).resolves.toBe(true);
  });

  it("is shared across chats, not per-chat", async () => {
    await allowlistChat(CHAT_ID);
    await allowlistChat(OTHER_CHAT_ID);
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_DAY: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000140, chatId: CHAT_ID })),
      testConfig,
    );
    const blockedOtherChat = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000141, chatId: OTHER_CHAT_ID })),
      testConfig,
    );
    await expect(blockedOtherChat.json()).resolves.toMatchObject({
      outcome: "ignored:usage-limit",
    });
  });

  it("resets on the next UTC day", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_DAY: "1" });
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    await callWorker(webhookRequest(buildUpdate({ updateId: 960000150 })), testConfig);
    const blocked = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000151 })),
      testConfig,
    );
    await expect(blocked.json()).resolves.toMatchObject({ outcome: "ignored:usage-limit" });

    await rewindDailyUsageDay();

    const nextDay = await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000152 })),
      testConfig,
    );
    await expect(nextDay.json()).resolves.not.toMatchObject({ outcome: "ignored:usage-limit" });
  });

  it("a retry attempt also consumes daily budget — exhausting it before the retry skips the second fetch", async () => {
    await allowlistChat();
    // Budget for exactly one attempt: the first (transient-failing) fetch
    // consumes it, so the retry's own beforeAttempt reservation is denied.
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_DAY: "1" });
    const openaiHandler = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: { message: "server error" } }, 503)),
    );
    mockFetchDispatch({ openai: openaiHandler });

    const updateId = 960000160;
    const response = await callWorker(webhookRequest(buildUpdate({ updateId })), testConfig);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:usage-limit" });
    expect(openaiHandler).toHaveBeenCalledTimes(1); // the retry never actually fetched
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });

  it("commands never consume the daily OpenAI budget", async () => {
    await allowlistChat();
    const testConfig = testEnv({ MAX_OPENAI_ATTEMPTS_PER_DAY: "1" });
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 960000170, text: "/status" })),
      testConfig,
    );
    const row = await env.DB.prepare("SELECT attempt_count FROM openai_daily_usage").first<number>(
      "attempt_count",
    );
    expect(row).toBeNull();
  });
});
