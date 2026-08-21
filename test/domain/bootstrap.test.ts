import { describe, expect, it } from "vitest";

import { parseBootstrapRequest } from "../../src/domain/bootstrap";

describe("parseBootstrapRequest", () => {
  it("accepts a valid request", () => {
    const result = parseBootstrapRequest({ adminUserId: 123456789, chatId: -1001234567890 });
    expect(result).toEqual({ ok: true, value: { adminUserId: 123456789, chatId: -1001234567890 } });
  });

  it("accepts a positive chatId (a private chat, not a group)", () => {
    const result = parseBootstrapRequest({ adminUserId: 123456789, chatId: 987654321 });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object body", () => {
    const result = parseBootstrapRequest("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects null", () => {
    const result = parseBootstrapRequest(null);
    expect(result.ok).toBe(false);
  });

  it("rejects an array body", () => {
    const result = parseBootstrapRequest([{ adminUserId: 1, chatId: -1 }]);
    expect(result.ok).toBe(false);
  });

  it("rejects a missing adminUserId", () => {
    const result = parseBootstrapRequest({ chatId: -1001234567890 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("adminUserId");
    }
  });

  it("rejects a zero adminUserId", () => {
    const result = parseBootstrapRequest({ adminUserId: 0, chatId: -1001234567890 });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative adminUserId", () => {
    const result = parseBootstrapRequest({ adminUserId: -5, chatId: -1001234567890 });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer adminUserId", () => {
    const result = parseBootstrapRequest({ adminUserId: 1.5, chatId: -1001234567890 });
    expect(result.ok).toBe(false);
  });

  it("rejects a string adminUserId", () => {
    const result = parseBootstrapRequest({ adminUserId: "123", chatId: -1001234567890 });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing chatId", () => {
    const result = parseBootstrapRequest({ adminUserId: 123456789 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("chatId");
    }
  });

  it("rejects a zero chatId", () => {
    const result = parseBootstrapRequest({ adminUserId: 123456789, chatId: 0 });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer chatId", () => {
    const result = parseBootstrapRequest({ adminUserId: 123456789, chatId: -1.5 });
    expect(result.ok).toBe(false);
  });

  it("ignores extra fields on the input object", () => {
    const result = parseBootstrapRequest({
      adminUserId: 123456789,
      chatId: -1001234567890,
      extra: "should be ignored",
      nested: { also: "ignored" },
    });
    expect(result).toEqual({ ok: true, value: { adminUserId: 123456789, chatId: -1001234567890 } });
  });
});
