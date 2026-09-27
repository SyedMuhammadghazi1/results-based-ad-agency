import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  adSpendDaily,
  billingPeriods,
  campaigns,
  conversionAdjustments,
  conversions,
  type Organization,
} from "@/db/schema";
import { computeStatement } from "@/lib/billing";
import { addDays, dateRange, isoDate, periodContaining, startOfUtcDay } from "@/lib/dates";
import { fillDailySeries } from "@/lib/reporting";

/*
 * Revenue queries. "Attributed revenue" is always NET: attributed conversions minus refund
 * adjustments of attributed conversions, bucketed by when each event happened (UTC).
 * Every function takes an org id that the caller has already authorised.
 */

const dayExpr = (col: unknown) => sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD')`;

export async function netAttributedRevenue(orgId: string, from: Date, to: Date): Promise<number> {
  const [c] = await db
    .select({ total: sql<string>`coalesce(sum(${conversions.amountMinor}), 0)` })
    .from(conversions)
    .where(
      and(
        eq(conversions.orgId, orgId),
        eq(conversions.attributed, true),
        gte(conversions.occurredAt, from),
        lt(conversions.occurredAt, to),
      ),
    );
  const [a] = await db
    .select({ total: sql<string>`coalesce(sum(${conversionAdjustments.amountMinor}), 0)` })
    .from(conversionAdjustments)
    .innerJoin(conversions, eq(conversionAdjustments.conversionId, conversions.id))
    .where(
      and(
        eq(conversionAdjustments.orgId, orgId),
        eq(conversions.attributed, true),
        gte(conversionAdjustments.occurredAt, from),
        lt(conversionAdjustments.occurredAt, to),
      ),
    );
  return Number(c?.total ?? 0) + Number(a?.total ?? 0);
}

export async function dailyNetRevenue(orgId: string, from: Date, to: Date) {
  const convDay = dayExpr(conversions.occurredAt);
  const conv = await db
    .select({ date: convDay, total: sql<string>`sum(${conversions.amountMinor})` })
    .from(conversions)
    .where(
      and(
        eq(conversions.orgId, orgId),
        eq(conversions.attributed, true),
        gte(conversions.occurredAt, from),
        lt(conversions.occurredAt, to),
      ),
    )
    .groupBy(convDay);
  const adjDay = dayExpr(conversionAdjustments.occurredAt);
  const adj = await db
    .select({ date: adjDay, total: sql<string>`sum(${conversionAdjustments.amountMinor})` })
    .from(conversionAdjustments)
    .innerJoin(conversions, eq(conversionAdjustments.conversionId, conversions.id))
    .where(
      and(
        eq(conversionAdjustments.orgId, orgId),
        eq(conversions.attributed, true),
        gte(conversionAdjustments.occurredAt, from),
        lt(conversionAdjustments.occurredAt, to),
      ),
    )
    .groupBy(adjDay);
  const byDate = new Map<string, number>();
  for (const r of [...conv, ...adj])
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + Number(r.total));
  return [...byDate.entries()].map(([date, amountMinor]) => ({ date, amountMinor }));
}

export async function latestCreditBalance(orgId: string): Promise<number> {
  const rows = await db
    .select({ carry: billingPeriods.creditCarriedOutMinor })
    .from(billingPeriods)
    .where(eq(billingPeriods.orgId, orgId))
    .orderBy(desc(billingPeriods.periodStart))
    .limit(1);
  return rows[0]?.carry ?? 0;
}

/** Fee accrued on this month's attributed revenue (what next month's invoice will be based on). */
export async function feeAccruedThisMonth(org: Organization, now: Date) {
  const month = periodContaining(now);
  const convRows = await db
    .select({
      id: conversions.id,
      amountMinor: conversions.amountMinor,
      currency: conversions.currency,
      feeRateBps: conversions.feeRateBps,
    })
    .from(conversions)
    .where(
      and(
        eq(conversions.orgId, org.id),
        eq(conversions.attributed, true),
        sql`${conversions.billingPeriodId} is null`,
        gte(conversions.occurredAt, month.start),
        lt(conversions.occurredAt, month.end),
      ),
    );
  const ids = new Set(convRows.map((c) => c.id));
  const adjRows = await db
    .select({
      id: conversionAdjustments.id,
      conversionId: conversionAdjustments.conversionId,
      amountMinor: conversionAdjustments.amountMinor,
      currency: conversionAdjustments.currency,
      feeRateBps: conversions.feeRateBps,
      billed: sql<boolean>`${conversions.billingPeriodId} is not null`,
    })
    .from(conversionAdjustments)
    .innerJoin(conversions, eq(conversionAdjustments.conversionId, conversions.id))
    .where(
      and(
        eq(conversionAdjustments.orgId, org.id),
        eq(conversions.attributed, true),
        sql`${conversionAdjustments.billingPeriodId} is null`,
        gte(conversionAdjustments.occurredAt, month.start),
        lt(conversionAdjustments.occurredAt, month.end),
      ),
    );
  return computeStatement({
    currency: org.currency,
    conversions: convRows.map((c) => ({ ...c, feeRateBps: c.feeRateBps ?? 0 })),
    adjustments: adjRows
      .filter((a) => a.billed || ids.has(a.conversionId))
      .map((a) => ({
        id: a.id,
        conversionId: a.conversionId,
        amountMinor: a.amountMinor,
        currency: a.currency,
        feeRateBps: a.feeRateBps ?? 0,
        conversionBilledEarlier: a.billed,
      })),
    creditCarriedInMinor: await latestCreditBalance(org.id),
  });
}

export type ClientSummary = {
  currency: string;
  monthKey: string;
  revenueThisMonthMinor: number;
  attributedOrdersThisMonth: number;
  feeAccruedThisMonthMinor: number;
  creditBalanceMinor: number;
  feeRateBps: number | null;
  last30Days: Array<{ date: string; amountMinor: number }>;
  last30DaysTotalMinor: number;
};

/** The client dashboard: revenue only. No spend, impressions, clicks, CTR, CPC or ROAS. */
export async function clientSummary(
  org: Organization,
  now = new Date(),
  feeRateBps: number | null = null,
): Promise<ClientSummary> {
  const month = periodContaining(now);
  const since = addDays(startOfUtcDay(now), -29);
  const until = addDays(startOfUtcDay(now), 1);
  const [revenueThisMonthMinor, orders, daily, fee] = await Promise.all([
    netAttributedRevenue(org.id, month.start, month.end),
    db
      .select({ n: count() })
      .from(conversions)
      .where(
        and(
          eq(conversions.orgId, org.id),
          eq(conversions.attributed, true),
          gte(conversions.occurredAt, month.start),
          lt(conversions.occurredAt, month.end),
        ),
      ),
    dailyNetRevenue(org.id, since, until),
    feeAccruedThisMonth(org, now),
  ]);
  const last30Days = fillDailySeries(daily, dateRange(since, startOfUtcDay(now)));
  return {
    currency: org.currency,
    monthKey: month.key,
    revenueThisMonthMinor,
    attributedOrdersThisMonth: Number(orders[0]?.n ?? 0),
    feeAccruedThisMonthMinor: fee.grossFeeMinor,
    creditBalanceMinor: fee.creditCarriedInMinor + fee.creditGeneratedMinor,
    feeRateBps,
    last30Days,
    last30DaysTotalMinor: last30Days.reduce((s, d) => s + d.amountMinor, 0),
  };
}

export type AttributedOrder = {
  id: string;
  occurredAt: Date;
  externalOrderId: string;
  source: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  campaignName: string | null;
  platform: string | null;
};

export async function attributedOrders(
  orgId: string,
  opts: { limit?: number; offset?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select({
      id: conversions.id,
      occurredAt: conversions.occurredAt,
      externalOrderId: conversions.externalOrderId,
      source: conversions.source,
      amountMinor: conversions.amountMinor,
      refundedMinor: conversions.refundedMinor,
      currency: conversions.currency,
      campaignName: campaigns.name,
      platform: conversions.platform,
    })
    .from(conversions)
    .leftJoin(campaigns, eq(conversions.campaignId, campaigns.id))
    .where(and(eq(conversions.orgId, orgId), eq(conversions.attributed, true)))
    .orderBy(desc(conversions.occurredAt), desc(conversions.id))
    .limit(limit + 1)
    .offset(offset);
  return { rows: rows.slice(0, limit) as AttributedOrder[], hasMore: rows.length > limit };
}

export async function listBillingPeriods(orgId: string) {
  return db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.orgId, orgId))
    .orderBy(desc(billingPeriods.periodStart));
}

/** IDOR-safe lookup: returns null unless the invoice belongs to `orgId`. */
export async function getBillingPeriodForOrg(orgId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db
    .select()
    .from(billingPeriods)
    .where(and(eq(billingPeriods.id, id), eq(billingPeriods.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Internal (operator-only) performance
// ---------------------------------------------------------------------------

export async function spendBetween(orgId: string, fromDate: string, toDateExclusive: string) {
  const [r] = await db
    .select({ total: sql<string>`coalesce(sum(${adSpendDaily.spendMinor}), 0)` })
    .from(adSpendDaily)
    .where(
      and(
        eq(adSpendDaily.orgId, orgId),
        gte(adSpendDaily.date, fromDate),
        lt(adSpendDaily.date, toDateExclusive),
      ),
    );
  return Number(r?.total ?? 0);
}

export async function dailySpend(orgId: string, fromDate: string, toDateExclusive: string) {
  const rows = await db
    .select({ date: adSpendDaily.date, total: sql<string>`sum(${adSpendDaily.spendMinor})` })
    .from(adSpendDaily)
    .where(
      and(
        eq(adSpendDaily.orgId, orgId),
        gte(adSpendDaily.date, fromDate),
        lt(adSpendDaily.date, toDateExclusive),
      ),
    )
    .groupBy(adSpendDaily.date);
  return rows.map((r) => ({ date: r.date, amountMinor: Number(r.total) }));
}

export async function campaignPerformance(orgId: string, from: Date, to: Date) {
  const spend = await db
    .select({
      campaignId: adSpendDaily.campaignId,
      total: sql<string>`sum(${adSpendDaily.spendMinor})`,
    })
    .from(adSpendDaily)
    .where(
      and(
        eq(adSpendDaily.orgId, orgId),
        gte(adSpendDaily.date, isoDate(from)),
        lt(adSpendDaily.date, isoDate(to)),
      ),
    )
    .groupBy(adSpendDaily.campaignId);
  const revenue = await db
    .select({
      campaignId: conversions.campaignId,
      total: sql<string>`sum(${conversions.amountMinor} - ${conversions.refundedMinor})`,
      orders: count(),
    })
    .from(conversions)
    .where(
      and(
        eq(conversions.orgId, orgId),
        eq(conversions.attributed, true),
        gte(conversions.occurredAt, from),
        lt(conversions.occurredAt, to),
      ),
    )
    .groupBy(conversions.campaignId);
  return {
    spend: new Map(spend.map((s) => [s.campaignId, Number(s.total)])),
    revenue: new Map(
      revenue.map((r) => [
        r.campaignId,
        { amountMinor: Number(r.total), orders: Number(r.orders) },
      ]),
    ),
  };
}
