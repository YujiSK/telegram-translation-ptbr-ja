import { describe, expect, it, vi } from "vitest";

import type { SpeakerIdentity } from "../../../src/domain/speaker";
import type { TranslationRequest } from "../../../src/domain/translation";
import { createGeminiTranslationBoundary } from "../../../src/infrastructure/gemini/translate";
import { PermanentUpstreamError, TransientUpstreamError } from "../../../src/shared/errors";

/**
 * `fetch` is never called against the real Gemini API in this file —
 * every boundary is built with a synthetic `fetchFn`.
 */

const SPEAKER: SpeakerIdentity = {
  id: { telegramUserId: 900000003 },
  displayName: "Test Speaker",
  isBot: false,
};

function request(sourceText: string): TranslationRequest {
  return { sourceText, speaker: SPEAKER };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function interactionEnvelope(payload: unknown): unknown {
  return {
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(payload) }] }],
  };
}

function boundaryWithResponse(response: Response) {
  const fetchFn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(response),
  );
  const boundary = createGeminiTranslationBoundary({
    apiKey: "synthetic-test-gemini-key-002",
    model: "gemini-3.5-flash-lite",
    fetchFn,
  });
  return { boundary, fetchFn };
}

const VALID_JA_PAYLOAD = {
  detectedLanguage: "ja",
  action: "translate",
  targetLanguage: "pt-br",
  translatedText: "resposta final do gemini",
  styleSignals: { tone: "casual", emojiUsage: "none" },
};

const VALID_PTBR_PAYLOAD = {
  detectedLanguage: "pt-br",
  action: "translate",
  targetLanguage: "ja",
  translatedText: "Geminiによる最終回答",
  styleSignals: { tone: "neutral", emojiUsage: "light" },
};

const VALID_SKIP_PAYLOAD = {
  detectedLanguage: "other",
  action: "skip",
  targetLanguage: null,
  translatedText: null,
  styleSignals: null,
};

describe("createGeminiTranslationBoundary — JA to PT-BR", () => {
  it("returns a valid translated outcome", async () => {
    const { boundary } = boundaryWithResponse(jsonResponse(interactionEnvelope(VALID_JA_PAYLOAD)));

    const outcome = await boundary.translate(request("こんにちは"));

    expect(outcome).toEqual({
      kind: "translated",
      detectedLanguage: "ja",
      targetLanguage: "pt-br",
      translatedText: "resposta final do gemini",
      styleSignals: { tone: "casual", emojiUsage: "none" },
    });
  });
});

describe("createGeminiTranslationBoundary — PT-BR to JA", () => {
  it("returns a valid translated outcome", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse(interactionEnvelope(VALID_PTBR_PAYLOAD)),
    );

    const outcome = await boundary.translate(request("oi, tudo bem?"));

    expect(outcome).toEqual({
      kind: "translated",
      detectedLanguage: "pt-br",
      targetLanguage: "ja",
      translatedText: "Geminiによる最終回答",
      styleSignals: { tone: "neutral", emojiUsage: "light" },
    });
  });
});

describe("createGeminiTranslationBoundary — untargeted language", () => {
  it("returns a skipped outcome", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse(interactionEnvelope(VALID_SKIP_PAYLOAD)),
    );

    const outcome = await boundary.translate(request("🎉🎉🎉"));

    expect(outcome).toEqual({
      kind: "skipped",
      detectedLanguage: "other",
      reason: "untargeted-language",
    });
  });
});

describe("createGeminiTranslationBoundary — request contract", () => {
  it("sends model, system_instruction, input, and a text/json_schema response_format", async () => {
    const { boundary, fetchFn } = boundaryWithResponse(
      jsonResponse(interactionEnvelope(VALID_JA_PAYLOAD)),
    );

    await boundary.translate(request("こんにちは"));

    const call = fetchFn.mock.calls[0];
    const rawBody = call?.[1]?.body;
    if (typeof rawBody !== "string") {
      throw new Error("expected a string request body");
    }
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body.model).toBe("gemini-3.5-flash-lite");
    expect(typeof body.system_instruction).toBe("string");
    expect(typeof body.input).toBe("string");
    expect(body.input).toContain("こんにちは");
    expect(body.response_format).toMatchObject({ type: "text", mime_type: "application/json" });
    expect(body.store).toBe(false);
  });

  it("never sends the Workers AI provisional translation or free-form reasoning — only original request fields", async () => {
    const { boundary, fetchFn } = boundaryWithResponse(
      jsonResponse(interactionEnvelope(VALID_JA_PAYLOAD)),
    );

    await boundary.translate(request("こんにちは"));

    const call = fetchFn.mock.calls[0];
    const rawBody = call?.[1]?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(body)).not.toContain("needsEscalation");
    expect(JSON.stringify(body)).not.toContain("escalationReason");
  });

  it("includes at most one reply context, matching an existing message", async () => {
    const { boundary, fetchFn } = boundaryWithResponse(
      jsonResponse(interactionEnvelope(VALID_JA_PAYLOAD)),
    );

    await boundary.translate({
      ...request("こんにちは"),
      replyContext: { text: "previous message" },
    });

    const call = fetchFn.mock.calls[0];
    const rawBody = call?.[1]?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<
      string,
      unknown
    >;
    expect(body.input).toContain("previous message");
    expect(body.input).toContain("REPLY CONTEXT");
  });

  it("includes resolved speaker-memory hints/corrections when present", async () => {
    const { boundary, fetchFn } = boundaryWithResponse(
      jsonResponse(interactionEnvelope(VALID_JA_PAYLOAD)),
    );

    await boundary.translate({
      ...request("こんにちは"),
      memory: {
        tone: { source: "explicit", value: "formal" },
        emojiUsage: { source: "none" },
        applicableCorrections: [],
      },
    });

    const call = fetchFn.mock.calls[0];
    const rawBody = call?.[1]?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<
      string,
      unknown
    >;
    expect(body.input).toContain("SPEAKER STYLE PREFERENCE");
    expect(body.input).toContain("formal");
  });
});

describe("createGeminiTranslationBoundary — malformed output", () => {
  it("rejects a response whose model_output text is not valid JSON", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse({
        steps: [{ type: "model_output", content: [{ type: "text", text: "not valid json {" }] }],
      }),
    );

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects a response with no steps array", async () => {
    const { boundary } = boundaryWithResponse(jsonResponse({}));

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects a response whose steps contain no model_output step", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse({ steps: [{ type: "other_step", content: [] }] }),
    );

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects a response whose envelope is not a JSON object", async () => {
    const { boundary } = boundaryWithResponse(jsonResponse("not an object"));

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects a structured payload missing a required field", async () => {
    const withoutDetectedLanguage: Record<string, unknown> = { ...VALID_JA_PAYLOAD };
    delete withoutDetectedLanguage.detectedLanguage;
    const { boundary } = boundaryWithResponse(
      jsonResponse(interactionEnvelope(withoutDetectedLanguage)),
    );

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });
});

describe("createGeminiTranslationBoundary — cross-field consistency", () => {
  it("rejects a mismatched targetLanguage for the detected language", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse(interactionEnvelope({ ...VALID_JA_PAYLOAD, targetLanguage: "ja" })),
    );

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects empty (whitespace-only) translatedText on a translate action", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse(interactionEnvelope({ ...VALID_JA_PAYLOAD, translatedText: "   " })),
    );

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects null styleSignals on a translate action", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse(interactionEnvelope({ ...VALID_JA_PAYLOAD, styleSignals: null })),
    );

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });

  it("rejects detectedLanguage=other paired with action=translate", async () => {
    const { boundary } = boundaryWithResponse(
      jsonResponse(interactionEnvelope({ ...VALID_SKIP_PAYLOAD, action: "translate" })),
    );

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });
});

describe("createGeminiTranslationBoundary — upstream failures propagate unchanged", () => {
  it("propagates a transient HTTP failure without reclassifying it", async () => {
    const { boundary } = boundaryWithResponse(jsonResponse({ error: { message: "x" } }, 503));

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      TransientUpstreamError,
    );
  });

  it("propagates a permanent HTTP failure without reclassifying it", async () => {
    const { boundary } = boundaryWithResponse(jsonResponse({ error: { message: "x" } }, 403));

    await expect(boundary.translate(request("hello"))).rejects.toBeInstanceOf(
      PermanentUpstreamError,
    );
  });
});

describe("createGeminiTranslationBoundary — no raw vendor response leakage", () => {
  it("never includes the raw structured-output payload text in a thrown error", async () => {
    const identifiableDetail = "synthetic-identifiable-gemini-payload-6b2d";
    const { boundary } = boundaryWithResponse(
      jsonResponse({
        steps: [{ type: "model_output", content: [{ type: "text", text: identifiableDetail }] }],
      }),
    );

    const error = await boundary.translate(request("hello")).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PermanentUpstreamError);
    expect((error as PermanentUpstreamError).publicMessage).not.toContain(identifiableDetail);
  });
});
