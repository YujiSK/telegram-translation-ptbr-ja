import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { minuteWindowId, utcDayId } from "../../src/shared/time-windows";

const CHAT_ID = -1009700000091;
const USER_ID = 794000091;
const UPDATE_ID = 981000091;
const clearJapanese =
  "\u660e\u65e5\u306e\u5348\u5f8c\u306f\u5bb6\u65cf\u3068\u4e00\u7dd2\u306b\u516c\u5712\u3078\u904a\u3073\u306b\u884c\u304d\u307e\u3059\u3002";
const key = "synthetic-deepl-key:fx";
const secret = "synthetic-webhook-secret";

function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return {
    ...env,
    TRANSLATION_PROVIDER: "deepl",
    TELEGRAM_WEBHOOK_SECRET: secret,
    TELEGRAM_BOT_TOKEN: "synthetic-token",
    DEEPL_API_KEY: key,
    GEMINI_API_KEY: "synthetic-gemini",
    GEMINI_ESCALATION_ENABLED: "true",
    ...overrides,
  };
}
async function deliver(
  text = clearJapanese,
  overrides: Record<string, string | undefined> = {},
  reply = false,
) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://example.com/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({
        update_id: UPDATE_ID,
        message: {
          message_id: 671000091,
          date: 1700000000,
          chat: { id: CHAT_ID, type: "group" },
          from: { id: USER_ID, is_bot: false, first_name: "Synthetic" },
          text,
          ...(reply
            ? { reply_to_message: { message_id: 671000090, text: "synthetic reply context" } }
            : {}),
        },
      }),
    }),
    testEnv(overrides),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function mockProviders(deeplStatus = 200, detected = "JA", geminiStatus = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://api-free.deepl.com/v2/translate")
      return Promise.resolve(
        Response.json(
          deeplStatus === 200
            ? {
                translations: [
                  { text: "synthetic translated output", detected_source_language: detected },
                ],
              }
            : { message: "private raw failure body" },
          { status: deeplStatus },
        ),
      );
    if (url.startsWith("https://generativelanguage.googleapis.com/"))
      return Promise.resolve(
        Response.json(
          {
            status: "completed",
            steps: [
              {
                type: "model_output",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      detectedLanguage: "ja",
                      action: "translate",
                      targetLanguage: "pt-br",
                      translatedText: "synthetic Gemini output",
                      styleSignals: { tone: "neutral", emojiUsage: "none" },
                    }),
                  },
                ],
              },
            ],
          },
          { status: geminiStatus },
        ),
      );
    if (url.startsWith("https://api.telegram.org/"))
      return Promise.resolve(
        Response.json({ ok: true, result: { message_id: 999999091, chat: { id: CHAT_ID } } }),
      );
    throw new Error("Unexpected mocked HTTP destination");
  });
}
async function recorded() {
  return (
    (await env.DB.prepare("SELECT 1 FROM processed_updates WHERE update_id = ?1")
      .bind(UPDATE_ID)
      .first()) !== null
  );
}
async function count(table: "provider_usage_counters" | "openai_daily_usage" | "speaker_profiles") {
  // Fixed query allowlist; no dynamically interpolated SQL.
  const queries = {
    provider_usage_counters: "SELECT COUNT(*) AS n FROM provider_usage_counters",
    openai_daily_usage: "SELECT COUNT(*) AS n FROM openai_daily_usage",
    speaker_profiles: "SELECT COUNT(*) AS n FROM speaker_profiles",
  };
  return (await env.DB.prepare(queries[table]).first<{ n: number }>())?.n;
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
  await env.DB.prepare("INSERT INTO allowed_chats (chat_id) VALUES (?1)").bind(CHAT_ID).run();
});
afterEach(() => vi.restoreAllMocks());

describe("DeepL webhook", () => {
  it.each(["global_minute", "global_day"])(
    "reuses exhausted Gemini %s budget without calling any provider",
    async (scope) => {
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO provider_usage_counters (provider, scope_type, scope_id, window_id, attempt_count) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
        .bind(
          "gemini",
          scope,
          0,
          scope === "global_minute" ? minuteWindowId(now) : utcDayId(now),
          10000,
        )
        .run();
      const calls = mockProviders();
      const response = await deliver("\u3046\u3093");
      await expect(response.json()).resolves.toMatchObject({
        outcome: "ignored:escalation-unavailable",
      });
      expect(calls).not.toHaveBeenCalled();
      expect(await recorded()).toBe(true);
    },
  );
  it.each(["preference", "correction"])(
    "routes applicable %s from D1 directly to Gemini",
    async (kind) => {
      if (kind === "preference") {
        await env.DB.prepare(
          "INSERT INTO speaker_preferences (chat_id, user_id, preference_key, preference_value) VALUES (?1, ?2, ?3, ?4)",
        )
          .bind(CHAT_ID, USER_ID, "tone", "formal")
          .run();
      } else {
        await env.DB.prepare(
          "INSERT INTO translation_corrections (chat_id, user_id, source_language, target_language, source_term, target_term) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
          .bind(CHAT_ID, USER_ID, "ja", "pt-br", "\u5bb6\u65cf", "família")
          .run();
      }
      const calls = mockProviders();
      expect((await deliver()).status).toBe(200);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(calls.mock.calls[0]?.[0]).toContain("generativelanguage.googleapis.com");
    },
  );
  it("uses the default mode, no Gemini/OpenAI budget, no invented style, and safe logs", async () => {
    expect(env.TRANSLATION_PROVIDER).toBe("deepl");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const calls = mockProviders();
    const response = await deliver(clearJapanese, {
      GEMINI_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "translated" });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[0]?.[0]).toContain("deepl.com");
    expect(await count("provider_usage_counters")).toBe(0);
    expect(await count("openai_daily_usage")).toBe(0);
    expect(await count("speaker_profiles")).toBe(0);
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).toContain("deepl");
    for (const value of [clearJapanese, key, secret, "synthetic translated output"])
      expect(logs).not.toContain(value);
  });
  it("calls only Gemini for short contextual Japanese", async () => {
    const calls = mockProviders();
    expect((await deliver("\u3046\u3093")).status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[0]?.[0]).toContain("generativelanguage.googleapis.com");
    expect(await count("provider_usage_counters")).toBe(2);
    expect(await count("openai_daily_usage")).toBe(0);
  });
  it("routes Japanese with a Latin proper name to DeepL", async () => {
    const calls = mockProviders();
    expect(
      (
        await deliver(
          "\u660e\u65e5\u306fMaria\u3068\u4e00\u7dd2\u306b\u51fa\u304b\u3051\u307e\u3059",
        )
      ).status,
    ).toBe(200);
    expect(calls.mock.calls[0]?.[0]).toContain("deepl.com");
    expect(calls).toHaveBeenCalledTimes(2);
    expect(await count("provider_usage_counters")).toBe(0);
  });
  it("routes clear reply Japanese to DeepL", async () => {
    const calls = mockProviders();
    expect((await deliver(clearJapanese, {}, true)).status).toBe(200);
    expect(calls.mock.calls[0]?.[0]).toContain("deepl.com");
    expect(calls).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, "", "   "])("fails safely without DeepL key: %s", async (apiKey) => {
    const calls = mockProviders();
    expect((await deliver(clearJapanese, { DEEPL_API_KEY: apiKey })).status).toBe(500);
    expect(calls).not.toHaveBeenCalled();
    expect(await recorded()).toBe(true);
  });
  it("does not require the DeepL key on a direct Gemini route", async () => {
    const calls = mockProviders();
    expect((await deliver("\u3046\u3093", { DEEPL_API_KEY: undefined })).status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[0]?.[0]).toContain("generativelanguage.googleapis.com");
  });
  it("checks missing Gemini key before reserving its budget", async () => {
    const calls = mockProviders();
    expect((await deliver("\u3046\u3093", { GEMINI_API_KEY: undefined })).status).toBe(500);
    expect(calls).not.toHaveBeenCalled();
    expect(await count("provider_usage_counters")).toBe(0);
  });
  it("does not send sensitive input to DeepL when Gemini is disabled", async () => {
    const calls = mockProviders();
    const response = await deliver("\u3046\u3093", { GEMINI_ESCALATION_ENABLED: "false" });
    await expect(response.json()).resolves.toMatchObject({
      outcome: "ignored:escalation-unavailable",
    });
    expect(calls).not.toHaveBeenCalled();
    expect(await recorded()).toBe(true);
  });
  it.each([429, 503, 403, 456])(
    "never falls back on DeepL HTTP %s and preserves dedupe policy",
    async (status) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const calls = mockProviders(status);
      await deliver();
      expect(calls).toHaveBeenCalledTimes(1);
      expect(await recorded()).toBe(status < 500 && status !== 429);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private raw failure body");
      expect(await count("provider_usage_counters")).toBe(0);
    },
  );
  it("skips non-PT Latin without Telegram or Gemini", async () => {
    const calls = mockProviders(200, "EN");
    const response = await deliver("Hello world");
    expect(response.status).toBe(200);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await recorded()).toBe(true);
  });
  it("never falls back after Gemini failure", async () => {
    const calls = mockProviders(200, "JA", 503);
    await deliver("\u3046\u3093");
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]?.[0]).toContain("generativelanguage.googleapis.com");
    expect(await recorded()).toBe(false);
  });
});
