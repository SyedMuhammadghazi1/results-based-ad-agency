import { describe, expect, it } from "vitest";
import {
  BillingInputError,
  computeStatement,
  CurrencyMismatchError,
  describeStatement,
  type StatementAdjustment,
  type StatementConversion,
} from "@/lib/billing";
import { applyRateBps } from "@/lib/money";

const conv = (id: string, amountMinor: number, feeRateBps = 1000, currency = "USD"): StatementConversion => ({
  id,
  amountMinor,
  currency,
  feeRateBps,
});

const refund = (
  id: string,
  conversionId: string,
  amountMinor: number,
  conversionBilledEarlier: boolean,
  feeRateBps = 1000,
  currency = "USD",
): StatementAdjustment => ({ id, conversionId, amountMinor, currency, feeRateBps, conversionBilledEarlier });

const statement = (
  conversions: StatementConversion[],
  adjustments: StatementAdjustment[] = [],
  creditCarriedInMinor = 0,
) => computeStatement({ currency: "USD", conversions, adjustments, creditCarriedInMinor });

describe("fee rounding (round-half-up of revenue × rateBps / 10000)", () => {
  it.each([
    [10_000, 1000, 1_000], // $100.00 at 10% → $10.00
    [5, 1000, 1], // 0.5 cent rounds up
    [4, 1000, 0], // 0.4 cent rounds down
    [15, 1000, 2], // 1.5 → 2
    [14, 1000, 1], // 1.4 → 1
    [12_345, 1000, 1_235], // 1234.5 → 1235
    [12_344, 1000, 1_234], // 1234.4 → 1234
    [1, 5000, 1], // 0.5 → 1
    [3, 3333, 1], // 0.9999 → 1
    [0, 1000, 0],
    [999_999_999_999, 1000, 100_000_000_000], // large values stay exact (BigInt)
    [10_000, 10_000, 10_000], // 100%
    [10_000, 1, 1], // 0.01% of $100 = 1 cent
  ])("revenue %i at %i bps → fee %i", (revenue, bps, fee) => {
    expect(applyRateBps(revenue, bps)).toBe(fee);
    expect(statement(revenue > 0 ? [conv("c", revenue, bps)] : []).grossFeeMinor).toBe(fee);
  });

  it("rounds on the aggregate, not per order", () => {
    // Three $0.05 orders at 10%: per-order rounding would give 1+1+1=3; aggregate 15 × 10% = 1.5 → 2.
    const s = statement([conv("a", 5), conv("b", 5), conv("c", 5)]);
    expect(s.grossFeeMinor).toBe(2);
  });

  it("rejects fractional amounts and rates outside 0..10000", () => {
    expect(() => applyRateBps(1.5, 1000)).toThrow(RangeError);
    expect(() => applyRateBps(100, 10_001)).toThrow(RangeError);
    expect(() => statement([conv("a", 100, 20_000)])).toThrow(BillingInputError);
  });
});

describe("computeStatement", () => {
  it("zero revenue → zero fee → no invoice", () => {
    const s = statement([]);
    expect(s).toMatchObject({
      grossRevenueMinor: 0,
      netRevenueMinor: 0,
      grossFeeMinor: 0,
      amountDueMinor: 0,
      shouldInvoice: false,
      feeLines: [],
    });
  });

  it("bills 10% of attributed revenue", () => {
    const s = statement([conv("a", 250_000), conv("b", 50_000)]);
    expect(s).toMatchObject({
      grossRevenueMinor: 300_000,
      netRevenueMinor: 300_000,
      grossFeeMinor: 30_000,
      amountDueMinor: 30_000,
      shouldInvoice: true,
      conversionIds: ["a", "b"],
    });
  });

  it("nets a same-period partial refund against revenue", () => {
    const s = statement([conv("a", 100_000)], [refund("r1", "a", -40_000, false)]);
    expect(s.grossRevenueMinor).toBe(100_000);
    expect(s.netRevenueMinor).toBe(60_000);
    expect(s.grossFeeMinor).toBe(6_000);
    expect(s.creditGeneratedMinor).toBe(0);
    expect(s.adjustmentIds).toEqual(["r1"]);
  });

  it("a same-period full refund leaves nothing to bill", () => {
    const s = statement([conv("a", 100_000)], [refund("r1", "a", -100_000, false)]);
    expect(s.netRevenueMinor).toBe(0);
    expect(s.amountDueMinor).toBe(0);
    expect(s.shouldInvoice).toBe(false);
  });

  it("rejects same-period refunds larger than the order", () => {
    expect(() =>
      statement([conv("a", 1_000)], [refund("r1", "a", -600, false), refund("r2", "a", -600, false)]),
    ).toThrow(BillingInputError);
  });

  it("turns a refund of revenue billed earlier into a credit that reduces this invoice", () => {
    // Earlier month billed $1,000 → $100 fee. Now $500 of it is refunded → $50 credit.
    const s = statement([conv("new", 200_000)], [refund("r-old", "old", -50_000, true)]);
    expect(s.netRevenueMinor).toBe(200_000); // this period's revenue is not reduced
    expect(s.grossFeeMinor).toBe(20_000);
    expect(s.creditGeneratedMinor).toBe(5_000);
    expect(s.creditAppliedMinor).toBe(5_000);
    expect(s.amountDueMinor).toBe(15_000);
    expect(s.creditCarriedOutMinor).toBe(0);
  });

  it("never produces a negative invoice: excess credit carries forward", () => {
    const s = statement([conv("new", 10_000)], [refund("r-old", "old", -80_000, true)]);
    expect(s.grossFeeMinor).toBe(1_000);
    expect(s.creditGeneratedMinor).toBe(8_000);
    expect(s.creditAppliedMinor).toBe(1_000);
    expect(s.amountDueMinor).toBe(0);
    expect(s.shouldInvoice).toBe(false);
    expect(s.creditCarriedOutMinor).toBe(7_000);
  });

  it("applies carried-in credit across periods until it is used up", () => {
    // Month 1: refund credit 7,000 carried out (see above). Month 2: fee 3,000 → 0 due, 4,000 left.
    const m2 = statement([conv("m2", 30_000)], [], 7_000);
    expect(m2).toMatchObject({ grossFeeMinor: 3_000, creditAppliedMinor: 3_000, amountDueMinor: 0, creditCarriedOutMinor: 4_000 });
    // Month 3: fee 10,000 → 4,000 credit applied, 6,000 due, nothing carried.
    const m3 = statement([conv("m3", 100_000)], [], m2.creditCarriedOutMinor);
    expect(m3).toMatchObject({ grossFeeMinor: 10_000, creditAppliedMinor: 4_000, amountDueMinor: 6_000, creditCarriedOutMinor: 0 });
  });

  it("a month with only credits and no revenue carries the credit forward", () => {
    const s = statement([], [refund("r", "old", -25_000, true)], 500);
    expect(s).toMatchObject({ grossFeeMinor: 0, creditGeneratedMinor: 2_500, amountDueMinor: 0, creditCarriedOutMinor: 3_000 });
  });

  it("credits use the fee rate of the refunded conversion", () => {
    const s = statement([], [refund("r", "old", -10_000, true, 1500)]);
    expect(s.creditGeneratedMinor).toBe(1_500);
  });

  it("computes the fee per distinct rate when the agreement rate changed mid-period", () => {
    const s = statement([conv("a", 100_000, 1000), conv("b", 100_000, 800), conv("c", 5, 800)]);
    expect(s.feeLines).toEqual([
      { feeRateBps: 800, netRevenueMinor: 100_005, feeMinor: 8_000 },
      { feeRateBps: 1000, netRevenueMinor: 100_000, feeMinor: 10_000 },
    ]);
    expect(s.grossFeeMinor).toBe(18_000);
  });

  it("rejects conversions in another currency (single currency per org)", () => {
    expect(() => statement([conv("a", 100, 1000, "EUR")])).toThrow(CurrencyMismatchError);
  });

  it("rejects refunds in another currency", () => {
    expect(() => statement([conv("a", 1_000)], [refund("r", "a", -100, false, 1000, "GBP")])).toThrow(
      CurrencyMismatchError,
    );
  });

  it("rejects malformed inputs", () => {
    expect(() => statement([conv("a", 0)])).toThrow(BillingInputError);
    expect(() => statement([conv("a", 100), conv("a", 100)])).toThrow(/duplicate/);
    expect(() => statement([conv("a", 100)], [refund("r", "a", 50, false)])).toThrow(/negative/);
    expect(() => statement([], [refund("r", "missing", -50, false)])).toThrow(/neither on this statement/);
    expect(() => statement([], [], -1)).toThrow(BillingInputError);
  });

  it("describes the invoice line", () => {
    const s = statement([conv("new", 200_000)], [refund("r-old", "old", -50_000, true)]);
    const text = describeStatement(s, "2026-08", (n) => `$${(n / 100).toFixed(2)}`);
    expect(text).toBe("Performance fee 2026-08: 10% of $2000.00 attributed revenue, less $50.00 refund credit");
  });
});
