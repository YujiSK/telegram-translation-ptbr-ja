import { describe, expect, it } from "vitest";

import { classifyError, logStructuredEvent } from "../../src/shared/structured-log";
import {
  PermanentUpstreamError,
  RateLimitExceededError,
  TransientUpstreamError,
  ValidationError,
} from "../../src/shared/errors";

/**
 * `stage` is included in the required object only where noted below
 * (with `interactionStatus` for the Gemini "missing"/"unrecognized"
 * sentinel cases) since `toEqual` ignores keys whose value is
 * `undefined`, matching how `classifyError` omits unset fields.
 */

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

  it("extracts a stable errorClass and service='workers-ai' — Phase 9.1B review fix, previously silently dropped", () => {
    const error = new TransientUpstreamError("synthetic workers-ai failure detail", "workers-ai");
    expect(classifyError(error)).toEqual({
      errorClass: "TransientUpstreamError",
      service: "workers-ai",
    });
  });

  it("extracts a stable errorClass and service='gemini' (Phase 9.1B)", () => {
    const error = new PermanentUpstreamError("synthetic gemini failure detail", "gemini");
    expect(classifyError(error)).toEqual({
      errorClass: "PermanentUpstreamError",
      service: "gemini",
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

  it("extracts stage and httpStatus from a Gemini TransientUpstreamError (pilot incident diagnostics)", () => {
    const error = new TransientUpstreamError("synthetic gemini http failure", "gemini", {
      stage: "http",
      httpStatus: 503,
    });
    expect(classifyError(error)).toEqual({
      errorClass: "TransientUpstreamError",
      service: "gemini",
      stage: "http",
      httpStatus: 503,
    });
  });

  it("extracts stage and interactionStatus from a Gemini PermanentUpstreamError", () => {
    const error = new PermanentUpstreamError("synthetic gemini status failure", "gemini", {
      stage: "interaction-status",
      interactionStatus: "incomplete",
    });
    expect(classifyError(error)).toEqual({
      errorClass: "PermanentUpstreamError",
      service: "gemini",
      stage: "interaction-status",
      interactionStatus: "incomplete",
    });
  });

  it("extracts the 'missing'/'unrecognized' interactionStatus sentinels, never a raw status string", () => {
    const error = new PermanentUpstreamError("synthetic gemini malformed status", "gemini", {
      stage: "interaction-status",
      interactionStatus: "unrecognized",
    });
    expect(classifyError(error)).toEqual({
      errorClass: "PermanentUpstreamError",
      service: "gemini",
      stage: "interaction-status",
      interactionStatus: "unrecognized",
    });
  });

  it("omits stage/httpStatus/interactionStatus entirely when the error carries none (backward compatible)", () => {
    const error = new TransientUpstreamError("synthetic openai failure, no diagnostics", "openai");
    const classified = classifyError(error);
    expect(classified).toEqual({ errorClass: "TransientUpstreamError", service: "openai" });
    expect(classified).not.toHaveProperty("stage");
    expect(classified).not.toHaveProperty("httpStatus");
    expect(classified).not.toHaveProperty("interactionStatus");
  });

  it("never trusts an unvalidated stage/interactionStatus injected via a duck-typed object", () => {
    // A plain object shaped like an UpstreamServiceError but with
    // out-of-enum values — classifyError must not pass these through,
    // since a log line may only ever carry the closed enum values.
    const fakeError = Object.assign(new Error("synthetic duck-typed error"), {
      name: "TransientUpstreamError",
      service: "gemini",
      stage: "not-a-real-stage",
      httpStatus: "not-a-number",
      interactionStatus: "raw-unvalidated-status-text",
    });
    const classified = classifyError(fakeError);
    expect(classified).toEqual({ errorClass: "TransientUpstreamError", service: "gemini" });
  });
});

describe("LogFields — new diagnostic fields serialize safely", () => {
  it("serializes stage/httpStatus/interactionStatus/endpointVersion/model without any raw response content", () => {
    const { lines, sink } = capturingSink();

    logStructuredEvent(
      {
        event: "telegram_webhook",
        status: 500,
        durationMs: 7,
        errorClass: "TransientUpstreamError",
        service: "gemini",
        stage: "http",
        httpStatus: 503,
        endpointVersion: "v1",
        model: "gemini-3.5-flash-lite",
      },
      sink,
    );

    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.stage).toBe("http");
    expect(parsed.httpStatus).toBe(503);
    expect(parsed.endpointVersion).toBe("v1");
    expect(parsed.model).toBe("gemini-3.5-flash-lite");
    expect(parsed).not.toHaveProperty("interactionStatus");
  });
});
