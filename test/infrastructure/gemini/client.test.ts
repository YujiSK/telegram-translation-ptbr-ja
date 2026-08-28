import { describe, expect, it, vi } from "vitest";

import {
  GEMINI_API_VERSION,
  callGeminiInteraction,
} from "../../../src/infrastructure/gemini/client";
import {
  PermanentUpstreamError,
  TransientUpstreamError,
  UpstreamServiceError,
} from "../../../src/shared/errors";

/**
 * Every test in this file supplies its own `fetchFn`, so
 * `callGeminiInteraction` never reaches the real Gemini API. `API_KEY`
 * is an obviously synthetic value.
 */

const API_KEY = "synthetic-test-gemini-key-001";

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

/** A `vi.fn` shaped like `fetch`, with a safe default so unconfigured calls fail loudly instead of hitting the network. */
function fetchMock() {
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    Promise.reject(new Error("unmocked fetch call in test")),
  );
}

const VALID_ENVELOPE = {
  steps: [{ type: "model_output", content: [{ type: "text", text: "{}" }] }],
};

/** Awaits a rejecting promise and returns its `UpstreamServiceError`, properly narrowed (no unsafe cast) — a plain `.catch()` can't narrow away `callGeminiInteraction`'s `Promise<unknown>` success type. */
async function captureUpstreamServiceError(
  promise: Promise<unknown>,
): Promise<UpstreamServiceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpstreamServiceError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the promise to reject with an UpstreamServiceError");
}

describe("callGeminiInteraction — success and request shape", () => {
  it("returns the parsed JSON body on a 200 response", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    const result = await callGeminiInteraction(
      { model: "gemini-3.5-flash-lite" },
      { apiKey: API_KEY, fetchFn },
    );

    expect(result).toEqual(VALID_ENVELOPE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("uses the current Interactions API endpoint and POST method", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn });

    const call = fetchFn.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected fetchFn to have been called");
    }
    const [url, init] = call;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1/interactions");
    expect(init?.method).toBe("POST");
  });

  it("sends the API key in the x-goog-api-key header, never Authorization or a query parameter", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn });

    const call = fetchFn.mock.calls[0];
    const [url, init] = call ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(API_KEY);
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    const urlString =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url?.url ?? "");
    expect(urlString).not.toContain(API_KEY);
  });

  it("sends content-type: application/json", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn });

    const call = fetchFn.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("always sends store: false in the body, even if the caller's body omits it", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction(
      { model: "gemini-3.5-flash-lite", input: "hi" },
      { apiKey: API_KEY, fetchFn },
    );

    const call = fetchFn.mock.calls[0];
    const body = JSON.parse(requireStringBody(call?.[1]?.body)) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.model).toBe("gemini-3.5-flash-lite");
    expect(body.input).toBe("hi");
  });

  it("store: false cannot regress — the client overrides even a caller-supplied store: true", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction(
      { model: "gemini-3.5-flash-lite", store: true },
      { apiKey: API_KEY, fetchFn },
    );

    const call = fetchFn.mock.calls[0];
    const body = JSON.parse(requireStringBody(call?.[1]?.body)) as Record<string, unknown>;
    expect(body.store).toBe(false);
  });

  it("never sends previous_interaction_id, tools, grounding, or background mode unless the caller's body explicitly included them (and even then store is still forced false)", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn });

    const call = fetchFn.mock.calls[0];
    const body = JSON.parse(requireStringBody(call?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("previous_interaction_id");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("background");
    expect(body).not.toHaveProperty("stream");
  });

  it("sends the configured model", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn });

    const call = fetchFn.mock.calls[0];
    const body = JSON.parse(requireStringBody(call?.[1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe("gemini-3.5-flash-lite");
  });

  it("bounds the request with an AbortSignal", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction(
      { model: "gemini-3.5-flash-lite" },
      { apiKey: API_KEY, fetchFn, timeoutMs: 50 },
    );

    const call = fetchFn.mock.calls[0];
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes exactly one HTTP attempt — no automatic retry", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: "server error" } }, 503),
    );

    await expect(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never calls the real global fetch when a custom fetchFn is provided", async () => {
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse(VALID_ENVELOPE));

    await callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn });

    expect(globalFetchSpy).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
  });
});

describe("callGeminiInteraction — timeout and network failures are transient", () => {
  it("classifies an AbortError as transient", async () => {
    const fetchFn = fetchMock().mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(
      callGeminiInteraction(
        { model: "gemini-3.5-flash-lite" },
        { apiKey: API_KEY, fetchFn, timeoutMs: 5 },
      ),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
  });

  it("classifies a TimeoutError as transient", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    const fetchFn = fetchMock().mockRejectedValue(timeoutError);

    await expect(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
  });

  it("classifies a generic network error (before any response) as transient", async () => {
    const fetchFn = fetchMock().mockRejectedValue(new TypeError("synthetic network failure"));

    await expect(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
  });
});

describe("callGeminiInteraction — documented transient HTTP statuses", () => {
  it.each([408, 429, 500, 502, 503, 504])("classifies HTTP %s as transient", async (status) => {
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: "x" } }, status),
    );

    await expect(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
  });
});

describe("callGeminiInteraction — documented permanent HTTP statuses", () => {
  it.each([400, 401, 403, 404, 422])(
    "classifies HTTP %s as permanent, never retried",
    async (status) => {
      const fetchFn = fetchMock().mockResolvedValue(
        jsonResponse({ error: { message: "x" } }, status),
      );

      await expect(
        callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
      ).rejects.toBeInstanceOf(PermanentUpstreamError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("classifies a 200 response with a non-JSON body as permanent", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );

    await expect(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
  });
});

describe("callGeminiInteraction — diagnostic stage/httpStatus metadata (pilot incident diagnostics)", () => {
  it("exposes GEMINI_API_VERSION as the fixed literal used in the endpoint URL", () => {
    expect(GEMINI_API_VERSION).toBe("v1");
  });

  it("tags a pre-response timeout as stage=request with no httpStatus", async () => {
    const fetchFn = fetchMock().mockRejectedValue(new DOMException("aborted", "AbortError"));

    const error = await captureUpstreamServiceError(
      callGeminiInteraction(
        { model: "gemini-3.5-flash-lite" },
        { apiKey: API_KEY, fetchFn, timeoutMs: 5 },
      ),
    );

    expect(error).toBeInstanceOf(TransientUpstreamError);
    expect(error.stage).toBe("request");
    expect(error.httpStatus).toBeUndefined();
  });

  it("tags a pre-response network failure as stage=request with no httpStatus", async () => {
    const fetchFn = fetchMock().mockRejectedValue(new TypeError("synthetic network failure"));

    const error = await captureUpstreamServiceError(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    );

    expect(error).toBeInstanceOf(TransientUpstreamError);
    expect(error.stage).toBe("request");
    expect(error.httpStatus).toBeUndefined();
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "tags transient HTTP %s as stage=http with the numeric httpStatus",
    async (status) => {
      const fetchFn = fetchMock().mockResolvedValue(
        jsonResponse({ error: { message: "x" } }, status),
      );

      const error = await captureUpstreamServiceError(
        callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
      );

      expect(error).toBeInstanceOf(TransientUpstreamError);
      expect(error.stage).toBe("http");
      expect(error.httpStatus).toBe(status);
    },
  );

  it.each([400, 401, 403, 404, 422])(
    "tags permanent HTTP %s as stage=http with the numeric httpStatus",
    async (status) => {
      const fetchFn = fetchMock().mockResolvedValue(
        jsonResponse({ error: { message: "x" } }, status),
      );

      const error = await captureUpstreamServiceError(
        callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
      );

      expect(error).toBeInstanceOf(PermanentUpstreamError);
      expect(error.stage).toBe("http");
      expect(error.httpStatus).toBe(status);
    },
  );

  it("tags a 200 non-JSON body as stage=response-envelope with httpStatus=200", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );

    const error = await captureUpstreamServiceError(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    );

    expect(error).toBeInstanceOf(PermanentUpstreamError);
    expect(error.stage).toBe("response-envelope");
    expect(error.httpStatus).toBe(200);
  });

  it("never leaks the raw response body/error text through the new diagnostic fields", async () => {
    const identifiableDetail = "synthetic-identifiable-gemini-diagnostic-leak-4b1e";
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: identifiableDetail } }, 500),
    );

    const error = await captureUpstreamServiceError(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    );

    const serialized = JSON.stringify({
      stage: error.stage,
      httpStatus: error.httpStatus,
      interactionStatus: error.interactionStatus,
    });
    expect(serialized).not.toContain(identifiableDetail);
  });
});

describe("callGeminiInteraction — no Secret or raw error body leakage", () => {
  it("never includes the API key in a thrown error", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: "bad request" } }, 400),
    );

    await expect(
      callGeminiInteraction({ model: "gemini-3.5-flash-lite" }, { apiKey: API_KEY, fetchFn }),
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      return !serialized.includes(API_KEY);
    });
  });

  it("never includes the raw response error body text in a thrown error's public message", async () => {
    const identifiableDetail = "synthetic-identifiable-gemini-error-detail-9f3c";
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: identifiableDetail } }, 400),
    );

    const error = await callGeminiInteraction(
      { model: "gemini-3.5-flash-lite" },
      { apiKey: API_KEY, fetchFn },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PermanentUpstreamError);
    expect((error as PermanentUpstreamError).publicMessage).not.toContain(identifiableDetail);
  });
});
