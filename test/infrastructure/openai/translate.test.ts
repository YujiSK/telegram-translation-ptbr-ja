import { describe, expect, it, vi } from "vitest";

import { translateMessage } from "../../../src/infrastructure/openai/translate";
import { TRANSLATION_JSON_SCHEMA_NAME } from "../../../src/prompts/translation-v1";
import { PermanentUpstreamError, TransientUpstreamError } from "../../../src/shared/errors";
import type { TranslationRequest } from "../../../src/domain/translation";

/**
 * Every test in this file supplies its own `fetchFn` and `waitFn`, so
 * `translateMessage` never reaches the real OpenAI API and never actually
 * sleeps. `API_KEY` and all message text below are obviously synthetic.
 */

const API_KEY = "synthetic-test-openai-key-002";
const MODEL = "gpt-4o-mini";

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("expected a string request body");
  }
  return body;
}

function envelopeWithStructuredOutput(payload: unknown): unknown {
  return {
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(payload) }],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `vi.fn` shaped like `fetch`, with a safe default so unconfigured calls fail loudly instead of hitting the network. */
function fetchMock(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl);
}

function fetchReturning(payload: unknown): ReturnType<typeof fetchMock> {
  return fetchMock(() => Promise.resolve(jsonResponse(envelopeWithStructuredOutput(payload))));
}

function noopWait(): Promise<void> {
  return Promise.resolve();
}

const baseRequest: TranslationRequest = {
  sourceText: "synthetic test message",
  speaker: { id: { telegramUserId: 700000001 }, displayName: "Synthetic Speaker", isBot: false },
};

describe("translateMessage — request shape", () => {
  it("sends exactly one Structured Outputs request with the model and schema", async () => {
    const fetchFn = fetchReturning({
      detectedLanguage: "ja",
      action: "translate",
      targetLanguage: "pt-br",
      translatedText: "mensagem sintética de teste",
      styleSignals: { tone: "casual", emojiUsage: "none" },
    });

    await translateMessage(baseRequest, {
      apiKey: API_KEY,
      model: MODEL,
      fetchFn,
      waitFn: noopWait,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected fetchFn to have been called");
    }
    const body: unknown = JSON.parse(requireStringBody(call[1]?.body));
    expect(body).toMatchObject({
      model: MODEL,
      text: { format: { type: "json_schema", name: TRANSLATION_JSON_SCHEMA_NAME, strict: true } },
    });
  });

  it("includes the reply context in the request when present", async () => {
    const fetchFn = fetchReturning({
      detectedLanguage: "other",
      action: "skip",
      targetLanguage: null,
      translatedText: null,
      styleSignals: null,
    });

    await translateMessage(
      { ...baseRequest, replyContext: { text: "synthetic prior message" } },
      { apiKey: API_KEY, model: MODEL, fetchFn, waitFn: noopWait },
    );

    const call = fetchFn.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected fetchFn to have been called");
    }
    const body: unknown = JSON.parse(requireStringBody(call[1]?.body));
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).toContain("synthetic prior message");
  });
});

describe("translateMessage — ja -> pt-br", () => {
  it("returns a translated outcome", async () => {
    const fetchFn = fetchReturning({
      detectedLanguage: "ja",
      action: "translate",
      targetLanguage: "pt-br",
      translatedText: "mensagem sintética de teste",
      styleSignals: { tone: "casual", emojiUsage: "light" },
    });

    const outcome = await translateMessage(baseRequest, {
      apiKey: API_KEY,
      model: MODEL,
      fetchFn,
      waitFn: noopWait,
    });

    expect(outcome).toEqual({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "mensagem sintética de teste",
      styleSignals: { tone: "casual", emojiUsage: "light" },
    });
  });
});

describe("translateMessage — pt-br -> ja", () => {
  it("returns a translated outcome", async () => {
    const fetchFn = fetchReturning({
      detectedLanguage: "pt-br",
      action: "translate",
      targetLanguage: "ja",
      translatedText: "合成テストメッセージ",
      styleSignals: { tone: "neutral", emojiUsage: "none" },
    });

    const outcome = await translateMessage(baseRequest, {
      apiKey: API_KEY,
      model: MODEL,
      fetchFn,
      waitFn: noopWait,
    });

    expect(outcome).toEqual({
      kind: "translated",
      detectedLanguage: "pt-br",
      targetLanguage: "ja",
      translatedText: "合成テストメッセージ",
      styleSignals: { tone: "neutral", emojiUsage: "none" },
    });
  });
});

describe("translateMessage — other -> skip", () => {
  it("returns a skipped outcome without a translated text", async () => {
    const fetchFn = fetchReturning({
      detectedLanguage: "other",
      action: "skip",
      targetLanguage: null,
      translatedText: null,
      styleSignals: null,
    });

    const outcome = await translateMessage(baseRequest, {
      apiKey: API_KEY,
      model: MODEL,
      fetchFn,
      waitFn: noopWait,
    });

    expect(outcome).toEqual({
      kind: "skipped",
      detectedLanguage: "other",
      reason: "untargeted-language",
    });
  });

  it("tolerates a response with no styleSignals for the skip case", async () => {
    const fetchFn = fetchReturning({
      detectedLanguage: "other",
      action: "skip",
      targetLanguage: null,
      translatedText: null,
      styleSignals: null,
    });

    const outcome = await translateMessage(baseRequest, {
      apiKey: API_KEY,
      model: MODEL,
      fetchFn,
      waitFn: noopWait,
    });

    expect(outcome.kind).toBe("skipped");
  });
});

describe("translateMessage — malformed / inconsistent responses are never retried and never surfaced", () => {
  async function expectPermanentFailure(fetchFn: ReturnType<typeof fetchMock>): Promise<void> {
    await expect(
      translateMessage(baseRequest, { apiKey: API_KEY, model: MODEL, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  }

  it("rejects a response with no output array", async () => {
    await expectPermanentFailure(fetchMock(() => Promise.resolve(jsonResponse({}))));
  });

  it("rejects a response with no assistant output_text content", async () => {
    await expectPermanentFailure(
      fetchMock(() =>
        Promise.resolve(
          jsonResponse({ output: [{ type: "message", role: "assistant", content: [] }] }),
        ),
      ),
    );
  });

  it("rejects output_text that is not valid JSON", async () => {
    await expectPermanentFailure(
      fetchMock(() =>
        Promise.resolve(
          jsonResponse({
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "not valid json {" }],
              },
            ],
          }),
        ),
      ),
    );
  });

  it("rejects a structured output missing a required field (schema mismatch)", async () => {
    await expectPermanentFailure(
      fetchReturning({
        detectedLanguage: "ja",
        action: "translate",
        targetLanguage: "pt-br",
        // translatedText is missing entirely.
        styleSignals: { tone: "casual", emojiUsage: "none" },
      }),
    );
  });

  it("rejects an invalid detectedLanguage enum value", async () => {
    await expectPermanentFailure(
      fetchReturning({
        detectedLanguage: "en",
        action: "translate",
        targetLanguage: "pt-br",
        translatedText: "x",
        styleSignals: { tone: "casual", emojiUsage: "none" },
      }),
    );
  });

  it("rejects a targetLanguage that doesn't match the detected language (logical inconsistency)", async () => {
    await expectPermanentFailure(
      fetchReturning({
        detectedLanguage: "ja",
        action: "translate",
        targetLanguage: "ja",
        translatedText: "x",
        styleSignals: { tone: "casual", emojiUsage: "none" },
      }),
    );
  });

  it("rejects action=translate with a null translatedText", async () => {
    await expectPermanentFailure(
      fetchReturning({
        detectedLanguage: "ja",
        action: "translate",
        targetLanguage: "pt-br",
        translatedText: null,
        styleSignals: { tone: "casual", emojiUsage: "none" },
      }),
    );
  });

  it("rejects action=translate with an empty translatedText", async () => {
    await expectPermanentFailure(
      fetchReturning({
        detectedLanguage: "ja",
        action: "translate",
        targetLanguage: "pt-br",
        translatedText: "   ",
        styleSignals: { tone: "casual", emojiUsage: "none" },
      }),
    );
  });

  it("rejects detectedLanguage=other paired with action=translate", async () => {
    await expectPermanentFailure(
      fetchReturning({
        detectedLanguage: "other",
        action: "translate",
        targetLanguage: "pt-br",
        translatedText: "x",
        styleSignals: { tone: "casual", emojiUsage: "none" },
      }),
    );
  });

  it("rejects an invalid styleSignals shape", async () => {
    await expectPermanentFailure(
      fetchReturning({
        detectedLanguage: "ja",
        action: "translate",
        targetLanguage: "pt-br",
        translatedText: "x",
        styleSignals: { tone: "very-casual", emojiUsage: "none" },
      }),
    );
  });
});

describe("translateMessage — transient upstream failures propagate as retryable", () => {
  it("propagates a TransientUpstreamError from the underlying client without swallowing it", async () => {
    const fetchFn = fetchMock(() => Promise.reject(new TypeError("synthetic network failure")));

    await expect(
      translateMessage(baseRequest, { apiKey: API_KEY, model: MODEL, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
  });

  it("succeeds after one transient failure, still counted as a single logical translation call", async () => {
    const fetchFn = fetchMock(() =>
      Promise.reject(new Error("unexpected third fetch call in test")),
    )
      .mockRejectedValueOnce(new TypeError("synthetic network failure"))
      .mockResolvedValueOnce(
        jsonResponse(
          envelopeWithStructuredOutput({
            detectedLanguage: "ja",
            action: "translate",
            targetLanguage: "pt-br",
            translatedText: "mensagem sintética",
            styleSignals: { tone: "casual", emojiUsage: "none" },
          }),
        ),
      );

    const outcome = await translateMessage(baseRequest, {
      apiKey: API_KEY,
      model: MODEL,
      fetchFn,
      waitFn: noopWait,
    });

    expect(outcome.kind).toBe("translated");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("translateMessage — no Secret or message-text leakage", () => {
  it("never includes the API key or source text in a thrown error", async () => {
    const identifiableText = "a very identifiable synthetic source message";
    const fetchFn = fetchMock(() => Promise.resolve(jsonResponse({})));

    await expect(
      translateMessage(
        { ...baseRequest, sourceText: identifiableText },
        { apiKey: API_KEY, model: MODEL, fetchFn, waitFn: noopWait },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      return !serialized.includes(API_KEY) && !serialized.includes(identifiableText);
    });
  });
});
