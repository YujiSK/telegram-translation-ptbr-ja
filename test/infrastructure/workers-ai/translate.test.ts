import { describe, expect, it, vi } from "vitest";

import type { SpeakerIdentity } from "../../../src/domain/speaker";
import type { TranslationRequest } from "../../../src/domain/translation";
import { createWorkersAiTranslationProvider } from "../../../src/infrastructure/workers-ai/translate";
import type { WorkersAiBinding } from "../../../src/infrastructure/workers-ai/client";
import { PermanentUpstreamError, TransientUpstreamError } from "../../../src/shared/errors";

/**
 * `env.AI.run()` is never called in this file — `binding.run` is always
 * a synthetic in-memory fake, never the real Workers AI binding.
 */

const SPEAKER: SpeakerIdentity = {
  id: { telegramUserId: 900000002 },
  displayName: "Test Speaker",
  isBot: false,
};

function request(sourceText: string): TranslationRequest {
  return { sourceText, speaker: SPEAKER };
}

function chatCompletionResponse(payload: unknown): unknown {
  return {
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) } }],
  };
}

function providerWithResponse(response: unknown) {
  const run = vi.fn(
    (_model: string, _inputs: Record<string, unknown>, _options?: { signal?: AbortSignal }) =>
      Promise.resolve(response),
  );
  const binding: WorkersAiBinding = { run };
  const provider = createWorkersAiTranslationProvider({
    binding,
    model: "@cf/synthetic/test-model",
  });
  return { provider, run };
}

const VALID_JA_PAYLOAD = {
  detectedLanguage: "ja",
  action: "translate",
  targetLanguage: "pt-br",
  translatedText: "mensagem sintética de teste",
  styleSignals: { tone: "casual", emojiUsage: "none" },
  needsEscalation: false,
  escalationReason: "none",
};

const VALID_PTBR_PAYLOAD = {
  detectedLanguage: "pt-br",
  action: "translate",
  targetLanguage: "ja",
  translatedText: "合成テストメッセージ",
  styleSignals: { tone: "neutral", emojiUsage: "light" },
  needsEscalation: false,
  escalationReason: "none",
};

const VALID_SKIP_PAYLOAD = {
  detectedLanguage: "other",
  action: "skip",
  targetLanguage: null,
  translatedText: null,
  styleSignals: null,
  needsEscalation: false,
  escalationReason: "none",
};

/**
 * Phase 9.1A review hardening: proves, at runtime, that the request this
 * module actually sends matches the direct-binding contract confirmed by
 * reading this repo's generated `worker-configuration.d.ts`
 * (`ResponseFormatJSONSchema`, part of `ChatCompletionsCommonOptions.response_format`)
 * — the schema nested one level under `json_schema`, never the OpenAI
 * Responses-API wrapper shape (`{ name, schema, strict }` at the top
 * level of `response_format`). `src/infrastructure/workers-ai/translate.ts`
 * also type-checks this shape at compile time via an explicit
 * `ResponseFormatJSONSchema` annotation — this test is the runtime half
 * of that same verification.
 */
describe("createWorkersAiTranslationProvider — direct-binding request contract", () => {
  it("sends response_format as { type: 'json_schema', json_schema: { name, schema, strict } }, with no OpenAI-wrapper-shaped fields", async () => {
    const { provider, run } = providerWithResponse(chatCompletionResponse(VALID_JA_PAYLOAD));

    await provider.translate(request("こんにちは"));

    expect(run).toHaveBeenCalledTimes(1);
    const inputs = run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual(["messages", "response_format"]);

    const responseFormat = inputs.response_format as Record<string, unknown>;
    expect(responseFormat.type).toBe("json_schema");
    expect(Object.keys(responseFormat).sort()).toEqual(["json_schema", "type"]);

    const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
    expect(Object.keys(jsonSchema).sort()).toEqual(["name", "schema", "strict"]);
    expect(jsonSchema.strict).toBe(true);
    expect(typeof jsonSchema.name).toBe("string");
  });

  it("sends exactly a system message followed by a user message for live GLM runtime compatibility", async () => {
    const { provider, run } = providerWithResponse(chatCompletionResponse(VALID_JA_PAYLOAD));

    await provider.translate(request("こんにちは"));

    const inputs = run.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
    expect(inputs.messages).toHaveLength(2);
    expect(inputs.messages[0]?.role).toBe("system");
    expect(inputs.messages[1]?.role).toBe("user");
  });
});

/**
 * Phase 9.1A review hardening: the fakes used throughout this file
 * intentionally use a minimal envelope (`{ choices: [{ message: {
 * content } }] }`). This test instead uses a full, realistic
 * direct-binding envelope — matching the generated `ChatCompletionsOutput`
 * shape (`id`, `object`, `created`, `model`, `choices`, `usage`) — to
 * prove `extractAssistantContent` still finds `choices[0].message.content`
 * when every other documented field is also present, not just when they
 * happen to be absent.
 */
describe("createWorkersAiTranslationProvider — realistic full ChatCompletionsOutput envelope", () => {
  it("extracts the content correctly from a complete envelope with id/object/created/model/usage present", async () => {
    const fullEnvelope = {
      id: "chatcmpl-synthetic-9f2a",
      object: "chat.completion",
      created: 1700000000,
      model: "@cf/zai-org/glm-4.7-flash",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify(VALID_JA_PAYLOAD),
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
    };
    const { provider } = providerWithResponse(fullEnvelope);

    const candidate = await provider.translate(request("こんにちは"));

    expect(candidate.outcome).toEqual({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "mensagem sintética de teste",
      styleSignals: { tone: "casual", emojiUsage: "none" },
    });
  });
});

describe("createWorkersAiTranslationProvider — JA to PT-BR", () => {
  it("returns a valid translated candidate with needsEscalation false", async () => {
    const { provider } = providerWithResponse(chatCompletionResponse(VALID_JA_PAYLOAD));

    const candidate = await provider.translate(request("こんにちは"));

    expect(candidate.needsEscalation).toBe(false);
    expect(candidate.escalationReason).toBe("none");
    expect(candidate.outcome).toEqual({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "mensagem sintética de teste",
      styleSignals: { tone: "casual", emojiUsage: "none" },
    });
  });
});

describe("createWorkersAiTranslationProvider — PT-BR to JA", () => {
  it("returns a valid translated candidate", async () => {
    const { provider } = providerWithResponse(chatCompletionResponse(VALID_PTBR_PAYLOAD));

    const candidate = await provider.translate(request("oi, tudo bem?"));

    expect(candidate.outcome).toEqual({
      kind: "translated",
      detectedLanguage: "pt-br",
      targetLanguage: "ja",
      translatedText: "合成テストメッセージ",
      styleSignals: { tone: "neutral", emojiUsage: "light" },
    });
  });
});

describe("createWorkersAiTranslationProvider — untargeted language", () => {
  it("returns a skipped outcome", async () => {
    const { provider } = providerWithResponse(chatCompletionResponse(VALID_SKIP_PAYLOAD));

    const candidate = await provider.translate(request("🎉🎉🎉"));

    expect(candidate.outcome).toEqual({
      kind: "skipped",
      detectedLanguage: "other",
      reason: "untargeted-language",
    });
    expect(candidate.needsEscalation).toBe(false);
  });
});

describe("createWorkersAiTranslationProvider — escalation", () => {
  it("surfaces needsEscalation and escalationReason from a valid provisional candidate", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({
        ...VALID_JA_PAYLOAD,
        needsEscalation: true,
        escalationReason: "ambiguous-context",
      }),
    );

    const candidate = await provider.translate(request("こんにちは"));

    expect(candidate.needsEscalation).toBe(true);
    expect(candidate.escalationReason).toBe("ambiguous-context");
    // The provisional outcome is still structurally valid — the router,
    // not this adapter, decides not to surface it as final.
    expect(candidate.outcome.kind).toBe("translated");
  });

  it.each([
    "ambiguous-context",
    "mixed-language",
    "correction-sensitive",
    "style-sensitive",
    "low-confidence",
  ])("accepts the fixed escalation reason %s", async (reason) => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({
        ...VALID_JA_PAYLOAD,
        needsEscalation: true,
        escalationReason: reason,
      }),
    );

    const candidate = await provider.translate(request("こんにちは"));
    expect(candidate.escalationReason).toBe(reason);
  });
});

describe("createWorkersAiTranslationProvider — styleSignals validation", () => {
  it("accepts every valid tone/emojiUsage combination", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({
        ...VALID_JA_PAYLOAD,
        styleSignals: { tone: "formal", emojiUsage: "frequent" },
      }),
    );

    const candidate = await provider.translate(request("こんにちは"));
    expect(candidate.outcome).toMatchObject({
      styleSignals: { tone: "formal", emojiUsage: "frequent" },
    });
  });

  it("rejects an invalid tone value as a permanent failure", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({
        ...VALID_JA_PAYLOAD,
        styleSignals: { tone: "excited", emojiUsage: "none" },
      }),
    );

    await expect(provider.translate(request("こんにちは"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects null styleSignals on a translate action as a permanent failure", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({ ...VALID_JA_PAYLOAD, styleSignals: null }),
    );

    await expect(provider.translate(request("こんにちは"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });
});

describe("createWorkersAiTranslationProvider — malformed output", () => {
  it("rejects a response whose assistant content is not valid JSON", async () => {
    const { provider } = providerWithResponse({
      choices: [{ message: { role: "assistant", content: "not valid json {" } }],
    });

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects a response with no choices array", async () => {
    const { provider } = providerWithResponse({});

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects a response whose envelope is not a JSON object", async () => {
    const { provider } = providerWithResponse("not an object");

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects a structured payload missing a required field", async () => {
    const withoutDetectedLanguage: Record<string, unknown> = { ...VALID_JA_PAYLOAD };
    delete withoutDetectedLanguage.detectedLanguage;
    const { provider } = providerWithResponse(chatCompletionResponse(withoutDetectedLanguage));

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });
});

describe("createWorkersAiTranslationProvider — cross-field consistency", () => {
  it("rejects a mismatched targetLanguage for the detected language", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({ ...VALID_JA_PAYLOAD, targetLanguage: "ja" }),
    );

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects empty (whitespace-only) translatedText on a translate action", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({ ...VALID_JA_PAYLOAD, translatedText: "   " }),
    );

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects detectedLanguage=other paired with action=translate", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({ ...VALID_SKIP_PAYLOAD, action: "translate" }),
    );

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects needsEscalation=true paired with escalationReason='none'", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({
        ...VALID_JA_PAYLOAD,
        needsEscalation: true,
        escalationReason: "none",
      }),
    );

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects needsEscalation=false paired with a non-'none' escalationReason", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({
        ...VALID_JA_PAYLOAD,
        needsEscalation: false,
        escalationReason: "low-confidence",
      }),
    );

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects an escalationReason outside the fixed enum", async () => {
    const { provider } = providerWithResponse(
      chatCompletionResponse({
        ...VALID_JA_PAYLOAD,
        needsEscalation: true,
        escalationReason: "the model tried to explain itself here",
      }),
    );

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });
});

describe("createWorkersAiTranslationProvider — upstream binding failures propagate unchanged", () => {
  it("propagates a transient binding failure without reclassifying it", async () => {
    const run = vi.fn(() => Promise.reject(new Error("429 synthetic rate limit")));
    const binding: WorkersAiBinding = { run };
    const provider = createWorkersAiTranslationProvider({ binding, model: "m" });

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      TransientUpstreamError,
    );
  });

  it("propagates a permanent binding failure without reclassifying it", async () => {
    const run = vi.fn(() => Promise.reject(new Error("403 synthetic forbidden")));
    const binding: WorkersAiBinding = { run };
    const provider = createWorkersAiTranslationProvider({ binding, model: "m" });

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("propagates a timeout as transient", async () => {
    const run = vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError")));
    const binding: WorkersAiBinding = { run };
    const provider = createWorkersAiTranslationProvider({ binding, model: "m", timeoutMs: 5 });

    await expect(provider.translate(request("hello"))).rejects.toBeInstanceOf(
      TransientUpstreamError,
    );
  });
});
