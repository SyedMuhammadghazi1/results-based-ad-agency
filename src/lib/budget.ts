import { DAY_MS, daysInPeriod, periodContaining } from "./dates";

/**
 * Monthly spend-cap guard (pure). Spend is what the client pays the ad platforms directly;
 * the cap is the ceiling they set during onboarding.
 */

export type BudgetState = "ok" | "near" | "reached";

export const NEAR_CAP_THRESHOLD_BPS = 9000; // 90%

export function evaluateBudget(mtdSpendMinor: number, capMinor: number): BudgetState {
  if (capMinor <= 0) return "reached";
  if (mtdSpendMinor >= capMinor) return "reached";
  if (mtdSpendMinor * 10_000 >= capMinor * NEAR_CAP_THRESHOLD_BPS) return "near";
  return "ok";
}

/**
 * Pacing = actual month-to-date spend ÷ the spend expected by now if the cap were spent evenly.
 * 1.0 is on pace, > 1 is ahead (will hit the cap early).
 */
export function pacing(now: Date, mtdSpendMinor: number, capMinor: number) {
  const period = periodContaining(now);
  const elapsedDays = Math.max((now.getTime() - period.start.getTime()) / DAY_MS, 1 / 24);
  const expected = (capMinor * elapsedDays) / daysInPeriod(period);
  const projected = Math.round((mtdSpendMinor / elapsedDays) * daysInPeriod(period));
  return {
    ratio: expected > 0 ? mtdSpendMinor / expected : 0,
    projectedMonthSpendMinor: projected,
    capUsedBps: capMinor > 0 ? Math.floor((mtdSpendMinor * 10_000) / capMinor) : 10_000,
  };
}

/**
 * Should a campaign paused by the cap in an earlier month be resumed now?
 * Only when the new month's spend is below the cap and billing is in good standing.
 */
export function shouldResumeCapPause(input: {
  pausedAt: Date;
  now: Date;
  mtdSpendMinor: number;
  capMinor: number;
  dunning: boolean;
}): boolean {
  const monthStart = periodContaining(input.now).start;
  return (
    !input.dunning &&
    input.pausedAt < monthStart &&
    evaluateBudget(input.mtdSpendMinor, input.capMinor) !== "reached"
  );
}

/** ROAS for the internal operator view (revenue ÷ spend); null when there is no spend. */
export function roas(revenueMinor: number, spendMinor: number): number | null {
  return spendMinor > 0 ? revenueMinor / spendMinor : null;
}
