import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";

/**
 * All IDs, Secret-shaped values, and message text below are obviously
 * synthetic — no real Telegram chat/user ID, no real Secret, and no real
 * family message ever appears in this file. OpenAI and Telegram are never
 * reached: every test that exercises the Phase 4 translation path installs
 * its own `globalThis.fetch` spy (see `mockFetchDispatch`) and restores it
 * afterward.
 */

const WEBHOOK_SECRET = "synthetic-test-webhook-secret-001";
const OPENAI_API_KEY = "synthetic-test-openai-key-e2e-001";
const TELEGRAM_BOT_TOKEN = "0000000000:FAKE-TEST-E2E-TOKEN-not-a-real-secret";
const CHAT_ID = -1008000000001;
const USER_ID = 750000001;
const MESSAGE_ID = 610000001;

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
      message_id: MESSAGE_ID,
      date: 1700000000,
      chat: { id: chatId, type: "group" },
      from: { id: USER_ID, is_bot: isBot, first_name: "Test User" },
      text,
    },
  };
}

/**
 * Phase 9.1A: `wrangler.jsonc`'s default `TRANSLATION_PROVIDER` is now
 * `"workers-ai"`. This entire file predates the provider router and
 * mocks only the OpenAI fetch endpoint, so every test here forces the
 * legacy `TRANSLATION_PROVIDER: "openai"` path by default — preserving
 * 100% of this file's existing behavior/assertions unchanged. The
 * literal-vars-typed `Env` (see worker-configuration.d.ts) means the
 * override value's type must be widened; `as Env` reflects that every
 * `vars` entry is a plain string at runtime regardless of what
 * TypeScript narrowed it to from the `wrangler.jsonc` default.
 */
interface TestEnvOverrides {
  readonly TELEGRAM_WEBHOOK_SECRET?: string;
  readonly OPENAI_API_KEY?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TRANSLATION_PROVIDER?: string;
}

function testEnv(overrides: TestEnvOverrides = {}): Env {
  return {
    ...env,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    OPENAI_API_KEY,
    TELEGRAM_BOT_TOKEN,
    TRANSLATION_PROVIDER: "openai",
    ...overrides,
  } as Env;
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

async function isUpdateRecorded(updateId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS found FROM processed_updates WHERE update_id = ?1")
    .bind(updateId)
    .first();
  return row !== null;
}

async function allowlistChat(chatId: number = CHAT_ID): Promise<void> {
  await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(chatId).run();
}

/**
 * Installs a `globalThis.fetch` spy that routes by host to the OpenAI and
 * Telegram handlers supplied, and throws for any call to a host or a
 * service with no handler — so an unexpected extra call (e.g. Telegram
 * called after a "skip" outcome) fails the test loudly instead of hitting
 * the real network. Callers must `.mockRestore()` the returned spy.
 */
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

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("expected a string request body");
  }
  return body;
}

/**
 * Extracts only the "user"-role message content from an OpenAI request
 * body's `input` array — the developer instructions are fixed text that
 * mentions section names like "SPEAKER STYLE PREFERENCE" generically
 * (to explain the format), so a presence/absence assertion must look at
 * the user message alone, not the whole serialized `input`.
 */
function userMessageContent(input: unknown): string {
  if (!Array.isArray(input)) {
    throw new Error("expected the OpenAI request body's input to be an array");
  }
  const userMessage = input.find(
    (message): message is { role: string; content: string } =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      (message as { role: unknown }).role === "user",
  );
  if (userMessage === undefined) {
    throw new Error("expected a user-role message in the OpenAI request body's input");
  }
  return userMessage.content;
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

function openAiTranslatedPtBrToJaResponse(): Response {
  return openAiStructuredResponse({
    detectedLanguage: "pt-br",
    action: "translate",
    targetLanguage: "ja",
    translatedText: "合成テストメッセージ",
    styleSignals: { tone: "neutral", emojiUsage: "light" },
  });
}

function openAiSkipResponse(): Response {
  return openAiStructuredResponse({
    detectedLanguage: "other",
    action: "skip",
    targetLanguage: null,
    translatedText: null,
    styleSignals: null,
  });
}

function telegramSendMessageResponse(messageId = 999999001): Response {
  return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: CHAT_ID } } });
}

/**
 * Fails D1 `.prepare()` only for statements whose SQL text contains
 * `matchSubstring`, delegating everything else to the real local D1 — so
 * a specific read or write can be made to fail (e.g. only the speaker
 * memory read, not the allowlist/dedupe checks that must succeed first).
 */
function mockD1PrepareFailureFor(matchSubstring: string) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(matchSubstring)) {
      throw new Error("synthetic D1 outage");
    }
    return originalPrepare(query);
  });
}

/**
 * A minimal `D1PreparedStatement` fake that always resolves `.first()`/
 * `.all()` with a fixed row, regardless of bind values — used to simulate
 * a malformed (data-corrupted) D1 row, which a real `CHECK`-constrained
 * INSERT can never actually produce. `.run()`/`.raw()` are never called
 * by the code paths under test here.
 */
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

/**
 * Makes D1 `.prepare()` return a fixed (possibly malformed) row for
 * statements whose SQL text contains `matchSubstring`, delegating
 * everything else to the real local D1 — mirrors `mockD1PrepareFailureFor`
 * but for "D1 succeeded, with bad data" instead of "D1 failed".
 */
function mockD1PrepareRowFor(matchSubstring: string, row: Record<string, unknown> | null) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
    if (query.includes(matchSubstring)) {
      return new FixedRowStatement(row);
    }
    return originalPrepare(query);
  });
}

async function getStoredProfile(
  chatId: number,
  userId: number,
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    "SELECT display_name, primary_language, observed_tone, observed_emoji_usage FROM speaker_profiles WHERE chat_id = ?1 AND user_id = ?2",
  )
    .bind(chatId, userId)
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
    env.DB.prepare("DELETE FROM rate_limit_counters"),
    env.DB.prepare("DELETE FROM openai_daily_usage"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /telegram/webhook — secret verification", () => {
  it("accepts a request with the correct secret for an allowlisted chat", async () => {
    await allowlistChat();
    mockFetchDispatch({ openai: () => Promise.resolve(openAiSkipResponse()) });

    const response = await callWorker(webhookRequest(buildUpdate()), testEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:untargeted-language",
    });
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
    await allowlistChat();

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

  it("records the first valid update for dedupe even when OpenAI reports an untargeted language", async () => {
    await allowlistChat();
    mockFetchDispatch({ openai: () => Promise.resolve(openAiSkipResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000002 })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:untargeted-language",
    });
    await expect(isUpdateRecorded(930000002)).resolves.toBe(true);
  });

  it("treats a redelivered update_id as a duplicate on the second delivery", async () => {
    await allowlistChat();
    mockFetchDispatch({ openai: () => Promise.resolve(openAiSkipResponse()) });

    const first = await callWorker(webhookRequest(buildUpdate({ updateId: 930000003 })), testEnv());
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ outcome: "ignored:untargeted-language" });

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
    mockFetchDispatch({ openai: () => Promise.resolve(openAiSkipResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000004, chatId: negativeChatId })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:untargeted-language",
    });
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

describe("POST /telegram/webhook — successful translation and reply", () => {
  it("translates the message and replies via Telegram, returning 200 translated", async () => {
    await allowlistChat();
    const telegramHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(telegramSendMessageResponse()),
    );
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: telegramHandler,
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000010 })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
    expect(telegramHandler).toHaveBeenCalledTimes(1);

    const call = telegramHandler.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the Telegram handler to have been called");
    }
    const body: unknown = JSON.parse(requireStringBody(call[1]?.body));
    expect(body).toMatchObject({
      chat_id: CHAT_ID,
      text: "mensagem sintética de teste",
      reply_parameters: { message_id: MESSAGE_ID },
    });
  });

  it("keeps the dedupe reservation after a successful translation", async () => {
    await allowlistChat();
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 930000011 })), testEnv());

    await expect(isUpdateRecorded(930000011)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — untargeted language", () => {
  it("never calls Telegram and keeps the dedupe reservation", async () => {
    await allowlistChat();
    // No telegram handler: mockFetchDispatch throws if it is ever called.
    mockFetchDispatch({ openai: () => Promise.resolve(openAiSkipResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000012 })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:untargeted-language",
    });
    await expect(isUpdateRecorded(930000012)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — message length ceiling", () => {
  it("ignores a too-long message without calling OpenAI or Telegram", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const tooLongText = "あ".repeat(2001);

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000013, text: tooLongText })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "ignored:too-long" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(930000013)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — OpenAI transient failure exhausts retries", () => {
  it("returns 500 and releases the dedupe reservation so a redelivery can be retried", async () => {
    await allowlistChat();
    const updateId = 930000014;
    const failingFetch = mockFetchDispatch({
      openai: () => Promise.resolve(jsonResponse({ error: { message: "server error" } }, 503)),
    });

    const first = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
    expect(first.status).toBe(500);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
    failingFetch.mockRestore();

    // A redelivery after the release should be processed as a new update.
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    const second = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ outcome: "translated" });
  }, 15000);
});

describe("POST /telegram/webhook — OpenAI permanent failure keeps the dedupe reservation", () => {
  it("returns 500 and a redelivery is treated as a harmless duplicate, not retried", async () => {
    await allowlistChat();
    const updateId = 930000015;
    const openaiHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse({ error: { message: "bad request" } }, 400)),
    );
    mockFetchDispatch({ openai: openaiHandler });

    const first = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
    expect(first.status).toBe(500);
    expect(openaiHandler).toHaveBeenCalledTimes(1);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);

    const second = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ outcome: "ignored:duplicate" });
    // The doomed OpenAI call is never repeated for the same reservation.
    expect(openaiHandler).toHaveBeenCalledTimes(1);
  });
});

describe("POST /telegram/webhook — malformed OpenAI response", () => {
  it("returns 500, never calls Telegram, and keeps the dedupe reservation", async () => {
    await allowlistChat();
    const updateId = 930000016;
    // No telegram handler: mockFetchDispatch throws if it is ever called.
    mockFetchDispatch({
      openai: () => Promise.resolve(jsonResponse({ output: [] })),
    });

    const response = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());

    expect(response.status).toBe(500);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — Telegram send failure is never treated as success", () => {
  it("returns 500 on a permanent Telegram failure and keeps the dedupe reservation", async () => {
    await allowlistChat();
    const updateId = 930000017;
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () =>
        Promise.resolve(
          jsonResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
        ),
    });

    const response = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());

    expect(response.status).toBe(500);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });

  it("returns 500 on a transient Telegram failure and releases the dedupe reservation", async () => {
    await allowlistChat();
    const updateId = 930000018;
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(jsonResponse({ ok: false, error_code: 503 }, 503)),
    });

    const response = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());

    expect(response.status).toBe(500);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
  }, 15000);
});

describe("POST /telegram/webhook — missing Secrets", () => {
  it("returns 500 without calling OpenAI or Telegram when OPENAI_API_KEY is missing", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 930000019;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ OPENAI_API_KEY: "" }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });

  it("returns 500 without calling OpenAI or Telegram when TELEGRAM_BOT_TOKEN is missing", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 930000020;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ TELEGRAM_BOT_TOKEN: "" }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — speaker memory: pt-br -> ja with no memory", () => {
  it("translates a pt-br source message the same way with no stored memory", async () => {
    await allowlistChat();
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedPtBrToJaResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000030, text: "Oi, tudo bem?" })),
      testEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
  });
});

describe("POST /telegram/webhook — speaker memory: observed style is read and reflected in the prompt", () => {
  it("includes the previously observed style in the OpenAI request as a soft hint", async () => {
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language, observed_tone, observed_emoji_usage) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(CHAT_ID, USER_ID, "Synthetic Speaker", "ja", "formal", "none")
      .run();

    const openaiHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(openAiTranslatedResponse()),
    );
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 930000031 })), testEnv());

    const call = openaiHandler.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the OpenAI handler to have been called");
    }
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { input: unknown };
    const serializedInput = JSON.stringify(body.input);
    expect(serializedInput).toContain("SPEAKER STYLE PREFERENCE");
    expect(serializedInput).toContain("tone: formal (observed)");
    expect(serializedInput).toContain("emojiUsage: none (observed)");
  });
});

describe("POST /telegram/webhook — speaker memory: explicit preference is read and reflected in the prompt", () => {
  it("includes the explicit preference in the OpenAI request, taking priority over any observed style", async () => {
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language, observed_tone, observed_emoji_usage) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(CHAT_ID, USER_ID, "Synthetic Speaker", "ja", "casual", "frequent")
      .run();
    await env.DB.prepare(
      "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(CHAT_ID, USER_ID, "tone", "formal")
      .run();

    const openaiHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(openAiTranslatedResponse()),
    );
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 930000032 })), testEnv());

    const call = openaiHandler.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the OpenAI handler to have been called");
    }
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { input: unknown };
    const serializedInput = JSON.stringify(body.input);
    // Explicit tone (formal) wins over observed tone (casual); emojiUsage
    // has no explicit preference, so it falls back to observed (frequent).
    expect(serializedInput).toContain("tone: formal (explicit)");
    expect(serializedInput).toContain("emojiUsage: frequent (observed)");
  });
});

describe("POST /telegram/webhook — speaker memory: applicable corrections are read and reflected in the prompt", () => {
  it("includes a correction whose source term appears in the message", async () => {
    await allowlistChat();
    await env.DB.prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(CHAT_ID, USER_ID, "ja", "pt-br", "こんにちは", "synthetic-greeting")
      .run();

    const openaiHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(openAiTranslatedResponse()),
    );
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    // buildUpdate()'s default text contains "こんにちは".
    await callWorker(webhookRequest(buildUpdate({ updateId: 930000033 })), testEnv());

    const call = openaiHandler.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the OpenAI handler to have been called");
    }
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { input: unknown };
    const serializedInput = JSON.stringify(body.input);
    expect(serializedInput).toContain("KNOWN TERM CORRECTIONS");
    expect(serializedInput).toContain("synthetic-greeting");
  });

  it("excludes a correction whose source term does not appear in the message", async () => {
    await allowlistChat();
    await env.DB.prepare(
      `INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(CHAT_ID, USER_ID, "ja", "pt-br", "synthetic-unrelated-term", "unrelated-rendering")
      .run();

    const openaiHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(openAiTranslatedResponse()),
    );
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 930000034 })), testEnv());

    const call = openaiHandler.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the OpenAI handler to have been called");
    }
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { input: unknown };
    const userContent = userMessageContent(body.input);
    expect(userContent).not.toContain("KNOWN TERM CORRECTIONS");
    expect(userContent).not.toContain("synthetic-unrelated-term");
  });
});

describe("POST /telegram/webhook — speaker memory: scope isolation", () => {
  it("does not leak observed style from another chat for the same user", async () => {
    const otherChatId = -1008000000099;
    await allowlistChat();
    await allowlistChat(otherChatId);
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language, observed_tone, observed_emoji_usage) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(otherChatId, USER_ID, "Synthetic Speaker", "ja", "formal", "none")
      .run();

    const openaiHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(openAiTranslatedResponse()),
    );
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000035, chatId: CHAT_ID })),
      testEnv(),
    );

    const call = openaiHandler.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the OpenAI handler to have been called");
    }
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { input: unknown };
    expect(userMessageContent(body.input)).not.toContain("SPEAKER STYLE PREFERENCE");
  });

  it("does not leak observed style from another user in the same chat", async () => {
    const otherUserId = 750000099;
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language, observed_tone, observed_emoji_usage) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(CHAT_ID, otherUserId, "Other Synthetic Speaker", "ja", "formal", "none")
      .run();

    const openaiHandler = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(openAiTranslatedResponse()),
    );
    mockFetchDispatch({
      openai: openaiHandler,
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 930000036 })), testEnv());

    const call = openaiHandler.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected the OpenAI handler to have been called");
    }
    const body = JSON.parse(requireStringBody(call[1]?.body)) as { input: unknown };
    expect(userMessageContent(body.input)).not.toContain("SPEAKER STYLE PREFERENCE");
  });
});

describe("POST /telegram/webhook — speaker memory: observed profile write after a successful translation", () => {
  it("stores display name, detected language, observed tone, and observed emoji usage", async () => {
    await allowlistChat();
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000037 })),
      testEnv(),
    );
    expect(response.status).toBe(200);

    await expect(getStoredProfile(CHAT_ID, USER_ID)).resolves.toMatchObject({
      display_name: "Test User",
      primary_language: "ja",
      observed_tone: "casual",
      observed_emoji_usage: "none",
    });
  });

  it("overwrites a previously observed style with the latest observation (no history kept)", async () => {
    await allowlistChat();
    await env.DB.prepare(
      "INSERT INTO speaker_profiles (chat_id, user_id, display_name, primary_language, observed_tone, observed_emoji_usage) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(CHAT_ID, USER_ID, "Synthetic Speaker", "pt-br", "formal", "frequent")
      .run();
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    await callWorker(webhookRequest(buildUpdate({ updateId: 930000038 })), testEnv());

    await expect(getStoredProfile(CHAT_ID, USER_ID)).resolves.toMatchObject({
      primary_language: "ja",
      observed_tone: "casual",
      observed_emoji_usage: "none",
    });
  });

  it("never writes an observed profile for a too-long message", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const tooLongText = "あ".repeat(2001);

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 930000039, text: tooLongText })),
      testEnv(),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(getStoredProfile(CHAT_ID, USER_ID)).resolves.toBeNull();
  });

  it("never writes an observed profile for an untargeted-language (skip) outcome", async () => {
    await allowlistChat();
    mockFetchDispatch({ openai: () => Promise.resolve(openAiSkipResponse()) });

    await callWorker(webhookRequest(buildUpdate({ updateId: 930000040 })), testEnv());

    await expect(getStoredProfile(CHAT_ID, USER_ID)).resolves.toBeNull();
  });
});

describe("POST /telegram/webhook — speaker memory: read failure", () => {
  it("returns 500 without calling OpenAI or Telegram when the memory read fails", async () => {
    await allowlistChat();
    const prepareSpy = mockD1PrepareFailureFor("FROM speaker_profiles WHERE chat_id");
    const fetchSpy = mockFetchDispatch({});

    try {
      const response = await callWorker(
        webhookRequest(buildUpdate({ updateId: 930000041 })),
        testEnv(),
      );
      expect(response.status).toBe(500);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
    }
  });

  // Phase 5 review, Issue 1: a transient D1 failure while reading speaker
  // memory must release the dedupe reservation, exactly like a transient
  // OpenAI/Telegram failure already does — otherwise Telegram's
  // redelivery of the same update is misclassified as a duplicate and
  // the message is never translated. See docs/architecture.md, "Speaker
  // memory read/write ordering".
  it("releases the dedupe reservation on a transient memory-read D1 failure, and a redelivery then succeeds", async () => {
    await allowlistChat();
    const updateId = 930000043;
    const failingPrepare = mockD1PrepareFailureFor("FROM speaker_profiles WHERE chat_id");
    const fetchSpy = mockFetchDispatch({});

    const first = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
    expect(first.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
    failingPrepare.mockRestore();

    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });
    const second = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ outcome: "translated" });
  });

  // Phase 5 review, Issue 1: a malformed (data-corrupted) D1 row is a
  // *permanent* failure, distinct from a transient query failure — a
  // real CHECK-constrained INSERT can never actually produce one, so
  // this simulates D1 returning corrupted data via a fixed-row fake.
  it("keeps the dedupe reservation on a malformed speaker-memory row (permanent failure)", async () => {
    await allowlistChat();
    const updateId = 930000044;
    const malformedRowPrepare = mockD1PrepareRowFor("FROM speaker_profiles WHERE chat_id", {
      chat_id: CHAT_ID,
      user_id: USER_ID,
      display_name: "Synthetic Speaker",
      primary_language: "ja",
      observed_tone: "super-formal", // invalid enum value — malformed row
      observed_emoji_usage: null,
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
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

describe("POST /telegram/webhook — speaker memory: write failure never turns a sent reply into a failure", () => {
  it("returns 200 translated and keeps the dedupe reservation when only the profile write fails", async () => {
    await allowlistChat();
    const updateId = 930000042;
    const prepareSpy = mockD1PrepareFailureFor("INSERT INTO speaker_profiles");
    mockFetchDispatch({
      openai: () => Promise.resolve(openAiTranslatedResponse()),
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    try {
      const response = await callWorker(webhookRequest(buildUpdate({ updateId })), testEnv());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
      await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
      await expect(getStoredProfile(CHAT_ID, USER_ID)).resolves.toBeNull();
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

  it("POST /health returns 404 (not the health handler)", async () => {
    const response = await callWorker(
      new Request("https://example.com/health", { method: "POST" }),
      testEnv(),
    );
    expect(response.status).toBe(404);
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
