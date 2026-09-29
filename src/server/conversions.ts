import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  campaigns,
  conversionAdjustments,
  conversions,
  pendingRefunds,
  touches,
  type Conversion,
  type ConversionSource,
  type Organization,
  type PendingRefund,
} from "@/db/schema";
import {
  attributeConversion,
  planPendingRefunds,
  planRefundEvent,
  windowStartFor,
  type AttributionResult,
  type RefundEventInput,
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
  | {
      status: "recorded";
      conversionId: string;
      attributed: boolean;
      reason: string;
      /** Refunds that had arrived before this order and were applied to it (only when > 0). */
      pendingRefundsApplied?: number;
    }
  | { status: "duplicate"; conversionId: string }
  | { status: "rejected"; reason: "currency_mismatch" | "occurred_in_future" };

export type RefundOutcome =
  | { status: "recorded"; adjustmentId: string; conversionId: string; amountMinor: number }
  /** The order isn't recorded yet: kept and applied when it is (see `deferRefund`). */
  | { status: "pending"; pendingRefundId: string }
  | { status: "duplicate" }
  | {
      status: "ignored";
      reason: "already_fully_refunded" | "no_new_refund" | "non_positive_refund";
    }
  | { status: "rejected"; reason: "currency_mismatch" };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RevenueOutcome =
  ConversionOutcome | RefundOutcome | { status: "ignored"; reason: string };

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_TOUCHES_CONSIDERED = 500;
/** Refunds whose order hasn't arrived after this long are dropped by the cleanup job. */
export const PENDING_REFUND_TTL_DAYS = 90;

/**
 * Serializes everything that touches one order (its conversion and its refunds) until the
 * transaction ends, so a refund is either matched to the conversion or already pending when the
 * conversion looks for pending refunds — never lost between the two.
 */
async function lockOrder(tx: Tx, orgId: string, source: ConversionSource, externalOrderId: string) {
  const key = `order:${orgId}:${source}:${externalOrderId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

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

  const existing = await findConversion(db, org.id, source, ev.externalOrderId);
  if (existing) return { status: "duplicate", conversionId: existing.id };

  const { result, agreementId, feeRateBps } = await attributionFor(org, ev);
  const outcome = await db.transaction(async (tx): Promise<ConversionOutcome> => {
    await lockOrder(tx, org.id, source, ev.externalOrderId);
    const inserted = await tx
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
      .returning();

    if (inserted.length === 0) {
      // Lost a race with a concurrent delivery of the same order.
      const again = await findConversion(tx, org.id, source, ev.externalOrderId);
      return { status: "duplicate", conversionId: again!.id };
    }
    const applied = await applyPendingRefunds(tx, org, source, inserted[0]!);
    return {
      status: "recorded",
      conversionId: inserted[0]!.id,
      attributed: result.attributed,
      reason: result.reason,
      ...(applied > 0 ? { pendingRefundsApplied: applied } : {}),
    };
  });
  if (outcome.status === "recorded") {
    logger.info(
      { orgId: org.id, source, attributed: result.attributed, reason: result.reason },
      "conversion recorded",
    );
  }
  return outcome;
}

async function findConversion(
  q: Tx | typeof db,
  orgId: string,
  source: ConversionSource,
  externalOrderId: string,
) {
  const rows = await q
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

type RefundEvent = NormalizedRefund | NormalizedCumulativeRefund;

async function insertAdjustment(
  tx: Tx,
  a: {
    orgId: string;
    conversionId: string;
    source: ConversionSource;
    externalRefundId: string;
    amountMinor: number;
    currency: string;
    occurredAt: Date;
  },
): Promise<string> {
  const [adj] = await tx
    .insert(conversionAdjustments)
    .values(a)
    .returning({ id: conversionAdjustments.id });
  return adj!.id;
}

export async function recordRefund(
  org: Organization,
  source: ConversionSource,
  ev: RefundEvent,
): Promise<RefundOutcome> {
  if (ev.currency !== org.currency) return { status: "rejected", reason: "currency_mismatch" };

  return db.transaction(async (tx) => {
    await lockOrder(tx, org.id, source, ev.externalOrderId);
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
    if (!conv) return deferRefund(tx, org, source, ev);

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
    const plan = planRefundEvent(conv, ev);
    if (!plan.ok) return { status: "ignored", reason: plan.reason } as const;

    const adjustmentId = await insertAdjustment(tx, {
      orgId: org.id,
      conversionId: conv.id,
      source,
      externalRefundId: ev.externalRefundId,
      amountMinor: plan.adjustmentMinor,
      currency: ev.currency,
      occurredAt: ev.occurredAt,
    });
    await tx
      .update(conversions)
      .set({ refundedMinor: sql`${conversions.refundedMinor} + ${-plan.adjustmentMinor}` })
      .where(eq(conversions.id, conv.id));
    return {
      status: "recorded",
      adjustmentId,
      conversionId: conv.id,
      amountMinor: plan.adjustmentMinor,
    } as const;
  });
}

/**
 * The refund's order is not recorded (yet): Shopify and Stripe don't guarantee webhook order.
 * Dropping it would bill the order in full when it arrives, and failing the webhook makes Shopify
 * delete it after repeated failures — so keep it (deduped by refund id) until the order arrives.
 * It is not a revenue adjustment until then.
 */
async function deferRefund(
  tx: Tx,
  org: Organization,
  source: ConversionSource,
  ev: RefundEvent,
): Promise<RefundOutcome> {
  const amountMinor = ev.kind === "refund" ? ev.amountMinor : ev.cumulativeRefundedMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { status: "ignored", reason: "non_positive_refund" };
  }
  const [row] = await tx
    .insert(pendingRefunds)
    .values({
      orgId: org.id,
      source,
      externalOrderId: ev.externalOrderId,
      externalRefundId: ev.externalRefundId,
      kind: ev.kind,
      amountMinor,
      chargedGrossMinor: ev.kind === "refund_cumulative" ? (ev.chargedGrossMinor ?? null) : null,
      currency: ev.currency,
      occurredAt: ev.occurredAt,
    })
    .onConflictDoNothing({
      target: [pendingRefunds.orgId, pendingRefunds.source, pendingRefunds.externalRefundId],
    })
    .returning({ id: pendingRefunds.id });
  if (!row) return { status: "duplicate" };
  logger.info({ orgId: org.id, source }, "refund arrived before its order; kept as pending");
  return { status: "pending", pendingRefundId: row.id };
}

function pendingAsEvent(p: PendingRefund): RefundEventInput {
  return p.kind === "refund"
    ? { kind: "refund", externalRefundId: p.externalRefundId, amountMinor: p.amountMinor }
    : {
        kind: "refund_cumulative",
        externalRefundId: p.externalRefundId,
        cumulativeRefundedMinor: p.amountMinor,
        chargedGrossMinor: p.chargedGrossMinor,
      };
}

/**
 * Applies refunds that arrived before this (just inserted) conversion, inside its transaction and
 * with the same planning as a refund arriving afterwards (cap, Stripe tax pro-rating, one
 * adjustment per refund id). Returns how many adjustments were created.
 */
async function applyPendingRefunds(
  tx: Tx,
  org: Organization,
  source: ConversionSource,
  conv: Conversion,
): Promise<number> {
  const pending = await tx
    .select()
    .from(pendingRefunds)
    .where(
      and(
        eq(pendingRefunds.orgId, org.id),
        eq(pendingRefunds.source, source),
        eq(pendingRefunds.externalOrderId, conv.externalOrderId),
      ),
    )
    .orderBy(asc(pendingRefunds.occurredAt), asc(pendingRefunds.amountMinor))
    .for("update");
  if (pending.length === 0) return 0;

  const usable = pending.filter((p) => p.currency === conv.currency);
  const recorded = await tx
    .select({ id: conversionAdjustments.externalRefundId })
    .from(conversionAdjustments)
    .where(
      and(
        eq(conversionAdjustments.orgId, org.id),
        eq(conversionAdjustments.source, source),
        inArray(
          conversionAdjustments.externalRefundId,
          pending.map((p) => p.externalRefundId),
        ),
      ),
    );
  const plans = planPendingRefunds(
    conv,
    usable.map(pendingAsEvent),
    new Set(recorded.map((r) => r.id)),
  );
  let applied = 0;
  let refundedMinor = 0;
  for (const [i, { plan }] of plans.entries()) {
    if (!plan.ok) continue;
    const p = usable[i]!;
    await insertAdjustment(tx, {
      orgId: org.id,
      conversionId: conv.id,
      source,
      externalRefundId: p.externalRefundId,
      amountMinor: plan.adjustmentMinor,
      currency: p.currency,
      occurredAt: p.occurredAt,
    });
    applied++;
    refundedMinor -= plan.adjustmentMinor;
  }
  if (refundedMinor > 0) {
    await tx
      .update(conversions)
      .set({ refundedMinor: sql`${conversions.refundedMinor} + ${refundedMinor}` })
      .where(eq(conversions.id, conv.id));
  }
  await tx.delete(pendingRefunds).where(
    inArray(
      pendingRefunds.id,
      pending.map((p) => p.id),
    ),
  );
  logger.info(
    { orgId: org.id, source, pending: pending.length, applied },
    "applied refunds that arrived before their order",
  );
  return applied;
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
