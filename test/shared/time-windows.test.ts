import { describe, expect, it } from "vitest";

import { minuteWindowId, utcDayId } from "../../src/shared/time-windows";

describe("minuteWindowId", () => {
  it("maps every instant within the same UTC minute to the same window", () => {
    const start = Date.UTC(2026, 7, 21, 3, 45, 0);
    const end = Date.UTC(2026, 7, 21, 3, 45, 59, 999);

    expect(minuteWindowId(start)).toBe(minuteWindowId(end));
  });

  it("maps the next minute to a different (incremented) window", () => {
    const thisMinute = Date.UTC(2026, 7, 21, 3, 45, 30);
    const nextMinute = Date.UTC(2026, 7, 21, 3, 46, 0);

    expect(minuteWindowId(nextMinute)).toBe(minuteWindowId(thisMinute) + 1);
  });

  it("is deterministic for the same input", () => {
    const nowMs = Date.UTC(2026, 7, 21, 12, 0, 0);
    expect(minuteWindowId(nowMs)).toBe(minuteWindowId(nowMs));
  });
});

describe("utcDayId", () => {
  it("maps every instant within the same UTC day to the same window, regardless of local timezone framing", () => {
    const start = Date.UTC(2026, 7, 21, 0, 0, 0);
    const end = Date.UTC(2026, 7, 21, 23, 59, 59, 999);

    expect(utcDayId(start)).toBe(utcDayId(end));
  });

  it("maps the next UTC day to a different (incremented) window", () => {
    const today = Date.UTC(2026, 7, 21, 12, 0, 0);
    const tomorrow = Date.UTC(2026, 7, 22, 0, 0, 0);

    expect(utcDayId(tomorrow)).toBe(utcDayId(today) + 1);
  });

  it("rolls over exactly at UTC midnight, not at a local-timezone midnight", () => {
    const justBeforeMidnightUtc = Date.UTC(2026, 7, 21, 23, 59, 59, 999);
    const justAfterMidnightUtc = Date.UTC(2026, 7, 22, 0, 0, 0, 0);

    expect(utcDayId(justAfterMidnightUtc)).toBe(utcDayId(justBeforeMidnightUtc) + 1);
  });
});
