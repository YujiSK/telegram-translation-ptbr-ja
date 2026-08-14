import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  PermanentUpstreamError,
  TransientUpstreamError,
  ValidationError,
  isAppError,
} from "../../src/shared/errors";

describe("ValidationError", () => {
  it("has a stable code, is non-retryable, and exposes a safe public message", () => {
    const error = new ValidationError("Update is missing a valid update_id", "update_id");

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.retryable).toBe(false);
    expect(error.publicMessage).toBe("Update is missing a valid update_id");
    expect(error.field).toBe("update_id");
  });
});

describe("ConfigurationError", () => {
  it("has a stable code and is non-retryable", () => {
    const error = new ConfigurationError(
      'Invalid configuration for "OPENAI_MODEL"',
      "OPENAI_MODEL",
    );

    expect(error.code).toBe("CONFIGURATION_ERROR");
    expect(error.retryable).toBe(false);
    expect(error.key).toBe("OPENAI_MODEL");
  });
});

describe("TransientUpstreamError", () => {
  it("has a stable code and is retryable", () => {
    const error = new TransientUpstreamError("Telegram request timed out", "telegram");

    expect(error.code).toBe("UPSTREAM_TRANSIENT_ERROR");
    expect(error.retryable).toBe(true);
    expect(error.service).toBe("telegram");
  });
});

describe("PermanentUpstreamError", () => {
  it("has a stable code and is not retryable", () => {
    const error = new PermanentUpstreamError("OpenAI response failed schema validation", "openai");

    expect(error.code).toBe("UPSTREAM_PERMANENT_ERROR");
    expect(error.retryable).toBe(false);
    expect(error.service).toBe("openai");
  });
});

describe("isAppError", () => {
  it("recognizes AppError instances", () => {
    expect(isAppError(new ValidationError("bad input"))).toBe(true);
    expect(isAppError(new TransientUpstreamError("timeout", "d1"))).toBe(true);
  });

  it("rejects plain errors and non-error values", () => {
    expect(isAppError(new Error("plain error"))).toBe(false);
    expect(isAppError("just a string")).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});

describe("error payload safety", () => {
  it("does not expose a field for raw payloads or Secrets", () => {
    const errors = [
      new ValidationError("bad input", "message.text"),
      new ConfigurationError("bad config", "OPENAI_MODEL"),
      new TransientUpstreamError("timeout", "telegram"),
      new PermanentUpstreamError("rejected", "openai"),
    ];

    for (const error of errors) {
      const ownKeys = Object.keys(error);
      expect(ownKeys).not.toContain("payload");
      expect(ownKeys).not.toContain("rawUpdate");
      expect(ownKeys).not.toContain("secret");
      expect(ownKeys).not.toContain("prompt");
    }
  });
});
