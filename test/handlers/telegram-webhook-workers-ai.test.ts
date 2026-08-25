import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";
import type { WorkersAiBinding } from "../../src/infrastructure/workers-ai/client";

/**
 * Phase 9.1A: `POST /telegram/webhook` end to end with
 * `TRANSLATION_PROVIDER=workers-ai` (the new default —
 * `wrangler.jsonc`'s `env` already carries it). Individual tests may
 * override Gemini escalation when exercising the disabled path. `env.AI` is always overridden with a synthetic
 * in-memory fake — this file never calls the real Workers AI binding.
 * Every test that could reach OpenAI or Telegram installs its own
 * `globalThis.fetch` spy that throws on any unexpected call, so a wiring
 * bug that causes an unintended real network call (including a stray
 * call to OpenAI, which this provider mode must never make) fails the
 * test loudly instead of silently succeeding.
 */

const WEBHOOK_SECRET = "synthetic-test-webhook-secret-workers-ai-001";
const TELEGRAM_BOT_TOKEN = "0000000000:FAKE-TEST-WORKERS-AI-TOKEN-not-a-real-secret";
const CHAT_ID = -1009600000001;
const USER_ID = 793000001;
const MESSAGE_ID = 670000001;

interface RawUpdateFixture {
  update_id: number;
  message: Record<string, unknown>;
}

function buildUpdate(
  overrides: { updateId?: number; text?: unknown; chatId?: number } = {},
): RawUpdateFixture {
  const { updateId = 980000001, text = "こんにちは", chatId = CHAT_ID } = overrides;
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

interface TestEnvOverrides {
  readonly TELEGRAM_WEBHOOK_SECRET?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly OPENAI_API_KEY?: string;
  readonly GEMINI_ESCALATION_ENABLED?: string;
  readonly AI?: WorkersAiBinding;
}

/**
 * `OPENAI_API_KEY` is deliberately never set here — see "does not
 * require OPENAI_API_KEY" below. `wrangler types` narrows vars to their
 * exact configured literal values, while this file intentionally overrides
 * Gemini escalation to `"false"` for one disabled-path regression. The
 * single `as Env` below widens those runtime string vars back to the Worker
 * environment shape; it is not an unchecked double-cast. The real `env.AI`
 * (typed `Ai`, the full
 * generated Workers AI binding class) is always replaced with a
 * synthetic `WorkersAiBinding` — only the `run` method production code
 * actually calls. `WorkersAiBinding` is a real subtype-compatible
 * narrowing of `Ai` (every `Ai` value already satisfies it — see
 * `src/infrastructure/workers-ai/client.ts`), so casting the override
 * value back up to `Env["AI"]`'s type is a single, direction-justified
 * assertion, not an unsafe double-cast.
 */
function testEnv(overrides: TestEnvOverrides = {}): Env {
  const { AI: fakeAi, ...rest } = overrides;
  return {
    ...env,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN,
    ...rest,
    ...(fakeAi !== undefined ? { AI: fakeAi as Env["AI"] } : {}),
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

function chatCompletionResponse(payload: unknown): unknown {
  return { choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] };
}

const TRANSLATED_PAYLOAD = {
  detectedLanguage: "ja",
  action: "translate",
  targetLanguage: "pt-br",
  translatedText: "mensagem sintética de teste",
  styleSignals: { tone: "casual", emojiUsage: "none" },
  needsEscalation: false,
  escalationReason: "none",
};

function fakeAiBinding(run: WorkersAiBinding["run"]): WorkersAiBinding {
  return { run };
}

function alwaysReturns(response: unknown): WorkersAiBinding {
  return fakeAiBinding(vi.fn(() => Promise.resolve(response)));
}

function alwaysThrows(error: Error): WorkersAiBinding {
  return fakeAiBinding(vi.fn(() => Promise.reject(error)));
}

function telegramSendMessageResponse(messageId = 999999005): Response {
  return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: CHAT_ID } } });
}

/** Throws on any fetch call — Workers AI mode goes through `env.AI`, never `fetch`, for the provider call itself; only Telegram may legitimately use `fetch`. */
function mockFetchDispatch(handlers: {
  telegram?: (url: string, init: RequestInit) => Response | Promise<Response>;
}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.telegram.org/")) {
        if (!handlers.telegram) {
          throw new Error(`unexpected Telegram fetch call in test: ${url}`);
        }
        return handlers.telegram(url, init ?? {});
      }
      throw new Error(
        `unexpected fetch call in test (Workers AI mode must never use fetch): ${url}`,
      );
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

describe("POST /telegram/webhook — workers-ai routine provider", () => {
  it("uses Workers AI and posts a translated reply, never touching OpenAI", async () => {
    await allowlistChat();
    const run = vi.fn(() => Promise.resolve(chatCompletionResponse(TRANSLATED_PAYLOAD)));
    const fetchSpy = mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 980000010 })),
      testEnv({ AI: fakeAiBinding(run) }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
    expect(run).toHaveBeenCalledTimes(1);
    // Only Telegram's sendMessage was ever fetched — never OpenAI.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    const calledInput = call?.[0];
    const calledUrl =
      typeof calledInput === "string"
        ? calledInput
        : calledInput instanceof URL
          ? calledInput.toString()
          : (calledInput?.url ?? "");
    expect(calledUrl).toContain("api.telegram.org");
  });

  it("does not require or read OPENAI_API_KEY", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });
    const testConfig = testEnv({ AI: alwaysReturns(chatCompletionResponse(TRANSLATED_PAYLOAD)) });
    expect(testConfig.OPENAI_API_KEY).toBeUndefined();

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 980000011 })),
      testConfig,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
  });

  it("returns a skip outcome for an untargeted-language message, with no Telegram reply", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const skipPayload = {
      detectedLanguage: "other",
      action: "skip",
      targetLanguage: null,
      translatedText: null,
      styleSignals: null,
      needsEscalation: false,
      escalationReason: "none",
    };

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 980000012, text: "🎉🎉🎉" })),
      testEnv({ AI: alwaysReturns(chatCompletionResponse(skipPayload)) }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:untargeted-language",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /telegram/webhook — workers-ai transient failure", () => {
  it("returns 500 and releases the dedupe reservation so a redelivery can be retried", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 980000020;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: alwaysThrows(new Error("synthetic 503 workers ai outage")) }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
  });
});

/**
 * Phase 9.1A review hardening: the error classifier's default flipped
 * from "unrecognized ⇒ permanent" to "unrecognized ⇒ transient" (see
 * src/infrastructure/workers-ai/client.ts). These two tests are the
 * webhook-level proof that the flip actually changes dedupe behavior end
 * to end, and that a genuinely deterministic (config/request-shaped)
 * failure still keeps the reservation as before. Neither case ever
 * reaches OpenAI — `mockFetchDispatch({})` throws on any unexpected
 * fetch call, so a stray OpenAI call would fail the test loudly.
 */
describe("POST /telegram/webhook — workers-ai call-layer failure classification (Phase 9.1A review hardening)", () => {
  it("an unrecognized Workers AI call failure releases the dedupe reservation (transient by default)", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 980000021;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: alwaysThrows(new Error("some completely unrecognized failure shape")) }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
  });

  it("a known-permanent Workers AI config/request failure keeps the dedupe reservation", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 980000022;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: alwaysThrows(new Error("invalid model: unknown model identifier")) }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);

    const redelivery = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: alwaysThrows(new Error("invalid model: unknown model identifier")) }),
    );
    await expect(redelivery.json()).resolves.toMatchObject({ outcome: "ignored:duplicate" });
  });
});

describe("POST /telegram/webhook — workers-ai permanent (malformed) failure", () => {
  it("returns 500 and keeps the dedupe reservation, so a redelivery is a harmless duplicate", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 980000030;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: alwaysReturns({ choices: [{ message: { content: "not valid json {" } }] }) }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);

    const redelivery = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: alwaysReturns({ choices: [{ message: { content: "not valid json {" } }] }) }),
    );
    await expect(redelivery.json()).resolves.toMatchObject({ outcome: "ignored:duplicate" });
  });
});

describe("POST /telegram/webhook — escalation required (Phase 9.1A, no Gemini yet)", () => {
  it("responds ignored:escalation-unavailable with no Telegram reply and no OpenAI call", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 980000040;
    const escalationPayload = {
      ...TRANSLATED_PAYLOAD,
      needsEscalation: true,
      escalationReason: "ambiguous-context",
    };

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        GEMINI_ESCALATION_ENABLED: "false",
        AI: alwaysReturns(chatCompletionResponse(escalationPayload)),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:escalation-unavailable",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Dedupe reservation kept — a redelivery is a plain duplicate, not retried.
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — commands never invoke any AI provider", () => {
  it.each(["/help", "/status"])("never calls Workers AI for %s", async (commandText) => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });
    const run = vi.fn(() => {
      throw new Error("Workers AI must never be called for a command message");
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 980000050 + commandText.length, text: commandText })),
      testEnv({ AI: fakeAiBinding(run) }),
    );

    expect(response.status).toBe(200);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("POST /telegram/webhook — speaker memory ordering under workers-ai", () => {
  it("reads memory once and writes the observed profile only after a successful reply", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 980000060 })),
      testEnv({ AI: alwaysReturns(chatCompletionResponse(TRANSLATED_PAYLOAD)) }),
    );

    expect(response.status).toBe(200);
    await expect(getStoredProfile(CHAT_ID, USER_ID)).resolves.toMatchObject({
      primary_language: "ja",
      observed_tone: "casual",
      observed_emoji_usage: "none",
    });
  });
});

describe("POST /telegram/webhook — workers-ai structured logging never leaks sensitive data", () => {
  it("never logs the source message text, translated text, or a raw error message", async () => {
    await allowlistChat();
    const identifiableMessageText = "synthetic-identifiable-workers-ai-message-9d1c";
    const identifiableErrorDetail = "synthetic-identifiable-workers-ai-raw-error-3e7b";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetchDispatch({});

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 980000070, text: identifiableMessageText })),
      testEnv({ AI: alwaysThrows(new Error(identifiableErrorDetail)) }),
    );
    expect(response.status).toBe(500);

    const loggedLines = consoleSpy.mock.calls.map((call) => call.join(" "));
    for (const line of loggedLines) {
      expect(line).not.toContain(identifiableMessageText);
      expect(line).not.toContain(identifiableErrorDetail);
      expect(line).not.toContain(WEBHOOK_SECRET);
      expect(line).not.toContain(TELEGRAM_BOT_TOKEN);
    }
    consoleSpy.mockRestore();
  });

  it("logs the provider as workers-ai on a successful translation", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 980000071 })),
      testEnv({ AI: alwaysReturns(chatCompletionResponse(TRANSLATED_PAYLOAD)) }),
    );

    const lastLine = consoleSpy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed.provider).toBe("workers-ai");
    consoleSpy.mockRestore();
  });
});
