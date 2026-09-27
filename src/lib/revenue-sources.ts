import { z } from "zod";
import { MoneyParseError, normalizeCurrency, parseDecimalToMinor } from "./money";

/**
 * Normalises the three revenue sources (server-to-server API, Shopify webhooks, the client's own
 * Stripe webhooks) into one shape. Revenue is measured EXCLUDING sales tax / VAT everywhere.
 */

export type NormalizedConversion = {
  kind: "conversion";
  externalOrderId: string;
  occurredAt: Date;
  amountMinor: number;
  currency: string;
  visitorId: string | null;
};

export type NormalizedRefund = {
  kind: "refund";
  externalOrderId: string;
  externalRefundId: string;
  occurredAt: Date;
  /** Positive amount of revenue refunded by THIS refund. */
  amountMinor: number;
  currency: string;
};

/** Stripe reports the cumulative refunded amount on a charge; the service turns it into a delta. */
export type NormalizedCumulativeRefund = {
  kind: "refund_cumulative";
  externalOrderId: string;
  externalRefundId: string;
  occurredAt: Date;
  cumulativeRefundedMinor: number;
  currency: string;
};

export type Ignored = { kind: "ignored"; reason: string };

export type RevenueEvent =
  NormalizedConversion | NormalizedRefund | NormalizedCumulativeRefund | Ignored;

const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;

function cleanVisitorId(v: unknown): string | null {
  return typeof v === "string" && VISITOR_ID.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Server-to-server API
// ---------------------------------------------------------------------------

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const orderId = z.string().trim().min(1).max(200);
const amountFields = {
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
};

export const s2sEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("conversion"),
    order_id: orderId,
    occurred_at: isoDate,
    visitor_id: z.string().regex(VISITOR_ID).nullish(),
    ...amountFields,
  }),
  z.object({
    type: z.literal("refund"),
    order_id: orderId,
    refund_id: z.string().trim().min(1).max(200),
    occurred_at: isoDate,
    ...amountFields,
  }),
]);

export type S2sEvent = z.infer<typeof s2sEventSchema>;

export function normalizeS2sEvent(e: S2sEvent): NormalizedConversion | NormalizedRefund {
  const currency = normalizeCurrency(e.currency);
  let amountMinor: number;
  if (e.amount_minor !== undefined) amountMinor = e.amount_minor;
  else if (e.amount !== undefined) amountMinor = parseDecimalToMinor(e.amount, currency);
  else throw new MoneyParseError("amount_minor or amount is required");
  if (amountMinor <= 0) throw new MoneyParseError("amount must be positive");

  if (e.type === "conversion") {
    return {
      kind: "conversion",
      externalOrderId: e.order_id,
      occurredAt: e.occurred_at,
      amountMinor,
      currency,
      visitorId: e.visitor_id ?? null,
    };
  }
  return {
    kind: "refund",
    externalOrderId: e.order_id,
    externalRefundId: e.refund_id,
    occurredAt: e.occurred_at,
    amountMinor,
    currency,
  };
}

// ---------------------------------------------------------------------------
// Shopify (orders/paid, refunds/create)
// ---------------------------------------------------------------------------

const money = z.union([z.string(), z.number()]).transform((v) => String(v));

const shopifyOrderSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  currency: z.string(),
  total_price: money,
  total_tax: money.optional(),
  processed_at: z.string().nullish(),
  created_at: z.string().nullish(),
  test: z.boolean().optional(),
  note_attributes: z
    .array(z.object({ name: z.string(), value: z.unknown() }))
    .nullish()
    .transform((v) => v ?? []),
});

const shopifyRefundSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  order_id: z.union([z.number(), z.string()]).transform(String),
  created_at: z.string().nullish(),
  processed_at: z.string().nullish(),
  transactions: z
    .array(
      z.object({
        kind: z.string(),
        status: z.string(),
        amount: money,
        currency: z.string().optional(),
      }),
    )
    .default([]),
  refund_line_items: z.array(z.object({ total_tax: money.optional() })).default([]),
  order_adjustments: z.array(z.object({ tax_amount: money.optional() })).default([]),
});

function parseDate(...values: Array<string | null | undefined>): Date {
  for (const v of values) {
    if (!v) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function absMinor(value: string, currency: string): number {
  return Math.abs(parseDecimalToMinor(value, currency));
}

export function normalizeShopifyWebhook(topic: string, body: unknown): RevenueEvent {
  if (topic === "orders/paid") {
    const order = shopifyOrderSchema.parse(body);
    if (order.test) return { kind: "ignored", reason: "test_order" };
    const currency = normalizeCurrency(order.currency);
    const total = parseDecimalToMinor(order.total_price, currency);
    const tax = order.total_tax ? parseDecimalToMinor(order.total_tax, currency) : 0;
    const amountMinor = total - tax;
    if (amountMinor <= 0) return { kind: "ignored", reason: "zero_value_order" };
    const vid = order.note_attributes.find((a) => a.name === "oa_vid")?.value;
    return {
      kind: "conversion",
      externalOrderId: order.id,
      occurredAt: parseDate(order.processed_at, order.created_at),
      amountMinor,
      currency,
      visitorId: cleanVisitorId(vid),
    };
  }
  if (topic === "refunds/create") {
    const refund = shopifyRefundSchema.parse(body);
    const successful = refund.transactions.filter(
      (t) => t.kind === "refund" && t.status === "success",
    );
    // Restock-only refunds have no transactions (and pending ones no successful one): no money
    // was returned. Acknowledge them — a thrown error makes Shopify retry and eventually remove
    // the webhook subscription.
    if (successful.length === 0) return { kind: "ignored", reason: "no_refunded_revenue" };
    const currency = normalizeCurrency(successful[0]!.currency ?? "");
    const paid = successful.reduce((s, t) => s + absMinor(t.amount, currency), 0);
    const tax =
      refund.refund_line_items.reduce(
        (s, li) => s + (li.total_tax ? absMinor(li.total_tax, currency) : 0),
        0,
      ) +
      refund.order_adjustments.reduce(
        (s, a) => s + (a.tax_amount ? absMinor(a.tax_amount, currency) : 0),
        0,
      );
    const amountMinor = paid - Math.min(tax, paid);
    if (amountMinor <= 0) return { kind: "ignored", reason: "no_refunded_revenue" };
    return {
      kind: "refund",
      externalOrderId: refund.order_id,
      externalRefundId: refund.id,
      occurredAt: parseDate(refund.processed_at, refund.created_at),
      amountMinor,
      currency,
    };
  }
  return { kind: "ignored", reason: `unsupported_topic:${topic}` };
}

// ---------------------------------------------------------------------------
// Client's own Stripe account (checkout.session.completed, charge.refunded)
// ---------------------------------------------------------------------------

const stripeSessionSchema = z.object({
  id: z.string(),
  mode: z.string(),
  payment_status: z.string(),
  amount_total: z.number().int().nullable(),
  currency: z.string().nullable(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  client_reference_id: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  total_details: z.object({ amount_tax: z.number().int().nullish() }).nullish(),
});

const stripeChargeSchema = z.object({
  id: z.string(),
  amount_refunded: z.number().int(),
  currency: z.string(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
});

type StripeLikeEvent = {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data: { object: unknown };
};

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

export function normalizeClientStripeEvent(event: StripeLikeEvent): RevenueEvent {
  // Test-mode payments are not revenue (same rule as Shopify test orders): never bill a fee on them.
  if (event.livemode === false) return { kind: "ignored", reason: "test_mode" };
  const occurredAt = new Date(event.created * 1000);
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const s = stripeSessionSchema.parse(event.data.object);
    if (s.mode === "setup") return { kind: "ignored", reason: "setup_session" };
    if (s.payment_status !== "paid") return { kind: "ignored", reason: "not_paid_yet" };
    if (s.amount_total === null || !s.currency) return { kind: "ignored", reason: "no_amount" };
    const amountMinor = s.amount_total - (s.total_details?.amount_tax ?? 0);
    if (amountMinor <= 0) return { kind: "ignored", reason: "zero_value_order" };
    const visitor =
      cleanVisitorId(s.metadata?.oa_vid) ?? cleanVisitorId(s.client_reference_id ?? undefined);
    return {
      kind: "conversion",
      externalOrderId: idOf(s.payment_intent) ?? s.id,
      occurredAt,
      amountMinor,
      currency: normalizeCurrency(s.currency),
      visitorId: visitor,
    };
  }
  if (event.type === "charge.refunded") {
    const c = stripeChargeSchema.parse(event.data.object);
    return {
      kind: "refund_cumulative",
      externalOrderId: idOf(c.payment_intent) ?? c.id,
      externalRefundId: `${c.id}:${c.amount_refunded}`,
      occurredAt,
      cumulativeRefundedMinor: c.amount_refunded,
      currency: normalizeCurrency(c.currency),
    };
  }
  return { kind: "ignored", reason: `unsupported_event:${event.type}` };
}
