import { describe, expect, it } from "vitest";

import { isSetupSecretValid } from "../../../src/infrastructure/admin/setup-secret";

const HEADER = "X-Setup-Admin-Secret";
const SYNTHETIC_SECRET = "synthetic-setup-admin-secret-001";

function requestWithHeader(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) {
    headers.set(HEADER, value);
  }
  return new Request("https://example.com/admin/bootstrap", { method: "POST", headers });
}

describe("isSetupSecretValid", () => {
  it("accepts a request carrying the correct secret", () => {
    expect(isSetupSecretValid(requestWithHeader(SYNTHETIC_SECRET), SYNTHETIC_SECRET)).toBe(true);
  });

  it("rejects a request missing the header entirely", () => {
    expect(isSetupSecretValid(requestWithHeader(null), SYNTHETIC_SECRET)).toBe(false);
  });

  it("rejects a request with a mismatched header value", () => {
    expect(isSetupSecretValid(requestWithHeader("wrong-secret"), SYNTHETIC_SECRET)).toBe(false);
  });

  it("rejects a header value that only differs in length from the configured secret", () => {
    expect(
      isSetupSecretValid(requestWithHeader(`${SYNTHETIC_SECRET}-extra`), SYNTHETIC_SECRET),
    ).toBe(false);
  });

  it("fails safely when the configured secret is undefined, even with a header present", () => {
    expect(isSetupSecretValid(requestWithHeader("anything"), undefined)).toBe(false);
  });

  it("fails safely when the configured secret is an empty string", () => {
    expect(isSetupSecretValid(requestWithHeader("anything"), "")).toBe(false);
  });

  it("rejects an empty header value", () => {
    expect(isSetupSecretValid(requestWithHeader(""), SYNTHETIC_SECRET)).toBe(false);
  });

  it("does not accept the value under the Telegram webhook secret header name", () => {
    const headers = new Headers({ "X-Telegram-Bot-Api-Secret-Token": SYNTHETIC_SECRET });
    const request = new Request("https://example.com/admin/bootstrap", { method: "POST", headers });
    expect(isSetupSecretValid(request, SYNTHETIC_SECRET)).toBe(false);
  });
});
