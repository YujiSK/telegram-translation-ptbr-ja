import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeChatHandledUpdateLimit,
  consumeChatOpenAiAttemptLimit,
  consumeDailyOpenAiAttemptLimit,
} from "../../../src/infrastructure/d1/reliability-counters";
import { PermanentUpstreamError, TransientUpstreamError } from "../../../src/shared/errors";

/** All chat IDs below are obviously synthetic. */
const CHAT_ONE = -1009400000001;
const CHAT_TWO = -1009400000002;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limit_counters"),
    env.DB.prepare("DELETE FROM openai_daily_usage"),
  ]);
});

describe("consumeChatHandledUpdateLimit", () => {
  it("allows the first request in a window and reports count 1", async () => {
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).resolves.toBe(true);
  });

  it("allows requests up to the limit, then blocks the next one in the same window", async () => {
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).resolves.toBe(true);
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).resolves.toBe(true);
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).resolves.toBe(true);
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).resolves.toBe(false);
  });

  it("still increments the counter for a blocked request", async () => {
    for (let i = 0; i < 3; i += 1) {
      await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3);
    }
    await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3); // blocked (4th)

    const row = await env.DB.prepare(
      "SELECT request_count FROM rate_limit_counters WHERE scope_type = 'chat_updates' AND scope_id = ?1",
    )
      .bind(CHAT_ONE)
      .first<number>("request_count");
    expect(row).toBe(4);
  });

  it("resets the count when the window changes", async () => {
    await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3);
    await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3);
    await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3);
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).resolves.toBe(false);

    // A new window resets the count, even with the same limit.
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 101, 3)).resolves.toBe(true);
  });

  it("never grows unbounded rows — one row per (scope_type, chat)", async () => {
    for (let window = 100; window < 110; window += 1) {
      await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, window, 3);
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rate_limit_counters WHERE scope_type = 'chat_updates' AND scope_id = ?1",
    )
      .bind(CHAT_ONE)
      .first<number>("count");
    expect(count).toBe(1);
  });

  it("tracks different chats independently", async () => {
    await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 1);
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 1)).resolves.toBe(false);

    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_TWO, 100, 1)).resolves.toBe(true);
  });

  it("keeps the chat_updates and chat_openai counters independent for the same chat", async () => {
    await consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 1);
    await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 1)).resolves.toBe(false);

    // A completely separate scope, unaffected by the chat_updates counter above.
    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 1)).resolves.toBe(true);
  });

  it("classifies a raw D1 query failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("consumeChatOpenAiAttemptLimit", () => {
  it("allows attempts up to the limit, then blocks the next one in the same window", async () => {
    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 2)).resolves.toBe(true);
    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 2)).resolves.toBe(true);
    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 2)).resolves.toBe(false);
  });

  it("tracks different chats independently", async () => {
    await consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 1);
    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 1)).resolves.toBe(false);

    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_TWO, 100, 1)).resolves.toBe(true);
  });

  it("resets on a new minute window", async () => {
    await consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 1);
    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 1)).resolves.toBe(false);

    await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 101, 1)).resolves.toBe(true);
  });

  it("classifies a raw D1 query failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(consumeChatOpenAiAttemptLimit(env.DB, CHAT_ONE, 100, 2)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("consumeDailyOpenAiAttemptLimit", () => {
  it("allows attempts up to the limit, then blocks the next one on the same day", async () => {
    await expect(consumeDailyOpenAiAttemptLimit(env.DB, 500, 2)).resolves.toBe(true);
    await expect(consumeDailyOpenAiAttemptLimit(env.DB, 500, 2)).resolves.toBe(true);
    await expect(consumeDailyOpenAiAttemptLimit(env.DB, 500, 2)).resolves.toBe(false);
  });

  it("is a global singleton — shared across all chats, not per-chat", async () => {
    await consumeDailyOpenAiAttemptLimit(env.DB, 500, 2);
    await consumeDailyOpenAiAttemptLimit(env.DB, 500, 2);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM openai_daily_usage",
    ).first<number>("count");
    expect(count).toBe(1);
  });

  it("resets on a new UTC day", async () => {
    await consumeDailyOpenAiAttemptLimit(env.DB, 500, 1);
    await expect(consumeDailyOpenAiAttemptLimit(env.DB, 500, 1)).resolves.toBe(false);

    await expect(consumeDailyOpenAiAttemptLimit(env.DB, 501, 1)).resolves.toBe(true);
  });

  it("classifies a raw D1 query failure as transient", async () => {
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("synthetic D1 outage");
    });
    try {
      await expect(consumeDailyOpenAiAttemptLimit(env.DB, 500, 2)).rejects.toBeInstanceOf(
        TransientUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});

describe("reliability counters — malformed row handling", () => {
  it("classifies a malformed RETURNING row (negative count) as a permanent failure", async () => {
    // A real CHECK-constrained row can never actually have a negative
    // count — this simulates data corruption / future schema drift, as
    // in the Phase 5/6 malformed-row tests.
    class NegativeCountStatement implements D1PreparedStatement {
      bind(..._values: unknown[]): D1PreparedStatement {
        return this;
      }
      first<T = unknown>(_colName: string): Promise<T | null>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      first(): Promise<unknown> {
        return Promise.resolve({ request_count: -1 });
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
      await expect(consumeChatHandledUpdateLimit(env.DB, CHAT_ONE, 100, 3)).rejects.toBeInstanceOf(
        PermanentUpstreamError,
      );
    } finally {
      prepareSpy.mockRestore();
    }
  });
});
