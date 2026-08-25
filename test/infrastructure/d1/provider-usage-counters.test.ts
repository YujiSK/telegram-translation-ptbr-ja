import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeGeminiDailyAttemptLimit,
  consumeGeminiMinuteAttemptLimit,
} from "../../../src/infrastructure/d1/provider-usage-counters";
import { PermanentUpstreamError, TransientUpstreamError } from "../../../src/shared/errors";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM provider_usage_counters").run();
});

describe("consumeGeminiMinuteAttemptLimit", () => {
  it("allows the first attempt in a window and reports count 1", async () => {
    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).resolves.toBe(true);
  });

  it("allows attempts up to the limit, then blocks the next one in the same window", async () => {
    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).resolves.toBe(true);
    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).resolves.toBe(true);
    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).resolves.toBe(true);
    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).resolves.toBe(false);
  });

  it("still increments the counter for a blocked attempt", async () => {
    for (let i = 0; i < 3; i += 1) {
      await consumeGeminiMinuteAttemptLimit(env.DB, 100, 3);
    }
    await consumeGeminiMinuteAttemptLimit(env.DB, 100, 3); // blocked (4th)

    const row = await env.DB.prepare(
      "SELECT attempt_count FROM provider_usage_counters WHERE provider = 'gemini' AND scope_type = 'global_minute'",
    ).first<number>("attempt_count");
    expect(row).toBe(4);
  });

  it("resets the count when the minute window changes", async () => {
    await consumeGeminiMinuteAttemptLimit(env.DB, 100, 3);
    await consumeGeminiMinuteAttemptLimit(env.DB, 100, 3);
    await consumeGeminiMinuteAttemptLimit(env.DB, 100, 3);
    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).resolves.toBe(false);

    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 101, 3)).resolves.toBe(true);
  });

  it("never grows unbounded rows — exactly one row for the global_minute scope", async () => {
    for (let window = 100; window < 110; window += 1) {
      await consumeGeminiMinuteAttemptLimit(env.DB, window, 3);
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM provider_usage_counters WHERE provider = 'gemini' AND scope_type = 'global_minute'",
    ).first<number>("count");
    expect(count).toBe(1);
  });

  it("is a global singleton — the minute and day scopes stay independent", async () => {
    await consumeGeminiMinuteAttemptLimit(env.DB, 100, 1);
    await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 1)).resolves.toBe(false);

    // A completely separate scope, unaffected by the minute counter above.
    await expect(consumeGeminiDailyAttemptLimit(env.DB, 500, 1)).resolves.toBe(true);
  });

  it("classifies a raw D1 query failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("consumeGeminiDailyAttemptLimit", () => {
  it("allows attempts up to the limit, then blocks the next one on the same day", async () => {
    await expect(consumeGeminiDailyAttemptLimit(env.DB, 500, 2)).resolves.toBe(true);
    await expect(consumeGeminiDailyAttemptLimit(env.DB, 500, 2)).resolves.toBe(true);
    await expect(consumeGeminiDailyAttemptLimit(env.DB, 500, 2)).resolves.toBe(false);
  });

  it("is a global counter — exactly one row for the global_day scope", async () => {
    await consumeGeminiDailyAttemptLimit(env.DB, 500, 2);
    await consumeGeminiDailyAttemptLimit(env.DB, 500, 2);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM provider_usage_counters WHERE provider = 'gemini' AND scope_type = 'global_day'",
    ).first<number>("count");
    expect(count).toBe(1);
  });

  it("resets on a new UTC day", async () => {
    await consumeGeminiDailyAttemptLimit(env.DB, 500, 1);
    await expect(consumeGeminiDailyAttemptLimit(env.DB, 500, 1)).resolves.toBe(false);

    await expect(consumeGeminiDailyAttemptLimit(env.DB, 501, 1)).resolves.toBe(true);
  });

  it("classifies a raw D1 query failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(consumeGeminiDailyAttemptLimit(env.DB, 500, 2)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("provider usage counters — malformed row handling", () => {
  it("classifies a malformed RETURNING row (negative count) as a permanent failure", async () => {
    // A real CHECK-constrained row can never actually have a negative
    // count — this simulates data corruption / future schema drift, as
    // in the Phase 5/6/7 malformed-row tests.
    class NegativeCountStatement implements D1PreparedStatement {
      bind(..._values: unknown[]): D1PreparedStatement {
        return this;
      }
      first<T = unknown>(_colName: string): Promise<T | null>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      first(): Promise<unknown> {
        return Promise.resolve({ attempt_count: -1 });
      }
      run(): never {
        throw new Error("not implemented in this test fake");
      }
      all(): never {
        throw new Error("not implemented in this test fake");
      }
      raw(): never {
        throw new Error("not implemented in this test fake");
      }
    }
    const prepareSpy = vi
      .spyOn(env.DB, "prepare")
      .mockImplementation(() => new NegativeCountStatement());

    try {
      await expect(consumeGeminiMinuteAttemptLimit(env.DB, 100, 3)).rejects.toBeInstanceOf(
        PermanentUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
