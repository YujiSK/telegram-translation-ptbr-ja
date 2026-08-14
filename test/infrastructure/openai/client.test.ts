import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENAI_MAX_ATTEMPTS,
  callOpenAiResponses,
} from "../../../src/infrastructure/openai/client";
import { PermanentUpstreamError, TransientUpstreamError } from "../../../src/shared/errors";

/**
 * Every test in this file supplies its own `fetchFn` and `waitFn`, so
 * `callOpenAiResponses` never reaches the real OpenAI API and never
 * actually sleeps. `API_KEY` is an obviously synthetic value.
 */

const API_KEY = "synthetic-test-openai-key-001";

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

function noopWait(): Promise<void> {
  return Promise.resolve();
}

/** A `vi.fn` shaped like `fetch`, with a safe default so unconfigured calls fail loudly instead of hitting the network. */
function fetchMock() {
  return vi.fn((_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    Promise.reject(new Error("unmocked fetch call in test")),
  );
}

describe("callOpenAiResponses — success", () => {
  it("returns the parsed JSON body on a 200 response", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse({ output: [] }));

    const result = await callOpenAiResponses(
      { model: "gpt-4o-mini" },
      { apiKey: API_KEY, fetchFn, waitFn: noopWait },
    );

    expect(result).toEqual({ output: [] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("sends the Authorization header, JSON content-type, and the current Responses API URL", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse({ output: [] }));

    await callOpenAiResponses(
      { model: "gpt-4o-mini", input: [] },
      { apiKey: API_KEY, fetchFn, waitFn: noopWait },
    );

    const call = fetchFn.mock.calls[0];
    if (call === undefined) {
      throw new Error("expected fetchFn to have been called");
    }
    const [url, init] = call;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(requireStringBody(init?.body))).toEqual({ model: "gpt-4o-mini", input: [] });
  });

  it("never calls the real global fetch when a custom fetchFn is provided", async () => {
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse({ output: [] }));

    await callOpenAiResponses(
      { model: "gpt-4o-mini" },
      { apiKey: API_KEY, fetchFn, waitFn: noopWait },
    );

    expect(globalFetchSpy).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
  });
});

describe("callOpenAiResponses — transient failures are retried once", () => {
  it("retries after a network failure and succeeds on the second attempt", async () => {
    const fetchFn = fetchMock()
      .mockRejectedValueOnce(new TypeError("synthetic network failure"))
      .mockResolvedValueOnce(jsonResponse({ output: [] }));
    const waitFn = vi.fn(() => Promise.resolve());

    const result = await callOpenAiResponses(
      { model: "gpt-4o-mini" },
      { apiKey: API_KEY, fetchFn, waitFn },
    );

    expect(result).toEqual({ output: [] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waitFn).toHaveBeenCalledTimes(1);
  });

  it("retries after a 429 and succeeds on the second attempt", async () => {
    const fetchFn = fetchMock()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "rate limited" } }, 429))
      .mockResolvedValueOnce(jsonResponse({ output: [] }));

    const result = await callOpenAiResponses(
      { model: "gpt-4o-mini" },
      { apiKey: API_KEY, fetchFn, waitFn: noopWait },
    );

    expect(result).toEqual({ output: [] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries after a 5xx and succeeds on the second attempt", async () => {
    const fetchFn = fetchMock()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "server error" } }, 503))
      .mockResolvedValueOnce(jsonResponse({ output: [] }));

    const result = await callOpenAiResponses(
      { model: "gpt-4o-mini" },
      { apiKey: API_KEY, fetchFn, waitFn: noopWait },
    );

    expect(result).toEqual({ output: [] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("classifies a timeout as transient", async () => {
    const fetchFn = fetchMock().mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    await expect(
      callOpenAiResponses(
        { model: "gpt-4o-mini" },
        { apiKey: API_KEY, fetchFn, waitFn: noopWait, timeoutMs: 50 },
      ),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(DEFAULT_OPENAI_MAX_ATTEMPTS);
  });

  it("stops after the configured max attempts and throws TransientUpstreamError", async () => {
    const fetchFn = fetchMock().mockRejectedValue(new TypeError("synthetic network failure"));

    await expect(
      callOpenAiResponses({ model: "gpt-4o-mini" }, { apiKey: API_KEY, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(DEFAULT_OPENAI_MAX_ATTEMPTS);
  });

  it("honors a custom (lower) maxAttempts", async () => {
    const fetchFn = fetchMock().mockRejectedValue(new TypeError("synthetic network failure"));

    await expect(
      callOpenAiResponses(
        { model: "gpt-4o-mini" },
        { apiKey: API_KEY, fetchFn, waitFn: noopWait, maxAttempts: 1 },
      ),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("callOpenAiResponses — permanent failures are never retried", () => {
  it("throws PermanentUpstreamError on a 400 without retrying", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: "bad request" } }, 400),
    );

    await expect(
      callOpenAiResponses({ model: "gpt-4o-mini" }, { apiKey: API_KEY, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws PermanentUpstreamError on a 401 without retrying", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: "unauthorized" } }, 401),
    );

    await expect(
      callOpenAiResponses({ model: "gpt-4o-mini" }, { apiKey: API_KEY, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws PermanentUpstreamError on a 403 without retrying", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: "forbidden" } }, 403),
    );

    await expect(
      callOpenAiResponses({ model: "gpt-4o-mini" }, { apiKey: API_KEY, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws PermanentUpstreamError on a 200 response with a non-JSON body", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );

    await expect(
      callOpenAiResponses({ model: "gpt-4o-mini" }, { apiKey: API_KEY, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws PermanentUpstreamError when the 200 JSON body is not an object", async () => {
    const fetchFn = fetchMock().mockResolvedValue(jsonResponse([1, 2, 3]));

    await expect(
      callOpenAiResponses({ model: "gpt-4o-mini" }, { apiKey: API_KEY, fetchFn, waitFn: noopWait }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("callOpenAiResponses — no Secret leakage", () => {
  it("never includes the API key in a thrown error", async () => {
    const fetchFn = fetchMock().mockResolvedValue(
      jsonResponse({ error: { message: "bad request" } }, 400),
    );

    await expect(
      callOpenAiResponses({ model: "gpt-4o-mini" }, { apiKey: API_KEY, fetchFn, waitFn: noopWait }),
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      return !serialized.includes(API_KEY);
    });
  });
});
