/**
 * UTC calendar helpers. Billing periods are calendar months in UTC:
 * [periodStart 00:00:00.000Z, next month's 1st 00:00:00.000Z).
 */

export const DAY_MS = 86_400_000;

export type Period = {
  /** Inclusive start, e.g. 2026-08-01T00:00:00.000Z */
  start: Date;
  /** Exclusive end, e.g. 2026-09-01T00:00:00.000Z */
  end: Date;
  /** "YYYY-MM" */
  key: string;
  /** "YYYY-MM-DD" of the first day */
  startDate: string;
  /** "YYYY-MM-DD" of the last day (inclusive) */
  endDate: string;
};

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function monthPeriod(year: number, monthIndex0: number): Period {
  const start = new Date(Date.UTC(year, monthIndex0, 1));
  const end = new Date(Date.UTC(year, monthIndex0 + 1, 1));
  return {
    start,
    end,
    key: start.toISOString().slice(0, 7),
    startDate: isoDate(start),
    endDate: isoDate(addDays(end, -1)),
  };
}

export function periodContaining(d: Date): Period {
  return monthPeriod(d.getUTCFullYear(), d.getUTCMonth());
}

/** The calendar month before the one containing `now` (what the monthly billing job bills). */
export function previousPeriod(now: Date): Period {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

export function parsePeriodKey(key: string): Period {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Invalid period "${key}", expected YYYY-MM`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month in period "${key}"`);
  return monthPeriod(Number(m[1]), month - 1);
}

/** Inclusive list of YYYY-MM-DD strings between two dates (UTC). */
export function dateRange(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let d = startOfUtcDay(from); d <= to; d = addDays(d, 1)) out.push(isoDate(d));
  return out;
}

/** ISO-8601 week key, e.g. "2026-W39". */
export function isoWeekKey(d: Date): string {
  const date = startOfUtcDay(d);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function daysInPeriod(p: Period): number {
  return Math.round((p.end.getTime() - p.start.getTime()) / DAY_MS);
}
