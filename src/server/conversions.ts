import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  campaigns,
  conversionAdjustments,
  conversions,
  touches,
  type ConversionSource,
  type Organization,
} from "@/db/schema";
import {
  attributeConversion,
  planRefund,
  revenueShareOfGrossRefund,
  windowStartFor,
  type AttributionResult,
} from "@/lib/attribution";
import type {
  NormalizedConversion,
  NormalizedCumulativeRefund,
  NormalizedRefund,
  RevenueEvent,
} from "@/lib/revenue-sources";
import { logger } from "./logger";
import { agreementInForce } from "./orgs";

export type ConversionOutcome =
  | { status: "recorded"; conversionId: string; attributed: boolean; reason: string }
  | { status: "duplicate"; conversionId: string }
  | { status: "rejected"; reason: "currency_mismatch" | "occurred_in_future" };

export type RefundOutcome =
  | { status: "recorded"; adjustmentId: string; conversionId: string; amountMinor: number }
  | { status: "duplicate" }
  | {
      status: "ignored";
      reason: "unknown_order" | "already_fully_refunded" | "no_new_refund" | "non_positive_refund";
    }
  | { status: "rejected"; reason: "currency_mismatch" };

export type RevenueOutcome =
  ConversionOutcome | RefundOutcome | { status: "ignored"; reason: string };

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_TOUCHES_CONSIDERED = 500;

async function attributionFor(
  org: Organization,
  ev: NormalizedConversion,
): Promise<{ result: AttributionResult; agreementId: string | null; feeRateBps: number | null }> {
  // The agreement IN FORCE when the order happened: its fee rate and window apply. Orders placed
  // before the client accepted any agreement are never billable.
  const agreement = await agreementInForce(org.id, ev.occurredAt);
  if (!agreement) {
    return {
      result: { attributed: false, reason: "no_agreement" },
      agreementId: null,
      feeRateBps: null,
    };
  }
  const base = { agreementId: agreement.id, feeRateBps: agreement.feeRateBps };
  if (!ev.visitorId) {
    return {
      result: attributeConversion({
        conversionAt: ev.occurredAt,
        visitorKnown: false,
        touches: [],
        campaigns: [],
        windowDays: agreement.attributionWindowDays,
      }),
      ...base,
    };
  }
  const since = windowStartFor(ev.occurredAt, agreement.attributionWindowDays);
  const [touchRows, campaignRows] = await Promise.all([
    db
      .select({
        id: touches.id,
        occurredAt: touches.occurredAt,
        oaCid: touches.oaCid,
        gclid: touches.gclid,
        fbclid: touches.fbclid,
        ttclid: touches.ttclid,
        utmSource: touches.utmSource,
        utmMedium: touches.utmMedium,
      })
      .from(touches)
      .where(
        and(
          eq(touches.orgId, org.id),
          eq(touches.visitorId, ev.visitorId),
          gte(touches.occurredAt, since),
          lte(touches.occurredAt, ev.occurredAt),
        ),
      )
      .orderBy(desc(touches.occurredAt))
      .limit(MAX_TOUCHES_CONSIDERED),
    db
      .select({
        id: campaigns.id,
        trackingCode: campaigns.trackingCode,
        platform: campaigns.platform,
        status: campaigns.status,
      })
      .from(campaigns)
      .where(eq(campaigns.orgId, org.id)),
  ]);
  return {
    result: attributeConversion({
      conversionAt: ev.occurredAt,
      visitorKnown: true,
      touches: touchRows,
      campaigns: campaignRows,
      windowDays: agreement.attributionWindowDays,
    }),
    ...base,
  };
}

export async function recordConversion(
  org: Organization,
  source: ConversionSource,
  ev: NormalizedConversion,
  now = new Date(),
): Promise<ConversionOutcome> {
  if (ev.currency !== org.currency) return { status: "rejected", reason: "currency_mismatch" };
  if (ev.occurredAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    return { status: "rejected", reason: "occurred_in_future" };
  }

  const existing = await findConversion(org.id, source, ev.externalOrderId);
  if (existing) return { status: "duplicate", conversionId: existing.id };

  const { result, agreementId, feeRateBps } = await attributionFor(org, ev);
  const inserted = await db
    .insert(conversions)
    .values({
      orgId: org.id,
      source,
      externalOrderId: ev.externalOrderId,
      visitorId: ev.visitorId,
      occurredAt: ev.occurredAt,
      amountMinor: ev.amountMinor,
      currency: ev.currency,
      attributed: result.attributed,
      attributionReason: result.reason,
      attributedTouchId: result.attributed ? result.touchId : null,
      campaignId: result.attributed ? result.campaignId : null,
      platform: result.attributed ? result.platform : null,
      agreementId: result.attributed ? agreementId : null,
      feeRateBps: result.attributed ? feeRateBps : null,
    })
    .onConflictDoNothing({
      target: [conversions.orgId, conversions.source, conversions.externalOrderId],
    })
    .returning({ id: conversions.id });

  if (inserted.length === 0) {
    // Lost a race with a concurrent delivery of the same order.
    const again = await findConversion(org.id, source, ev.externalOrderId);
    return { status: "duplicate", conversionId: again!.id };
  }
  logger.info(
    { orgId: org.id, source, attributed: result.attributed, reason: result.reason },
    "conversion recorded",
  );
  return {
    status: "recorded",
    conversionId: inserted[0]!.id,
    attributed: result.attributed,
    reason: result.reason,
  };
}

async function findConversion(orgId: string, source: ConversionSource, externalOrderId: string) {
  const rows = await db
    .select()
    .from(conversions)
    .where(
      and(
        eq(conversions.orgId, orgId),
        eq(conversions.source, source),
        eq(conversions.externalOrderId, externalOrderId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function recordRefund(
  org: Organization,
  source: ConversionSource,
  ev: NormalizedRefund | NormalizedCumulativeRefund,
): Promise<RefundOutcome> {
  if (ev.currency !== org.currency) return { status: "rejected", reason: "currency_mismatch" };

  return db.transaction(async (tx) => {
    const convRows = await tx
      .select()
      .from(conversions)
      .where(
        and(
          eq(conversions.orgId, org.id),
          eq(conversions.source, source),
          eq(conversions.externalOrderId, ev.externalOrderId),
        ),
      )
      .for("update")
      .limit(1);
    const conv = convRows[0];
    if (!conv) return { status: "ignored", reason: "unknown_order" } as const;

    const dup = await tx
      .select({ id: conversionAdjustments.id })
      .from(conversionAdjustments)
      .where(
        and(
          eq(conversionAdjustments.orgId, org.id),
          eq(conversionAdjustments.source, source),
          eq(conversionAdjustments.externalRefundId, ev.externalRefundId),
        ),
      )
      .limit(1);
    if (dup.length > 0) return { status: "duplicate" } as const;

    // Stripe's cumulative refund includes tax; revenue (and refundedMinor) exclude it.
    const requested =
      ev.kind === "refund"
        ? ev.amountMinor
        : revenueShareOfGrossRefund(
            ev.cumulativeRefundedMinor,
            conv.amountMinor,
            ev.chargedGrossMinor,
          ) - conv.refundedMinor;
    if (ev.kind === "refund_cumulative" && requested <= 0) {
      return { status: "ignored", reason: "no_new_refund" } as const;
    }
    const plan = planRefund(conv.amountMinor, conv.refundedMinor, requested);
    if (!plan.ok) return { status: "ignored", reason: plan.reason } as const;

    const [adj] = await tx
      .insert(conversionAdjustments)
      .values({
        orgId: org.id,
        conversionId: conv.id,
        source,
        externalRefundId: ev.externalRefundId,
        amountMinor: plan.adjustmentMinor,
        currency: ev.currency,
        occurredAt: ev.occurredAt,
      })
      .returning({ id: conversionAdjustments.id });
    await tx
      .update(conversions)
      .set({ refundedMinor: sql`${conversions.refundedMinor} + ${-plan.adjustmentMinor}` })
      .where(eq(conversions.id, conv.id));
    return {
      status: "recorded",
      adjustmentId: adj!.id,
      conversionId: conv.id,
      amountMinor: plan.adjustmentMinor,
    } as const;
  });
}

export async function processRevenueEvent(
  org: Organization,
  source: ConversionSource,
  ev: RevenueEvent,
): Promise<RevenueOutcome> {
  switch (ev.kind) {
    case "conversion":
      return recordConversion(org, source, ev);
    case "refund":
    case "refund_cumulative":
      return recordRefund(org, source, ev);
    case "ignored":
      return { status: "ignored", reason: ev.reason };
  }
}
