import { describe, expect, it, vi } from "vitest";

import { sendMessage } from "../../../src/infrastructure/telegram/send-message";

/**
 * Every test in this file supplies its own `fetchFn`, so `sendMessage`
 * never reaches the real Telegram API. `FAKE_TOKEN` and all chat/message
 * IDs below are obviously synthetic values.
 */

const FAKE_TOKEN = "0000000000:FAKE-TEST-TOKEN-not-a-real-secret";
const CHAT_ID = -1008000000002;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("expected a string request body");
  }
  return body;
}

describe("sendMessage — success", () => {
  it("sends the chat ID and text, and resolves the sent message", async () => {
    const fetchFn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({ ok: true, result: { message_id: 42, chat: { id: CHAT_ID } } }),
      ),
    );

    const result = await sendMessage(
      { chatId: CHAT_ID, text: "Synthetic test message" },
      { botToken: FAKE_TOKEN, fetchFn },
    );

    expect(result).toEqual({ messageId: 42, chatId: CHAT_ID });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const call = fetchFn.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected fetchFn to have been called");
    }
    const [url, init] = call;
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(JSON.parse(requireStringBody(init?.body))).toEqual({
      chat_id: CHAT_ID,
      text: "Synthetic test message",
    });
  });

  it("uses reply_parameters with message_id for the current Bot API reply mechanism", async () => {
    const fetchFn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse({ ok: true, result: { message_id: 43, chat: { id: CHAT_ID } } }),
      ),
    );

    await sendMessage(
      { chatId: CHAT_ID, text: "Reply text", replyToMessageId: 41 },
      { botToken: FAKE_TOKEN, fetchFn },
    );

    const call = fetchFn.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected fetchFn to have been called");
    }
    const body: unknown = JSON.parse(requireStringBody(call[1]?.body));
    expect(body).toMatchObject({ reply_parameters: { message_id: 41 } });
  });

  it("never calls the real global fetch when a custom fetchFn is provided", async () => {
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, result: { message_id: 1, chat: { id: CHAT_ID } } })),
    );

    await sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn });

    expect(globalFetchSpy).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
  });
});

describe("sendMessage — API-level failures", () => {
  it("rejects with a permanent error when HTTP 200 but ok:false", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
      ),
    );

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toMatchObject({ code: "UPSTREAM_PERMANENT_ERROR", retryable: false });
  });

  it("classifies a 4xx HTTP response as permanent", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: false, error_code: 403, description: "Forbidden" }, 403)),
    );

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toMatchObject({ code: "UPSTREAM_PERMANENT_ERROR", retryable: false });
  });

  it("classifies HTTP 429 as transient", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests" }, 429),
      ),
    );

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TRANSIENT_ERROR", retryable: true });
  });

  it("classifies an HTTP 5xx response as transient", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ ok: false, error_code: 502, description: "Bad Gateway" }, 502),
      ),
    );

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TRANSIENT_ERROR", retryable: true });
  });

  it("classifies a timeout as transient", async () => {
    const fetchFn = vi.fn(() =>
      Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    );

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TRANSIENT_ERROR", retryable: true });
  });

  it("classifies a generic network failure as transient", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError("synthetic network failure")));

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TRANSIENT_ERROR", retryable: true });
  });

  it("classifies a non-JSON API response as permanent", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response("<html>not json</html>", { status: 200 })),
    );

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toMatchObject({ code: "UPSTREAM_PERMANENT_ERROR", retryable: false });
  });

  it("classifies a malformed sendMessage result shape as permanent", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, result: { unexpected: true } })),
    );

    await expect(
      sendMessage({ chatId: CHAT_ID, text: "x" }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toMatchObject({ code: "UPSTREAM_PERMANENT_ERROR", retryable: false });
  });
});

describe("sendMessage — no Secret or message-text leakage", () => {
  it("never includes the bot token or message text in the thrown error", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: false, error_code: 400, description: "Bad Request" })),
    );
    const identifiableText = "a very identifiable synthetic test message";

    await expect(
      sendMessage({ chatId: CHAT_ID, text: identifiableText }, { botToken: FAKE_TOKEN, fetchFn }),
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      return !serialized.includes(FAKE_TOKEN) && !serialized.includes(identifiableText);
    });
  });
});
