/** Week-over-week trend for the weekly revenue email (pure). */
export type Trend = {
  currentMinor: number;
  previousMinor: number;
  deltaMinor: number;
  /** Percentage change rounded to one decimal; null when the previous week was zero. */
  pctChange: number | null;
  direction: "up" | "down" | "flat";
};

export function revenueTrend(currentMinor: number, previousMinor: number): Trend {
  const deltaMinor = currentMinor - previousMinor;
  const direction = deltaMinor > 0 ? "up" : deltaMinor < 0 ? "down" : "flat";
  const pctChange =
    previousMinor === 0 ? null : Math.round((deltaMinor / Math.abs(previousMinor)) * 1000) / 10;
  return { currentMinor, previousMinor, deltaMinor, pctChange, direction };
}

export function describeTrend(t: Trend): string {
  if (t.pctChange === null) {
    return t.currentMinor > 0 ? "new this week (no attributed revenue the week before)" : "no change";
  }
  if (t.direction === "flat") return "flat vs the previous 7 days";
  return `${t.direction === "up" ? "up" : "down"} ${Math.abs(t.pctChange)}% vs the previous 7 days`;
}

/** Fills missing days with zero so the dashboard chart has a continuous series. */
export function fillDailySeries(
  rows: Array<{ date: string; amountMinor: number }>,
  dates: string[],
): Array<{ date: string; amountMinor: number }> {
  const byDate = new Map(rows.map((r) => [r.date, r.amountMinor]));
  return dates.map((date) => ({ date, amountMinor: byDate.get(date) ?? 0 }));
}
