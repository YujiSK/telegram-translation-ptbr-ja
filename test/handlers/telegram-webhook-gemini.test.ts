import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";
import type { WorkersAiBinding } from "../../src/infrastructure/workers-ai/client";

/**
 * Phase 9.1B: `POST /telegram/webhook` end to end with
 * `TRANSLATION_PROVIDER=workers-ai` and `GEMINI_ESCALATION_ENABLED=true`
 * (both the pilot `wrangler.jsonc` setting and this file's `testEnv` default).
 * `env.AI` is always
 * a synthetic in-memory fake; Gemini is reached only through `fetch`,
 * which every test that could reach it also mocks. No test in this file
 * ever performs a real Workers AI, Gemini, or Telegram API call.
 */

const WEBHOOK_SECRET = "synthetic-test-webhook-secret-gemini-001";
const TELEGRAM_BOT_TOKEN = "0000000000:FAKE-TEST-GEMINI-TOKEN-not-a-real-secret";
const GEMINI_API_KEY = "synthetic-test-gemini-key-webhook-001";
const CHAT_ID = -1009700000001;
const USER_ID = 794000001;
const MESSAGE_ID = 671000001;

interface RawUpdateFixture {
  update_id: number;
  message: Record<string, unknown>;
}

function buildUpdate(
  overrides: { updateId?: number; text?: unknown; chatId?: number } = {},
): RawUpdateFixture {
  const { updateId = 981000001, text = "こんにちは", chatId = CHAT_ID } = overrides;
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
 * value (e.g. `GEMINI_ESCALATION_ENABLED: "true"`), not `string` — see
 * the identical widening pattern and rationale in
 * test/handlers/telegram-webhook-reliability.test.ts. `AI` and
 * `TRANSLATION_PROVIDER` are widened for the same reason (this file also
 * needs to switch to `openai` mode for one regression test). The single
 * `as Env` below reflects that every `vars` entry is a plain string at
 * runtime regardless of what TypeScript narrowed it to from
 * `wrangler.jsonc`'s default value.
 */
interface TestEnvOverrides {
  readonly TELEGRAM_WEBHOOK_SECRET?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TRANSLATION_PROVIDER?: string;
  readonly OPENAI_MODEL?: string;
  readonly OPENAI_API_KEY?: string;
  readonly AI?: WorkersAiBinding;
  readonly GEMINI_ESCALATION_ENABLED?: string;
  readonly GEMINI_MODEL?: string;
  readonly MAX_GEMINI_ATTEMPTS_PER_MINUTE?: string;
  readonly MAX_GEMINI_ATTEMPTS_PER_DAY?: string;
  /** `| undefined` (not just optional) so a test can explicitly unset the default GEMINI_API_KEY to simulate "Secret not registered" — required under this project's `exactOptionalPropertyTypes`. */
  readonly GEMINI_API_KEY?: string | undefined;
}

function testEnv(overrides: TestEnvOverrides = {}): Env {
  const { AI: fakeAi, ...rest } = overrides;
  return {
    ...env,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN,
    GEMINI_ESCALATION_ENABLED: "true",
    GEMINI_MODEL: "gemini-3.5-flash-lite",
    MAX_GEMINI_ATTEMPTS_PER_MINUTE: "12",
    MAX_GEMINI_ATTEMPTS_PER_DAY: "450",
    GEMINI_API_KEY,
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

function workersAiChatCompletionResponse(payload: unknown): unknown {
  return { choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] };
}

function geminiInteractionResponse(payload: unknown): Record<string, unknown> {
  return {
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(payload) }] }],
  };
}

const WORKERS_AI_ESCALATION_PAYLOAD = {
  detectedLanguage: "ja",
  action: "translate",
  targetLanguage: "pt-br",
  translatedText: "workers-ai provisional (should never be replied)",
  styleSignals: { tone: "casual", emojiUsage: "none" },
  needsEscalation: true,
  escalationReason: "ambiguous-context",
};

const WORKERS_AI_NON_ESCALATION_PAYLOAD = {
  detectedLanguage: "ja",
  action: "translate",
  targetLanguage: "pt-br",
  translatedText: "mensagem sintética de teste",
  styleSignals: { tone: "casual", emojiUsage: "none" },
  needsEscalation: false,
  escalationReason: "none",
};

const GEMINI_FINAL_PAYLOAD = {
  detectedLanguage: "ja",
  action: "translate",
  targetLanguage: "pt-br",
  translatedText: "resposta final do gemini",
  styleSignals: { tone: "formal", emojiUsage: "none" },
};

function fakeAiBinding(run: WorkersAiBinding["run"]): WorkersAiBinding {
  return { run };
}

function workersAiAlwaysReturns(response: unknown): WorkersAiBinding {
  return fakeAiBinding(vi.fn(() => Promise.resolve(response)));
}

function telegramSendMessageResponse(messageId = 999999006): Response {
  return jsonResponse({ ok: true, result: { message_id: messageId, chat: { id: CHAT_ID } } });
}

/** Dispatches by URL prefix — Telegram, Gemini, or an unexpected/unmocked call (which throws loudly). Workers AI never goes through `fetch` at all. */
function mockFetchDispatch(handlers: {
  telegram?: (url: string, init: RequestInit) => Response | Promise<Response>;
  gemini?: (url: string, init: RequestInit) => Response | Promise<Response>;
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
      if (url.startsWith("https://generativelanguage.googleapis.com/")) {
        if (!handlers.gemini) {
          throw new Error(`unexpected Gemini fetch call in test: ${url}`);
        }
        return handlers.gemini(url, init ?? {});
      }
      throw new Error(`unexpected fetch call in test: ${url}`);
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
    env.DB.prepare("DELETE FROM provider_usage_counters"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /telegram/webhook — routine Workers AI translation, Gemini enabled but not needed", () => {
  it("translates via Workers AI with zero Gemini calls when needsEscalation is false", async () => {
    await allowlistChat();
    const run = vi.fn(() =>
      Promise.resolve(workersAiChatCompletionResponse(WORKERS_AI_NON_ESCALATION_PAYLOAD)),
    );
    const fetchSpy = mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000010 })),
      testEnv({ AI: fakeAiBinding(run) }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Telegram only.
  });
});

describe("POST /telegram/webhook — semantic escalation to Gemini", () => {
  it("calls Gemini and replies with Gemini's translation, not the Workers AI provisional one", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
      gemini: () => Promise.resolve(jsonResponse(geminiInteractionResponse(GEMINI_FINAL_PAYLOAD))),
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000020 })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
    expect(fetchSpy).toHaveBeenCalledTimes(2); // Gemini, then Telegram.

    const telegramCall = fetchSpy.mock.calls.find((call) => {
      const url = call[0];
      return typeof url === "string" && url.startsWith("https://api.telegram.org/");
    });
    const body = telegramCall?.[1]?.body;
    expect(typeof body === "string" ? body : "").toContain("resposta final do gemini");
    expect(typeof body === "string" ? body : "").not.toContain("workers-ai provisional");
  });

  it("the final speaker-style write uses Gemini's final style, not Workers AI's provisional one", async () => {
    await allowlistChat();
    mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
      gemini: () => Promise.resolve(jsonResponse(geminiInteractionResponse(GEMINI_FINAL_PAYLOAD))),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000021 })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    await expect(getStoredProfile(CHAT_ID, USER_ID)).resolves.toMatchObject({
      observed_tone: "formal", // Gemini's style, not Workers AI's provisional "casual".
      observed_emoji_usage: "none",
    });
  });

  it("logs provider=gemini for a successfully escalated translation", async () => {
    await allowlistChat();
    mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
      gemini: () => Promise.resolve(jsonResponse(geminiInteractionResponse(GEMINI_FINAL_PAYLOAD))),
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000022 })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    const lastLine = consoleSpy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed.provider).toBe("gemini");
    consoleSpy.mockRestore();
  });
});

describe("POST /telegram/webhook — escalation disabled (Phase 9.1A behavior preserved)", () => {
  it("responds ignored:escalation-unavailable and never calls Gemini or OpenAI when GEMINI_ESCALATION_ENABLED=false", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 981000030;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        GEMINI_ESCALATION_ENABLED: "false",
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:escalation-unavailable",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — Gemini enabled but the Secret is missing", () => {
  it("fails safely (500, no external call) rather than calling Gemini without a key", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 981000040;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        GEMINI_API_KEY: undefined,
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Not released — a persistent misconfiguration wouldn't be fixed by a retry.
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });

  it("a routine (non-escalating) translation still succeeds even with no Gemini key", async () => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000041 })),
      testEnv({
        GEMINI_API_KEY: undefined,
        AI: workersAiAlwaysReturns(
          workersAiChatCompletionResponse(WORKERS_AI_NON_ESCALATION_PAYLOAD),
        ),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
  });
});

describe("POST /telegram/webhook — Gemini budget exhausted", () => {
  it("minute budget exhausted: no Gemini call, 200 escalation-unavailable, dedupe kept", async () => {
    await allowlistChat();
    // Exhaust the minute budget directly, before the webhook call.
    for (let i = 0; i < 12; i += 1) {
      await env.DB.prepare(
        `INSERT INTO provider_usage_counters (provider, scope_type, scope_id, window_id, attempt_count)
         VALUES ('gemini', 'global_minute', 0, ?1, 1)
         ON CONFLICT (provider, scope_type, scope_id) DO UPDATE SET attempt_count = attempt_count + 1, window_id = ?1`,
      )
        .bind(Math.floor(Date.now() / 60_000))
        .run();
    }
    const fetchSpy = mockFetchDispatch({});
    const updateId = 981000050;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:escalation-unavailable",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });

  it("daily budget exhausted: no Gemini call, 200 escalation-unavailable, dedupe kept", async () => {
    await allowlistChat();
    for (let i = 0; i < 450; i += 1) {
      await env.DB.prepare(
        `INSERT INTO provider_usage_counters (provider, scope_type, scope_id, window_id, attempt_count)
         VALUES ('gemini', 'global_day', 0, ?1, 1)
         ON CONFLICT (provider, scope_type, scope_id) DO UPDATE SET attempt_count = attempt_count + 1, window_id = ?1`,
      )
        .bind(Math.floor(Date.now() / 86_400_000))
        .run();
    }
    const fetchSpy = mockFetchDispatch({});
    const updateId = 981000051;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:escalation-unavailable",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });

  it("a transient D1 failure while reserving the Gemini budget releases the dedupe reservation", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 981000052;
    const realPrepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("provider_usage_counters")) {
        throw new Error("synthetic D1 outage during Gemini budget reservation");
      }
      return realPrepare(query);
    });

    try {
      const response = await callWorker(
        webhookRequest(buildUpdate({ updateId })),
        testEnv({
          AI: workersAiAlwaysReturns(
            workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD),
          ),
        }),
      );

      expect(response.status).toBe(500);
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("POST /telegram/webhook — Gemini call-layer failures", () => {
  it("a transient Gemini failure returns 500 and releases the dedupe reservation", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({
      gemini: () => Promise.resolve(jsonResponse({ error: { message: "server error" } }, 503)),
    });
    const updateId = 981000060;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Gemini only — no Telegram reply, no OpenAI.
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
  });

  it("a permanent Gemini failure returns 500 and keeps the dedupe reservation", async () => {
    await allowlistChat();
    mockFetchDispatch({
      gemini: () => Promise.resolve(jsonResponse({ error: { message: "forbidden" } }, 403)),
    });
    const updateId = 981000061;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(500);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);

    const redelivery = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );
    await expect(redelivery.json()).resolves.toMatchObject({ outcome: "ignored:duplicate" });
  });

  it("an in-progress Gemini interaction returns 500 and releases dedupe, with no Telegram/OpenAI fallback", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({
      gemini: () =>
        Promise.resolve(
          jsonResponse({
            ...geminiInteractionResponse(GEMINI_FINAL_PAYLOAD),
            status: "in_progress",
          }),
        ),
    });
    const updateId = 981000063;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
  });

  it("an incomplete Gemini interaction returns 500 and keeps dedupe", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({
      gemini: () =>
        Promise.resolve(
          jsonResponse({
            ...geminiInteractionResponse(GEMINI_FINAL_PAYLOAD),
            status: "incomplete",
          }),
        ),
    });
    const updateId = 981000064;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });

  it("malformed Gemini output returns 500 and keeps the dedupe reservation", async () => {
    await allowlistChat();
    mockFetchDispatch({
      gemini: () =>
        Promise.resolve(
          jsonResponse({
            steps: [{ type: "model_output", content: [{ type: "text", text: "not json {" }] }],
          }),
        ),
    });
    const updateId = 981000062;

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(response.status).toBe(500);
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — Gemini failure diagnostics (pilot incident diagnostics)", () => {
  it("logs stage=http, httpStatus, endpointVersion, and model for a transient Gemini HTTP failure", async () => {
    await allowlistChat();
    mockFetchDispatch({
      gemini: () => Promise.resolve(jsonResponse({ error: { message: "server error" } }, 503)),
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const updateId = 981000065;

    await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    const lastLine = consoleSpy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed.service).toBe("gemini");
    expect(parsed.stage).toBe("http");
    expect(parsed.httpStatus).toBe(503);
    expect(parsed.endpointVersion).toBe("v1");
    expect(parsed.model).toBe("gemini-3.5-flash-lite");
    consoleSpy.mockRestore();
  });

  it("logs stage=interaction-status and interactionStatus for an incomplete Gemini interaction", async () => {
    await allowlistChat();
    mockFetchDispatch({
      gemini: () =>
        Promise.resolve(
          jsonResponse({
            ...geminiInteractionResponse(GEMINI_FINAL_PAYLOAD),
            status: "incomplete",
          }),
        ),
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const updateId = 981000066;

    await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    const lastLine = consoleSpy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed.service).toBe("gemini");
    expect(parsed.stage).toBe("interaction-status");
    expect(parsed.interactionStatus).toBe("incomplete");
    consoleSpy.mockRestore();
  });

  it("never logs the raw response body, message text, or API key for any Gemini failure diagnostic", async () => {
    const identifiableDetail = "synthetic-identifiable-gemini-webhook-diagnostic-leak-2e9a";
    await allowlistChat();
    mockFetchDispatch({
      gemini: () => Promise.resolve(jsonResponse({ error: { message: identifiableDetail } }, 503)),
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const updateId = 981000067;

    await callWorker(
      webhookRequest(buildUpdate({ updateId, text: "diagnostic leak canary text" })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    const loggedLines = consoleSpy.mock.calls.map((call) => call.join(" "));
    for (const line of loggedLines) {
      expect(line).not.toContain(identifiableDetail);
      expect(line).not.toContain("diagnostic leak canary text");
      expect(line).not.toContain(GEMINI_API_KEY);
    }
    consoleSpy.mockRestore();
  });
});

describe("POST /telegram/webhook — Workers AI failures never reach Gemini", () => {
  it("a transient Workers AI failure never calls Gemini, and releases the dedupe reservation", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 981000070;
    const run = vi.fn(() => Promise.reject(new Error("synthetic 503 workers ai outage")));

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: fakeAiBinding(run) }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled(); // No Gemini, no Telegram.
    await expect(isUpdateRecorded(updateId)).resolves.toBe(false);
  });

  it("a permanent Workers AI failure never calls Gemini, and keeps the dedupe reservation", async () => {
    await allowlistChat();
    const fetchSpy = mockFetchDispatch({});
    const updateId = 981000071;
    const run = vi.fn(() => Promise.reject(new Error("invalid model: unknown model identifier")));

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId })),
      testEnv({ AI: fakeAiBinding(run) }),
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(isUpdateRecorded(updateId)).resolves.toBe(true);
  });
});

describe("POST /telegram/webhook — commands never invoke Gemini (or any AI provider)", () => {
  it.each(["/help", "/status"])("never calls Gemini or Workers AI for %s", async (commandText) => {
    await allowlistChat();
    mockFetchDispatch({ telegram: () => Promise.resolve(telegramSendMessageResponse()) });
    const run = vi.fn(() => {
      throw new Error("Workers AI must never be called for a command message");
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000080 + commandText.length, text: commandText })),
      testEnv({ AI: fakeAiBinding(run) }),
    );

    expect(response.status).toBe(200);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("POST /telegram/webhook — legacy OpenAI path regression (unaffected by Gemini)", () => {
  it("openai mode still translates via OpenAI only, with zero Workers AI/Gemini calls", async () => {
    await allowlistChat();
    const run = vi.fn(() => {
      throw new Error("Workers AI must never be called in openai mode");
    });
    const openaiPayload = {
      detectedLanguage: "ja",
      action: "translate",
      targetLanguage: "pt-br",
      translatedText: "openai translation",
      styleSignals: { tone: "casual", emojiUsage: "none" },
    };
    const dispatch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith("https://api.telegram.org/")) {
          return Promise.resolve(telegramSendMessageResponse());
        }
        if (url.startsWith("https://api.openai.com/")) {
          return Promise.resolve(
            jsonResponse({
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: JSON.stringify(openaiPayload) }],
                },
              ],
            }),
          );
        }
        throw new Error(`unexpected fetch call in test: ${url}`);
      });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000090 })),
      testEnv({
        TRANSLATION_PROVIDER: "openai",
        OPENAI_MODEL: "gpt-4o-mini",
        OPENAI_API_KEY: "synthetic-test-openai-key-in-gemini-file",
        AI: fakeAiBinding(run),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
    expect(run).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("POST /telegram/webhook — Gemini security/privacy invariants", () => {
  it("every Gemini request includes store: false", async () => {
    await allowlistChat();
    const geminiFetch = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(geminiInteractionResponse(GEMINI_FINAL_PAYLOAD))),
    );
    mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
      gemini: geminiFetch,
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000100 })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    expect(geminiFetch).toHaveBeenCalledTimes(1);
    const call = geminiFetch.mock.calls[0];
    const rawBody = call?.[1]?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<
      string,
      unknown
    >;
    expect(body.store).toBe(false);
  });

  it("the API key is never sent in the URL, and never logged", async () => {
    await allowlistChat();
    const geminiFetch = vi.fn((url: string) => {
      expect(url).not.toContain(GEMINI_API_KEY);
      return Promise.resolve(jsonResponse(geminiInteractionResponse(GEMINI_FINAL_PAYLOAD)));
    });
    mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
      gemini: geminiFetch,
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000101 })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    const loggedLines = consoleSpy.mock.calls.map((call) => call.join(" "));
    for (const line of loggedLines) {
      expect(line).not.toContain(GEMINI_API_KEY);
    }
    consoleSpy.mockRestore();
  });

  it("never logs the source message text, translated text, or a raw Gemini error message", async () => {
    await allowlistChat();
    const identifiableMessageText = "synthetic-identifiable-gemini-message-4e8a";
    const identifiableErrorDetail = "synthetic-identifiable-gemini-raw-error-2c9d";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetchDispatch({
      gemini: () =>
        Promise.resolve(jsonResponse({ error: { message: identifiableErrorDetail } }, 400)),
    });

    const response = await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000102, text: identifiableMessageText })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );
    expect(response.status).toBe(500);

    const loggedLines = consoleSpy.mock.calls.map((call) => call.join(" "));
    for (const line of loggedLines) {
      expect(line).not.toContain(identifiableMessageText);
      expect(line).not.toContain(identifiableErrorDetail);
      expect(line).not.toContain(WEBHOOK_SECRET);
      expect(line).not.toContain(TELEGRAM_BOT_TOKEN);
      expect(line).not.toContain(GEMINI_API_KEY);
    }
    consoleSpy.mockRestore();
  });

  it("never logs a Gemini interaction/response ID", async () => {
    await allowlistChat();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const identifiableInteractionId = "synthetic-identifiable-interaction-id-7f1a";
    mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
      gemini: () =>
        Promise.resolve(
          jsonResponse({
            id: identifiableInteractionId,
            steps: [
              {
                type: "model_output",
                content: [{ type: "text", text: JSON.stringify(GEMINI_FINAL_PAYLOAD) }],
              },
            ],
          }),
        ),
    });

    await callWorker(
      webhookRequest(buildUpdate({ updateId: 981000103 })),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    const loggedLines = consoleSpy.mock.calls.map((call) => call.join(" "));
    for (const line of loggedLines) {
      expect(line).not.toContain(identifiableInteractionId);
    }
    consoleSpy.mockRestore();
  });

  it("includes at most one reply context in the Gemini request — no broader conversation history", async () => {
    await allowlistChat();
    const geminiFetch = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(geminiInteractionResponse(GEMINI_FINAL_PAYLOAD))),
    );
    mockFetchDispatch({
      telegram: () => Promise.resolve(telegramSendMessageResponse()),
      gemini: geminiFetch,
    });
    const update = buildUpdate({ updateId: 981000104 });
    update.message.reply_to_message = {
      message_id: MESSAGE_ID - 1,
      date: 1699999999,
      chat: { id: CHAT_ID, type: "group" },
      from: { id: USER_ID + 1, is_bot: false, first_name: "Other User" },
      text: "previous message for context",
    };

    await callWorker(
      webhookRequest(update),
      testEnv({
        AI: workersAiAlwaysReturns(workersAiChatCompletionResponse(WORKERS_AI_ESCALATION_PAYLOAD)),
      }),
    );

    const call = geminiFetch.mock.calls[0];
    const rawBody = call?.[1]?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<
      string,
      unknown
    >;
    const inputText = typeof body.input === "string" ? body.input : "";
    expect(inputText).toContain("previous message for context");
    expect(inputText.match(/REPLY CONTEXT/g)?.length).toBe(1);
  });
});
