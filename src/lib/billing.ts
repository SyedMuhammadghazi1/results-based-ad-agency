import { applyRateBps } from "./money";

/**
 * Monthly performance-fee statement (pure).
 *
 * Inputs are everything that has not been billed yet up to the end of the period:
 *  - attributed conversions (positive revenue), each with the fee rate snapshotted from the
 *    agreement in force when it was attributed;
 *  - refund adjustments (negative revenue) of attributed conversions.
 *
 * Rules
 *  - A refund of a conversion billed on THIS statement reduces this statement's net revenue.
 *  - A refund of a conversion billed on an EARLIER statement becomes a fee credit
 *    (round-half-up(refund × rate / 10 000)) that is carried forward and applied to future fees.
 *    Invoices are never negative.
 *  - fee = round-half-up(netRevenue × rateBps / 10 000), computed per distinct rate.
 *  - amount due = max(0, gross fee − available credit); zero due → no invoice is created.
 *  - All amounts must be in the organization's single currency; anything else is rejected.
 */

export class CurrencyMismatchError extends Error {
  constructor(expected: string, got: string) {
    super(`Currency mismatch: organization bills in ${expected} but found ${got}`);
    this.name = "CurrencyMismatchError";
  }
}

export class BillingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingInputError";
  }
}

export type StatementConversion = {
  id: string;
  amountMinor: number;
  currency: string;
  feeRateBps: number;
};

export type StatementAdjustment = {
  id: string;
  conversionId: string;
  /** Negative. */
  amountMinor: number;
  currency: string;
  feeRateBps: number;
  /** Whether the refunded conversion was invoiced on an earlier statement. */
  conversionBilledEarlier: boolean;
};

export type StatementInput = {
  currency: string;
  conversions: StatementConversion[];
  adjustments: StatementAdjustment[];
  creditCarriedInMinor: number;
};

export type StatementLine = { feeRateBps: number; netRevenueMinor: number; feeMinor: number };

export type Statement = {
  currency: string;
  grossRevenueMinor: number;
  netRevenueMinor: number;
  feeLines: StatementLine[];
  grossFeeMinor: number;
  creditGeneratedMinor: number;
  creditCarriedInMinor: number;
  creditAppliedMinor: number;
  creditCarriedOutMinor: number;
  amountDueMinor: number;
  shouldInvoice: boolean;
  conversionIds: string[];
  adjustmentIds: string[];
};

function assertInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new BillingInputError(`${what} must be an integer`);
}

export function computeStatement(input: StatementInput): Statement {
  const currency = input.currency;
  assertInt(input.creditCarriedInMinor, "creditCarriedInMinor");
  if (input.creditCarriedInMinor < 0) throw new BillingInputError("carried-in credit is negative");

  const revenueByRate = new Map<number, number>();
  const refundCreditBaseByRate = new Map<number, number>();
  const conversionsById = new Map<string, StatementConversion>();
  const refundedInStatement = new Map<string, number>();
  let grossRevenueMinor = 0;

  for (const c of input.conversions) {
    if (c.currency !== currency) throw new CurrencyMismatchError(currency, c.currency);
    assertInt(c.amountMinor, "conversion amount");
    assertInt(c.feeRateBps, "fee rate");
    if (c.amountMinor <= 0) throw new BillingInputError(`conversion ${c.id} has non-positive amount`);
    if (c.feeRateBps < 0 || c.feeRateBps > 10_000) {
      throw new BillingInputError(`conversion ${c.id} has an invalid fee rate`);
    }
    if (conversionsById.has(c.id)) throw new BillingInputError(`duplicate conversion ${c.id}`);
    conversionsById.set(c.id, c);
    grossRevenueMinor += c.amountMinor;
    revenueByRate.set(c.feeRateBps, (revenueByRate.get(c.feeRateBps) ?? 0) + c.amountMinor);
  }

  const seenAdjustments = new Set<string>();
  for (const a of input.adjustments) {
    if (a.currency !== currency) throw new CurrencyMismatchError(currency, a.currency);
    assertInt(a.amountMinor, "adjustment amount");
    if (a.amountMinor >= 0) throw new BillingInputError(`adjustment ${a.id} must be negative`);
    if (seenAdjustments.has(a.id)) throw new BillingInputError(`duplicate adjustment ${a.id}`);
    seenAdjustments.add(a.id);

    if (a.conversionBilledEarlier) {
      refundCreditBaseByRate.set(
        a.feeRateBps,
        (refundCreditBaseByRate.get(a.feeRateBps) ?? 0) - a.amountMinor,
      );
      continue;
    }
    const conv = conversionsById.get(a.conversionId);
    if (!conv) {
      throw new BillingInputError(
        `adjustment ${a.id} refers to conversion ${a.conversionId} that is neither on this statement nor billed earlier`,
      );
    }
    const refunded = (refundedInStatement.get(conv.id) ?? 0) - a.amountMinor;
    if (refunded > conv.amountMinor) {
      throw new BillingInputError(`refunds exceed the amount of conversion ${conv.id}`);
    }
    refundedInStatement.set(conv.id, refunded);
    revenueByRate.set(conv.feeRateBps, (revenueByRate.get(conv.feeRateBps) ?? 0) + a.amountMinor);
  }

  const feeLines: StatementLine[] = [...revenueByRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([feeRateBps, netRevenueMinor]) => ({
      feeRateBps,
      netRevenueMinor,
      feeMinor: applyRateBps(netRevenueMinor, feeRateBps),
    }));

  const netRevenueMinor = feeLines.reduce((s, l) => s + l.netRevenueMinor, 0);
  const grossFeeMinor = feeLines.reduce((s, l) => s + l.feeMinor, 0);
  const creditGeneratedMinor = [...refundCreditBaseByRate.entries()].reduce(
    (s, [rate, base]) => s + applyRateBps(base, rate),
    0,
  );

  const availableCredit = input.creditCarriedInMinor + creditGeneratedMinor;
  const creditAppliedMinor = Math.min(grossFeeMinor, availableCredit);
  const amountDueMinor = grossFeeMinor - creditAppliedMinor;

  return {
    currency,
    grossRevenueMinor,
    netRevenueMinor,
    feeLines,
    grossFeeMinor,
    creditGeneratedMinor,
    creditCarriedInMinor: input.creditCarriedInMinor,
    creditAppliedMinor,
    creditCarriedOutMinor: availableCredit - creditAppliedMinor,
    amountDueMinor,
    shouldInvoice: amountDueMinor > 0,
    conversionIds: input.conversions.map((c) => c.id),
    adjustmentIds: input.adjustments.map((a) => a.id),
  };
}

/** Human readable invoice line description. */
export function describeStatement(s: Statement, periodKey: string, format: (n: number) => string) {
  const rates = s.feeLines.map((l) => `${l.feeRateBps / 100}%`).join(" / ");
  const credit = s.creditAppliedMinor > 0 ? `, less ${format(s.creditAppliedMinor)} refund credit` : "";
  return `Performance fee ${periodKey}: ${rates || "0%"} of ${format(s.netRevenueMinor)} attributed revenue${credit}`;
}
