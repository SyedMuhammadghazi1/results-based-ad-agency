import { sha256Hex } from "./crypto";
import { formatBps } from "./money";

/**
 * Performance agreement template. Bump AGREEMENT_VERSION whenever the wording changes; existing
 * acceptances keep their own rendered text + hash, so what each client accepted is provable.
 *
 * NOTE: this wording is a product template, not legal advice. It must be reviewed by counsel in
 * every jurisdiction you sell into before real customers accept it (see docs/LAUNCH_CHECKLIST.md).
 */
export const AGREEMENT_VERSION = "2026-09-01";

export type AgreementTerms = {
  appName: string;
  orgName: string;
  feeRateBps: number;
  attributionWindowDays: number;
  currency: string;
  dunningGraceDays: number;
};

export function billingTermsSummary(t: Pick<AgreementTerms, "dunningGraceDays">): string {
  return `Billed monthly in arrears on the 1st (UTC calendar months), charged automatically to the payment method on file; campaigns pause if an invoice is unpaid ${t.dunningGraceDays} days after issue.`;
}

export function renderAgreement(t: AgreementTerms): string {
  const rate = formatBps(t.feeRateBps);
  return [
    `${t.appName} Performance Agreement — version ${AGREEMENT_VERSION}`,
    ``,
    `Between ${t.appName} ("we", "us") and ${t.orgName} ("you").`,
    ``,
    `1. Services. We build, launch and operate paid advertising campaigns for you on the ad platforms we agree on. There is no retainer, no minimum term, no minimum fee and no mandatory strategy meetings.`,
    ``,
    `2. Ad spend. You pay the ad platforms directly for media, on ad accounts you own. We never mark up media. We will not let month-to-date spend exceed the monthly spend cap you set; when it is reached we pause your campaigns until the next calendar month or until you raise the cap.`,
    ``,
    `3. Performance fee. You pay ${rate} of Attributed Revenue. We report only one number to you: Attributed Revenue.`,
    ``,
    `4. Attributed Revenue. An order counts as Attributed Revenue only if the buyer's most recent click on an ad we operate for you — identified by our campaign identifier (oa_cid) or a paid-click identifier from an ad account we manage — happened within ${t.attributionWindowDays} days before the order. Organic, direct, email and other unpaid traffic is never attributed. Amounts are measured in ${t.currency}, excluding sales tax and VAT, as reported by your connected revenue source (your store, payment processor or server-to-server feed).`,
    ``,
    `5. Refunds. Refunds reduce Attributed Revenue. If an order was already billed, the fee on the refunded amount becomes a credit applied to future invoices. We never issue negative invoices; unused credit is refunded on termination.`,
    ``,
    `6. Billing. ${billingTermsSummary(t)} Fees are calculated as round-half-up(Attributed Revenue × ${t.feeRateBps} / 10000) in minor currency units. A month with no fee due produces no invoice.`,
    ``,
    `7. Auditability. You can see every attributed order (date, order id, amount, campaign) in your dashboard. Disputes must be raised within 60 days of an invoice.`,
    ``,
    `8. Tracking. You will keep our first-party tracking script installed and your revenue source connected. Revenue that cannot be tracked because tracking was removed is not billed — and is not reported.`,
    ``,
    `9. Termination. Either party may end this agreement at any time with written notice. Fees remain due for Attributed Revenue from clicks that happened before termination, within the attribution window.`,
    ``,
    `10. Changes. We can only change the fee rate or attribution window through a new agreement version that you accept.`,
  ].join("\n");
}

export function hashAgreement(rendered: string): string {
  return sha256Hex(rendered);
}
