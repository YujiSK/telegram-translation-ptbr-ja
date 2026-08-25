import { describe, expect, it, vi } from "vitest";

import {
  callWorkersAiChat,
  type WorkersAiBinding,
} from "../../../src/infrastructure/workers-ai/client";
import { PermanentUpstreamError, TransientUpstreamError } from "../../../src/shared/errors";

/**
 * `env.AI.run()` is never called in this file — `binding` is always a
 * synthetic in-memory fake (`vi.fn()`), never the real Workers AI
 * binding, so no test here can ever perform a real inference call.
 */

function fakeBinding(run: WorkersAiBinding["run"]): WorkersAiBinding {
  return { run };
}

describe("callWorkersAiChat — success", () => {
  it("calls the binding with the model, inputs, and an AbortSignal", async () => {
    const run = vi.fn(
      (_model: string, _inputs: Record<string, unknown>, _options?: { signal?: AbortSignal }) =>
        Promise.resolve({ ok: true }),
    );
    const result = await callWorkersAiChat(
      { messages: [] },
      { binding: fakeBinding(run), model: "@cf/synthetic/test-model" },
    );

    expect(result).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0];
    expect(call?.[0]).toBe("@cf/synthetic/test-model");
    expect(call?.[1]).toEqual({ messages: [] });
    expect(call?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("callWorkersAiChat — timeout", () => {
  it("classifies an AbortError as transient", async () => {
    const run = vi.fn(() => Promise.reject(new DOMException("aborted", "AbortError")));
    const promise = callWorkersAiChat(
      { messages: [] },
      { binding: fakeBinding(run), model: "@cf/synthetic/test-model", timeoutMs: 5 },
    );

    await expect(promise).rejects.toBeInstanceOf(TransientUpstreamError);
  });

  it("classifies a TimeoutError as transient", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    const run = vi.fn(() => Promise.reject(timeoutError));

    await expect(
      callWorkersAiChat({ messages: [] }, { binding: fakeBinding(run), model: "m" }),
    ).rejects.toBeInstanceOf(TransientUpstreamError);
  });
});

describe("callWorkersAiChat — documented transient signals", () => {
  it.each(["429", "500", "502", "503", "504", "408", "3036", "3040"])(
    "classifies an error mentioning %s as transient",
    async (code) => {
      const run = vi.fn(() => Promise.reject(new Error(`synthetic failure: ${code}`)));

      await expect(
        callWorkersAiChat({ messages: [] }, { binding: fakeBinding(run), model: "m" }),
      ).rejects.toBeInstanceOf(TransientUpstreamError);
    },
  );
});

describe("callWorkersAiChat — documented permanent signals", () => {
  it.each(["400", "401", "403", "404", "422"])(
    "classifies an error mentioning %s as permanent",
    async (code) => {
      const run = vi.fn(() => Promise.reject(new Error(`synthetic failure: ${code}`)));

      await expect(
        callWorkersAiChat({ messages: [] }, { binding: fakeBinding(run), model: "m" }),
      ).rejects.toBeInstanceOf(PermanentUpstreamError);
    },
  );

  it("classifies an unrecognized failure shape as permanent (fail closed, never guessed retryable)", async () => {
    const run = vi.fn(() =>
      Promise.reject(new Error("some completely unrecognized failure shape")),
    );

    await expect(
      callWorkersAiChat({ messages: [] }, { binding: fakeBinding(run), model: "m" }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
  });

  it("classifies a non-Error thrown value as permanent", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately testing the non-Error-thrown-value defense path.
    const run = vi.fn(() => Promise.reject("a thrown string, not an Error"));

    await expect(
      callWorkersAiChat({ messages: [] }, { binding: fakeBinding(run), model: "m" }),
    ).rejects.toBeInstanceOf(PermanentUpstreamError);
  });
});

describe("callWorkersAiChat — error classification never leaks the raw error message", () => {
  it("uses a fixed public message, not the caught error's own message", async () => {
    const identifiableDetail = "synthetic-identifiable-workers-ai-error-detail-7f2a";
    const run = vi.fn(() => Promise.reject(new Error(`429 ${identifiableDetail}`)));

    const error = await callWorkersAiChat(
      { messages: [] },
      { binding: fakeBinding(run), model: "m" },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransientUpstreamError);
    expect((error as TransientUpstreamError).publicMessage).not.toContain(identifiableDetail);
  });
});
