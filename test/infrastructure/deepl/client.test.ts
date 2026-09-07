import { describe, expect, it, vi } from "vitest";
import { callDeepLTranslate, DEEPL_TIMEOUT_MS } from "../../../src/infrastructure/deepl/client";
import { classifyError } from "../../../src/shared/structured-log";

describe("DeepL client", () => {
  it("treats a body-read timeout as transient and sanitizes it", async () => {
    const response = new Response();
    vi.spyOn(response, "json").mockRejectedValue(
      new DOMException("private timeout body", "TimeoutError"),
    );
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(
      callDeepLTranslate("private", "JA", { apiKey: "synthetic", fetchFn }),
    ).rejects.toMatchObject({
      message: "DeepL response timed out",
      service: "deepl",
      retryable: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["synthetic:fx", "api-free.deepl.com"],
    ["synthetic-pro", "api.deepl.com"],
  ])("selects fixed host for %s", async (apiKey, host) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ translations: [] }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await callDeepLTranslate("synthetic text", "PT-BR", { apiKey, fetchFn });
      expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
        `https://${host}/v2/translate`,
        expect.objectContaining({
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            Authorization: `DeepL-Auth-Key ${apiKey}`,
          },
          body: JSON.stringify({
            text: ["synthetic text"],
            target_lang: "PT-BR",
            source_lang: "JA",
          }),
        }),
      );
      expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(DEEPL_TIMEOUT_MS);
      expect(DEEPL_TIMEOUT_MS).toBe(5000);
    } finally {
      timeout.mockRestore();
    }
  });
  it("omits source_lang for Latin input", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await callDeepLTranslate("Olá", "JA", { apiKey: "synthetic", fetchFn });
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ text: ["Olá"], target_lang: "JA" }),
    );
  });
  it.each([400, 401, 403, 404, 408, 429, 456, 500, 503])(
    "classifies HTTP %s without reading body or retrying",
    async (status) => {
      const response = new Response("private upstream body", { status });
      const json = vi.spyOn(response, "json");
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        callDeepLTranslate("private source", "JA", { apiKey: "synthetic-secret", fetchFn }),
      ).rejects.toMatchObject({
        service: "deepl",
        retryable: status === 408 || status === 429 || status >= 500,
        httpStatus: status,
        message: "DeepL HTTP failure",
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(json).not.toHaveBeenCalled();
    },
  );
  it.each([new Error("private network body"), new DOMException("private", "TimeoutError")])(
    "sanitizes request failures",
    async (error) => {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(
        callDeepLTranslate("private", "JA", { apiKey: "synthetic", fetchFn }),
      ).rejects.toMatchObject({ message: "DeepL request failed", retryable: true });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );
  it("sanitizes malformed JSON and exposes only safe log metadata", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("private raw body"));
    const error: unknown = await callDeepLTranslate("private", "JA", {
      apiKey: "synthetic",
      fetchFn,
    }).catch((error: unknown) => error);
    expect(classifyError(error)).toEqual({
      errorClass: "PermanentUpstreamError",
      service: "deepl",
      stage: "response-envelope",
    });
  });
});
