import { parsePeriodKey, previousPeriod } from "@/lib/dates";
import { billableOrgs, billOrgForPeriod, type BillOutcome } from "@/server/billing";
import { logger } from "@/server/logger";
import { getStripe, stripeConfigured, type StripeClient } from "@/server/stripe";

/**
 * 1st of each month (UTC): one statement per client for the previous calendar month
 * [YYYY-MM-01T00:00Z, next month 01T00:00Z). Safe to re-run: a second run finds the existing
 * statement and only resumes an invoice that failed to reach Stripe.
 */
export async function runMonthlyBilling(
  opts: { now?: Date; period?: string; stripe?: StripeClient | null } = {},
) {
  const now = opts.now ?? new Date();
  const period = opts.period ? parsePeriodKey(opts.period) : previousPeriod(now);
  const stripe = opts.stripe !== undefined ? opts.stripe : stripeConfigured() ? getStripe() : null;
  if (!stripe)
    logger.warn(
      "monthly-billing: Stripe is not configured; statements are created without invoices",
    );

  const orgs = await billableOrgs(period);
  const counts: Record<BillOutcome["status"] | "failed", number> = {
    created: 0,
    no_charge: 0,
    exists: 0,
    failed: 0,
  };
  let invoiced = 0;
  for (const org of orgs) {
    try {
      const res = await billOrgForPeriod(org, period, stripe, now);
      counts[res.status]++;
      if (res.status === "created" && res.invoiced) invoiced++;
    } catch (err) {
      counts.failed++;
      logger.error({ err, orgId: org.id, period: period.key }, "monthly-billing failed for org");
    }
  }
  return { period: period.key, orgs: orgs.length, ...counts, invoiced };
}
