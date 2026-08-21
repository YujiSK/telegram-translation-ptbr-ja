import { describe, expect, it } from "vitest";

import { classifyError, logStructuredEvent } from "../../src/shared/structured-log";
import {
  PermanentUpstreamError,
  RateLimitExceededError,
  TransientUpstreamError,
  ValidationError,
} from "../../src/shared/errors";

/**
 * These tests inject a capturing sink rather than writing to the real
 * console, so log content can be asserted on directly.
 */

function capturingSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe("logStructuredEvent", () => {
  it("emits exactly one JSON line per call", () => {
    const { lines, sink } = capturingSink();

    logStructuredEvent({ event: "telegram_webhook", status: 200, durationMs: 12 }, sink);

    expect(lines).toHaveLength(1);
    expect(() => {
      JSON.parse(lines[0] ?? "");
    }).not.toThrow();
  });

  it("serializes only the allowlisted fields provided", () => {
    const { lines, sink } = capturingSink();

    logStructuredEvent(
      {
        event: "telegram_webhook",
        outcome: "translated",
        status: 200,
        durationMs: 42,
        updateId: 930000001,
        chatId: -1008000000001,
      },
      sink,
    );

    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed).toEqual({
      event: "telegram_webhook",
      outcome: "translated",
      status: 200,
      durationMs: 42,
      updateId: 930000001,
      chatId: -1008000000001,
    });
  });

  it("supports error/rate-limit fields without message text or Secrets", () => {
    const { lines, sink } = capturingSink();

    logStructuredEvent(
      {
        event: "telegram_webhook",
        status: 500,
        durationMs: 5,
        errorClass: "TransientUpstreamError",
        service: "openai",
        attempt: 2,
        retryCount: 1,
      },
      sink,
    );

    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.errorClass).toBe("TransientUpstreamError");
    expect(parsed.service).toBe("openai");
    expect(parsed.attempt).toBe(2);
    expect(parsed.retryCount).toBe(1);
  });

  it("supports rate/usage limitType without message text", () => {
    const { lines, sink } = capturingSink();

    logStructuredEvent(
      {
        event: "telegram_webhook",
        outcome: "ignored:rate-limited",
        status: 200,
        durationMs: 3,
        limitType: "chat-updates",
        chatId: -1008000000001,
      },
      sink,
    );

    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.limitType).toBe("chat-updates");
  });
});

describe("classifyError", () => {
  it("extracts a stable errorClass and service from a TransientUpstreamError", () => {
    const error = new TransientUpstreamError("synthetic transient failure detail", "d1");
    expect(classifyError(error)).toEqual({ errorClass: "TransientUpstreamError", service: "d1" });
  });

  it("extracts a stable errorClass and service from a PermanentUpstreamError", () => {
    const error = new PermanentUpstreamError("synthetic permanent failure detail", "telegram");
    expect(classifyError(error)).toEqual({
      errorClass: "PermanentUpstreamError",
      service: "telegram",
    });
  });

  it("extracts errorClass without a service for a non-upstream AppError", () => {
    const error = new ValidationError("synthetic validation failure detail");
    expect(classifyError(error)).toEqual({ errorClass: "ValidationError" });
  });

  it("extracts errorClass without a service for a RateLimitExceededError", () => {
    const error = new RateLimitExceededError("synthetic rate limit detail");
    expect(classifyError(error)).toEqual({ errorClass: "RateLimitExceededError" });
  });

  it("extracts errorClass for a plain Error", () => {
    const error = new Error("synthetic plain error detail");
    expect(classifyError(error)).toEqual({ errorClass: "Error" });
  });

  it("falls back to UnknownError for a non-Error thrown value", () => {
    expect(classifyError("a thrown string, not an Error")).toEqual({ errorClass: "UnknownError" });
    expect(classifyError(undefined)).toEqual({ errorClass: "UnknownError" });
  });

  it("never includes the original error message in its output", () => {
    const identifiableMessage = "synthetic-identifiable-secret-shaped-detail-9f3a";
    const error = new TransientUpstreamError(identifiableMessage, "openai");

    const classified = classifyError(error);
    const serialized = JSON.stringify(classified);
    expect(serialized).not.toContain(identifiableMessage);
  });
});
