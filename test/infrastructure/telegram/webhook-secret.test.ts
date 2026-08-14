import { describe, expect, it } from "vitest";

import { isWebhookSecretValid } from "../../../src/infrastructure/telegram/webhook-secret";

const HEADER = "X-Telegram-Bot-Api-Secret-Token";
const SYNTHETIC_SECRET = "synthetic-webhook-secret-001";

function requestWithHeader(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) {
    headers.set(HEADER, value);
  }
  return new Request("https://example.com/telegram/webhook", { method: "POST", headers });
}

describe("isWebhookSecretValid", () => {
  it("accepts a request carrying the correct secret", () => {
    expect(isWebhookSecretValid(requestWithHeader(SYNTHETIC_SECRET), SYNTHETIC_SECRET)).toBe(true);
  });

  it("rejects a request missing the header entirely", () => {
    expect(isWebhookSecretValid(requestWithHeader(null), SYNTHETIC_SECRET)).toBe(false);
  });

  it("rejects a request with a mismatched header value", () => {
    expect(isWebhookSecretValid(requestWithHeader("wrong-secret"), SYNTHETIC_SECRET)).toBe(false);
  });

  it("rejects a header value that only differs in length from the configured secret", () => {
    expect(
      isWebhookSecretValid(requestWithHeader(`${SYNTHETIC_SECRET}-extra`), SYNTHETIC_SECRET),
    ).toBe(false);
  });

  it("fails safely when the configured secret is undefined, even with a header present", () => {
    expect(isWebhookSecretValid(requestWithHeader("anything"), undefined)).toBe(false);
  });

  it("fails safely when the configured secret is an empty string", () => {
    expect(isWebhookSecretValid(requestWithHeader("anything"), "")).toBe(false);
  });

  it("rejects an empty header value", () => {
    expect(isWebhookSecretValid(requestWithHeader(""), SYNTHETIC_SECRET)).toBe(false);
  });
});
