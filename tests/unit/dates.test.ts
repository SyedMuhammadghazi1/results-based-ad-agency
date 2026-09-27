import { describe, expect, it } from "vitest";
import {
  dateRange,
  daysInPeriod,
  isoWeekKey,
  parsePeriodKey,
  periodContaining,
  previousPeriod,
} from "@/lib/dates";

describe("UTC billing periods", () => {
  it("bills the previous calendar month", () => {
    const p = previousPeriod(new Date("2026-09-01T06:00:00Z"));
    expect(p.key).toBe("2026-08");
    expect(p.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(p.startDate).toBe("2026-08-01");
    expect(p.endDate).toBe("2026-08-31");
  });

  it("wraps around the year", () => {
    expect(previousPeriod(new Date("2027-01-01T00:00:00Z")).key).toBe("2026-12");
  });

  it("uses UTC, not local time, at month boundaries", () => {
    expect(periodContaining(new Date("2026-08-31T23:59:59.999Z")).key).toBe("2026-08");
    expect(periodContaining(new Date("2026-09-01T00:00:00.000Z")).key).toBe("2026-09");
  });

  it("parses period keys", () => {
    expect(parsePeriodKey("2026-02").endDate).toBe("2026-02-28");
    expect(daysInPeriod(parsePeriodKey("2028-02"))).toBe(29);
    expect(() => parsePeriodKey("2026-13")).toThrow();
    expect(() => parsePeriodKey("26-01")).toThrow();
  });

  it("lists dates inclusively", () => {
    expect(dateRange(new Date("2026-08-30T10:00:00Z"), new Date("2026-09-01T00:00:00Z"))).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
    ]);
  });

  it("computes ISO week keys", () => {
    expect(isoWeekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});
