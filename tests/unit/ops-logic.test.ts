import { describe, expect, it } from "vitest";
import { AGREEMENT_VERSION, hashAgreement, renderAgreement } from "@/lib/agreement";
import { evaluateBudget, pacing, roas, shouldResumeCapPause } from "@/lib/budget";
import { isOverdue } from "@/lib/dunning";
import { canAccessStep, onboardingProgress } from "@/lib/onboarding";
import { describeTrend, fillDailySeries, revenueTrend } from "@/lib/reporting";

describe("budget guard logic", () => {
  it("classifies month-to-date spend against the cap", () => {
    expect(evaluateBudget(0, 100_000)).toBe("ok");
    expect(evaluateBudget(89_999, 100_000)).toBe("ok");
    expect(evaluateBudget(90_000, 100_000)).toBe("near");
    expect(evaluateBudget(99_999, 100_000)).toBe("near");
    expect(evaluateBudget(100_000, 100_000)).toBe("reached");
    expect(evaluateBudget(150_000, 100_000)).toBe("reached");
    expect(evaluateBudget(0, 0)).toBe("reached");
  });

  it("computes pacing", () => {
    // Halfway through a 30-day month with half the cap spent → on pace.
    const p = pacing(new Date("2026-09-16T00:00:00Z"), 50_000, 100_000);
    expect(p.ratio).toBeCloseTo(1, 5);
    expect(p.projectedMonthSpendMinor).toBe(100_000);
    expect(p.capUsedBps).toBe(5000);
  });

  it("resumes cap-paused campaigns only in a new month with headroom and no dunning", () => {
    const base = {
      pausedAt: new Date("2026-08-28T00:00:00Z"),
      now: new Date("2026-09-01T01:00:00Z"),
      mtdSpendMinor: 0,
      capMinor: 100_000,
      dunning: false,
    };
    expect(shouldResumeCapPause(base)).toBe(true);
    expect(shouldResumeCapPause({ ...base, pausedAt: new Date("2026-09-01T00:30:00Z") })).toBe(false);
    expect(shouldResumeCapPause({ ...base, mtdSpendMinor: 100_000 })).toBe(false);
    expect(shouldResumeCapPause({ ...base, dunning: true })).toBe(false);
  });

  it("computes ROAS (internal only)", () => {
    expect(roas(50_000, 10_000)).toBe(5);
    expect(roas(50_000, 0)).toBeNull();
  });
});

describe("dunning", () => {
  const now = new Date("2026-09-20T00:00:00Z");
  it("flags open or failed invoices older than the grace period", () => {
    expect(isOverdue({ status: "open", issuedAt: new Date("2026-09-01T00:00:00Z") }, now, 14)).toBe(true);
    expect(isOverdue({ status: "payment_failed", issuedAt: new Date("2026-09-01T00:00:00Z") }, now, 14)).toBe(true);
    expect(isOverdue({ status: "open", issuedAt: new Date("2026-09-06T00:00:00Z") }, now, 14)).toBe(false);
    expect(isOverdue({ status: "paid", issuedAt: new Date("2026-08-01T00:00:00Z") }, now, 14)).toBe(false);
    expect(isOverdue({ status: "open", issuedAt: null }, now, 14)).toBe(false);
  });
});

describe("weekly report trend", () => {
  it("computes week-over-week change", () => {
    expect(revenueTrend(12_000, 10_000)).toMatchObject({ deltaMinor: 2_000, pctChange: 20, direction: "up" });
    expect(revenueTrend(5_000, 10_000)).toMatchObject({ pctChange: -50, direction: "down" });
    expect(revenueTrend(10_000, 10_000)).toMatchObject({ pctChange: 0, direction: "flat" });
    expect(revenueTrend(1, 3)).toMatchObject({ pctChange: -66.7 });
  });

  it("handles a zero previous week", () => {
    expect(revenueTrend(5_000, 0)).toMatchObject({ pctChange: null, direction: "up" });
    expect(describeTrend(revenueTrend(5_000, 0))).toMatch(/new this week/);
    expect(describeTrend(revenueTrend(0, 0))).toBe("no change");
    expect(describeTrend(revenueTrend(12_000, 10_000))).toBe("up 20% vs the previous 7 days");
  });

  it("fills missing days with zero", () => {
    expect(fillDailySeries([{ date: "2026-09-02", amountMinor: 5 }], ["2026-09-01", "2026-09-02"])).toEqual([
      { date: "2026-09-01", amountMinor: 0 },
      { date: "2026-09-02", amountMinor: 5 },
    ]);
  });
});

describe("onboarding", () => {
  const none = { hasOrg: false, hasIntake: false, hasAgreement: false, trackingSeen: false, revenueSourceConnected: false, paymentMethodReady: false };
  it("walks the steps in order", () => {
    expect(onboardingProgress(none).next?.id).toBe("organization");
    expect(onboardingProgress({ ...none, hasOrg: true }).next?.id).toBe("intake");
    const afterAgreement = { ...none, hasOrg: true, hasIntake: true, hasAgreement: true };
    const p = onboardingProgress(afterAgreement);
    expect(p.next?.id).toBe("tracking");
    expect(p.dashboardUnlocked).toBe(true);
    expect(p.readyToLaunch).toBe(false);
    expect(onboardingProgress({ ...afterAgreement, trackingSeen: true, revenueSourceConnected: true }).next?.id).toBe("payment");
    const all = onboardingProgress({ hasOrg: true, hasIntake: true, hasAgreement: true, trackingSeen: true, revenueSourceConnected: true, paymentMethodReady: true });
    expect(all.complete && all.readyToLaunch).toBe(true);
  });

  it("guards steps", () => {
    expect(canAccessStep("agreement", { ...none, hasOrg: true })).toBe(false);
    expect(canAccessStep("agreement", { ...none, hasOrg: true, hasIntake: true })).toBe(true);
    expect(canAccessStep("payment", { ...none, hasOrg: true, hasIntake: true })).toBe(false);
  });
});

describe("agreement rendering", () => {
  const terms = { appName: "Outcome Ads", orgName: "Acme", feeRateBps: 1000, attributionWindowDays: 7, currency: "USD", dunningGraceDays: 14 };
  it("renders the commercial terms and a stable hash", () => {
    const text = renderAgreement(terms);
    expect(text).toContain(`version ${AGREEMENT_VERSION}`);
    expect(text).toContain("You pay 10% of Attributed Revenue");
    expect(text).toContain("within 7 days before the order");
    expect(text).toContain("no retainer");
    expect(hashAgreement(text)).toBe(hashAgreement(renderAgreement(terms)));
    expect(hashAgreement(text)).not.toBe(hashAgreement(renderAgreement({ ...terms, feeRateBps: 1200 })));
  });
});
