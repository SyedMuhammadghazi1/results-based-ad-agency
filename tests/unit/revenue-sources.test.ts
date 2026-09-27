import { describe, expect, it } from "vitest";
import {
  normalizeClientStripeEvent,
  normalizeS2sEvent,
  normalizeShopifyWebhook,
  s2sEventSchema,
} from "@/lib/revenue-sources";

const VID = "vid_0123456789abcdef";

describe("server-to-server events", () => {
  it("accepts integer minor units", () => {
    const e = s2sEventSchema.parse({
      type: "conversion",
      order_id: "1001",
      amount_minor: 12_345,
      currency: "usd",
      occurred_at: "2026-08-20T10:00:00Z",
      visitor_id: VID,
    });
    expect(normalizeS2sEvent(e)).toEqual({
      kind: "conversion",
      externalOrderId: "1001",
      occurredAt: new Date("2026-08-20T10:00:00Z"),
      amountMinor: 12_345,
      currency: "USD",
      visitorId: VID,
    });
  });

  it("accepts a decimal string amount", () => {
    const e = s2sEventSchema.parse({
      type: "refund",
      order_id: "1001",
      refund_id: "r-1",
      amount: "20.50",
      currency: "USD",
      occurred_at: "2026-08-21T10:00:00+02:00",
    });
    expect(normalizeS2sEvent(e)).toMatchObject({
      kind: "refund",
      amountMinor: 2_050,
      externalRefundId: "r-1",
    });
  });

  it("requires an amount and rejects bad payloads", () => {
    const e = s2sEventSchema.parse({
      type: "conversion",
      order_id: "1",
      currency: "USD",
      occurred_at: "2026-08-20T10:00:00Z",
    });
    expect(() => normalizeS2sEvent(e)).toThrow();
    expect(
      s2sEventSchema.safeParse({
        type: "conversion",
        order_id: "",
        amount_minor: 1,
        currency: "USD",
        occurred_at: "2026-08-20T10:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      s2sEventSchema.safeParse({
        type: "conversion",
        order_id: "1",
        amount_minor: -5,
        currency: "USD",
        occurred_at: "2026-08-20T10:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      s2sEventSchema.safeParse({
        type: "conversion",
        order_id: "1",
        amount_minor: 5,
        currency: "USD",
        occurred_at: "yesterday",
      }).success,
    ).toBe(false);
    expect(
      s2sEventSchema.safeParse({
        type: "conversion",
        order_id: "1",
        amount_minor: 5,
        currency: "USD",
        occurred_at: "2026-08-20T10:00:00Z",
        visitor_id: "<script>",
      }).success,
    ).toBe(false);
  });
});

describe("Shopify webhooks", () => {
  const order = {
    id: 820982911946154500,
    currency: "USD",
    total_price: "110.00",
    total_tax: "10.00",
    processed_at: "2026-08-20T10:00:00-04:00",
    note_attributes: [{ name: "oa_vid", value: VID }],
  };

  it("orders/paid → conversion excluding tax, with the visitor id from cart attributes", () => {
    expect(normalizeShopifyWebhook("orders/paid", order)).toEqual({
      kind: "conversion",
      externalOrderId: "820982911946154500",
      occurredAt: new Date("2026-08-20T14:00:00Z"),
      amountMinor: 10_000,
      currency: "USD",
      visitorId: VID,
    });
  });

  it("ignores test orders and drops invalid visitor ids", () => {
    expect(normalizeShopifyWebhook("orders/paid", { ...order, test: true })).toEqual({
      kind: "ignored",
      reason: "test_order",
    });
    expect(
      normalizeShopifyWebhook("orders/paid", {
        ...order,
        note_attributes: [{ name: "oa_vid", value: "x" }],
      }),
    ).toMatchObject({
      visitorId: null,
    });
  });

  it("refunds/create → refund of successful transactions minus refunded tax", () => {
    const refund = {
      id: 929361464,
      order_id: 820982911946154500,
      created_at: "2026-08-25T10:00:00Z",
      transactions: [
        { kind: "refund", status: "success", amount: "55.00", currency: "USD" },
        { kind: "refund", status: "failure", amount: "55.00", currency: "USD" },
      ],
      refund_line_items: [{ total_tax: "5.00" }],
    };
    expect(normalizeShopifyWebhook("refunds/create", refund)).toEqual({
      kind: "refund",
      externalOrderId: "820982911946154500",
      externalRefundId: "929361464",
      occurredAt: new Date("2026-08-25T10:00:00Z"),
      amountMinor: 5_000,
      currency: "USD",
    });
  });

  it("ignores refunds with no money returned and unknown topics", () => {
    expect(
      normalizeShopifyWebhook("refunds/create", {
        id: 1,
        order_id: 2,
        transactions: [{ kind: "refund", status: "success", amount: "0.00", currency: "USD" }],
      }),
    ).toMatchObject({ kind: "ignored" });
    expect(normalizeShopifyWebhook("orders/create", order)).toMatchObject({ kind: "ignored" });
  });

  it("ignores restock-only / pending refunds that carry no successful transaction", () => {
    // Shopify sends refunds/create with `transactions: []` when items are only restocked.
    for (const transactions of [
      [],
      [{ kind: "refund", status: "pending", amount: "10.00", currency: "USD" }],
    ]) {
      expect(
        normalizeShopifyWebhook("refunds/create", { id: 3, order_id: 4, transactions }),
      ).toEqual({ kind: "ignored", reason: "no_refunded_revenue" });
    }
  });
});

describe("client Stripe events", () => {
  const session = {
    id: "cs_test_1",
    mode: "payment",
    payment_status: "paid",
    amount_total: 11_000,
    currency: "usd",
    payment_intent: "pi_123",
    metadata: { oa_vid: VID },
    total_details: { amount_tax: 1_000 },
  };
  const event = (type: string, object: unknown) => ({
    id: "evt_1",
    type,
    created: 1_787_000_000,
    data: { object },
  });

  it("checkout.session.completed → conversion keyed by payment intent", () => {
    expect(normalizeClientStripeEvent(event("checkout.session.completed", session))).toEqual({
      kind: "conversion",
      externalOrderId: "pi_123",
      occurredAt: new Date(1_787_000_000 * 1000),
      amountMinor: 10_000,
      currency: "USD",
      visitorId: VID,
    });
  });

  it("falls back to client_reference_id for the visitor and to the session id for the order", () => {
    const res = normalizeClientStripeEvent(
      event("checkout.session.completed", {
        ...session,
        payment_intent: null,
        metadata: {},
        client_reference_id: VID,
      }),
    );
    expect(res).toMatchObject({ externalOrderId: "cs_test_1", visitorId: VID });
  });

  it("ignores unpaid and setup sessions", () => {
    expect(
      normalizeClientStripeEvent(
        event("checkout.session.completed", { ...session, payment_status: "unpaid" }),
      ),
    ).toMatchObject({ kind: "ignored" });
    expect(
      normalizeClientStripeEvent(
        event("checkout.session.completed", { ...session, mode: "setup" }),
      ),
    ).toMatchObject({ kind: "ignored" });
  });

  it("ignores test-mode events (no real money), like Shopify test orders", () => {
    for (const e of [
      event("checkout.session.completed", session),
      event("charge.refunded", { id: "ch_t", amount_refunded: 1, currency: "usd" }),
    ]) {
      expect(normalizeClientStripeEvent({ ...e, livemode: false })).toEqual({
        kind: "ignored",
        reason: "test_mode",
      });
    }
    expect(
      normalizeClientStripeEvent({
        ...event("checkout.session.completed", session),
        livemode: true,
      }),
    ).toMatchObject({ kind: "conversion" });
  });

  it("charge.refunded → cumulative refund keyed by charge + amount", () => {
    const charge = {
      id: "ch_1",
      amount: 11_000,
      amount_refunded: 2_500,
      currency: "usd",
      payment_intent: "pi_123",
    };
    expect(normalizeClientStripeEvent(event("charge.refunded", charge))).toEqual({
      kind: "refund_cumulative",
      externalOrderId: "pi_123",
      externalRefundId: "ch_1:2500",
      occurredAt: new Date(1_787_000_000 * 1000),
      cumulativeRefundedMinor: 2_500,
      chargedGrossMinor: 11_000,
      currency: "USD",
    });
  });
});
