import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST as clientStripePOST } from "@/app/api/webhooks/client-stripe/[integrationId]/route";
import { POST as shopifyPOST } from "@/app/api/webhooks/shopify/[integrationId]/route";
import { POST as touchPOST } from "@/app/api/track/touch/route";
import { db } from "@/db";
import { conversionAdjustments, conversions, integrations } from "@/db/schema";
import { hmacSha256 } from "@/lib/crypto";
import { saveClientStripe, saveShopify } from "@/server/integrations";
import { signStripePayload } from "@/server/stripe";
import { activeCampaign, createUser, onboardedOrg, params, SITE, VISITOR } from "./helpers";

const SHOPIFY_SECRET = "shpss_0123456789abcdef0123456789abcdef";
const CLIENT_STRIPE_SECRET = "whsec_clientsecret0123456789";

async function setup() {
  const owner = await createUser("client");
  const operator = await createUser("operator");
  const { org } = await onboardedOrg(owner);
  const campaign = await activeCampaign(operator, org.id);
  await touchPOST(
    new Request("http://localhost:3003/api/track/touch", {
      method: "POST",
      headers: { origin: SITE },
      body: JSON.stringify({
        pk: org.publicKey,
        vid: VISITOR,
        params: { oa_cid: campaign.trackingCode },
      }),
    }),
  );
  return { owner, org };
}

function shopify(
  integrationId: string,
  topic: string,
  body: unknown,
  opts: { secret?: string; deliveryId?: string } = {},
) {
  const raw = JSON.stringify(body);
  return shopifyPOST(
    new Request(`http://localhost:3003/api/webhooks/shopify/${integrationId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-hmac-sha256": hmacSha256(opts.secret ?? SHOPIFY_SECRET, raw, "base64"),
        "x-shopify-webhook-id": opts.deliveryId ?? crypto.randomUUID(),
      },
      body: raw,
    }),
    params({ integrationId }),
  );
}

const order = (id: number, total = "110.00", tax = "10.00") => ({
  id,
  currency: "USD",
  total_price: total,
  total_tax: tax,
  processed_at: new Date().toISOString(),
  note_attributes: [{ name: "oa_vid", value: VISITOR }],
});

describe("Shopify webhooks", () => {
  it("verifies HMAC, attributes orders/paid and dedupes redeliveries", async () => {
    const { owner, org } = await setup();
    const integration = await saveShopify(org, owner, {
      shopDomain: "acme.myshopify.com",
      webhookSecret: SHOPIFY_SECRET,
    });

    const ok = await shopify(integration.id, "orders/paid", order(5001), { deliveryId: "d-1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "recorded", attributed: true });

    // Exact redelivery (same webhook id) and a new delivery of the same order.
    expect(
      await (
        await shopify(integration.id, "orders/paid", order(5001), { deliveryId: "d-1" })
      ).json(),
    ).toEqual({
      status: "duplicate_delivery",
    });
    expect(
      await (
        await shopify(integration.id, "orders/paid", order(5001), { deliveryId: "d-2" })
      ).json(),
    ).toMatchObject({
      status: "duplicate",
    });
    const rows = await db.select().from(conversions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "shopify",
      externalOrderId: "5001",
      amountMinor: 10_000,
      attributed: true,
    });

    const [row] = await db.select().from(integrations).where(eq(integrations.id, integration.id));
    expect(row!.status).toBe("connected");
    // The secret is stored encrypted, never in plaintext.
    expect(row!.encryptedSecret).toMatch(/^enc:v1:/);
    expect(row!.encryptedSecret).not.toContain(SHOPIFY_SECRET);
  });

  it("rejects bad signatures and unknown integrations", async () => {
    const { owner, org } = await setup();
    const integration = await saveShopify(org, owner, {
      shopDomain: "acme.myshopify.com",
      webhookSecret: SHOPIFY_SECRET,
    });
    const forged = await shopify(integration.id, "orders/paid", order(1), {
      secret: "wrong-secret-0000000000",
    });
    expect(forged.status).toBe(401);
    expect(await db.select().from(conversions)).toHaveLength(0);
    expect((await shopify(crypto.randomUUID(), "orders/paid", order(1))).status).toBe(404);
    expect((await shopify("not-a-uuid", "orders/paid", order(1))).status).toBe(404);
  });

  it("records refunds/create as a negative adjustment linked to the order", async () => {
    const { owner, org } = await setup();
    const integration = await saveShopify(org, owner, {
      shopDomain: "acme.myshopify.com",
      webhookSecret: SHOPIFY_SECRET,
    });
    await shopify(integration.id, "orders/paid", order(7001));
    const refund = {
      id: 9001,
      order_id: 7001,
      created_at: new Date().toISOString(),
      transactions: [{ kind: "refund", status: "success", amount: "33.00", currency: "USD" }],
      refund_line_items: [{ total_tax: "3.00" }],
    };
    expect(await (await shopify(integration.id, "refunds/create", refund)).json()).toMatchObject({
      status: "recorded",
      amountMinor: -3_000,
    });
    const [adj] = await db.select().from(conversionAdjustments);
    const [conv] = await db.select().from(conversions);
    expect(adj).toMatchObject({
      conversionId: conv!.id,
      amountMinor: -3_000,
      externalRefundId: "9001",
    });
    expect(conv!.refundedMinor).toBe(3_000);
    // Replayed refund → no double count.
    expect(await (await shopify(integration.id, "refunds/create", refund)).json()).toMatchObject({
      status: "duplicate",
    });
  });
});

describe("client Stripe webhooks", () => {
  function stripeEvent(integrationId: string, event: unknown, secret = CLIENT_STRIPE_SECRET) {
    const raw = JSON.stringify(event);
    return clientStripePOST(
      new Request(`http://localhost:3003/api/webhooks/client-stripe/${integrationId}`, {
        method: "POST",
        headers: { "stripe-signature": signStripePayload(raw, secret) },
        body: raw,
      }),
      params({ integrationId }),
    );
  }
  // Stripe timestamps have 1s resolution; keep the order safely after the tracked click.
  const created = Math.floor(Date.now() / 1000) + 60;
  const session = (id: string) => ({
    id: `evt_${id}`,
    object: "event",
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        id: `cs_${id}`,
        mode: "payment",
        payment_status: "paid",
        amount_total: 21_600,
        currency: "usd",
        payment_intent: `pi_${id}`,
        metadata: { oa_vid: VISITOR },
        total_details: { amount_tax: 1_600 },
      },
    },
  });
  const refunded = (id: string, cumulative: number, eventId: string) => ({
    id: eventId,
    object: "event",
    type: "charge.refunded",
    created,
    data: {
      object: {
        id: `ch_${id}`,
        amount_refunded: cumulative,
        currency: "usd",
        payment_intent: `pi_${id}`,
      },
    },
  });

  it("verifies the org's signing secret, records the sale and cumulative refunds", async () => {
    const { owner, org } = await setup();
    const integration = await saveClientStripe(org, owner, { signingSecret: CLIENT_STRIPE_SECRET });

    const res = await stripeEvent(integration.id, session("1"));
    expect(await res.json()).toMatchObject({ status: "recorded", attributed: true });
    expect(await (await stripeEvent(integration.id, session("1"))).json()).toEqual({
      status: "duplicate_delivery",
    });

    expect(
      await (await stripeEvent(integration.id, refunded("1", 5_000, "evt_r1"))).json(),
    ).toMatchObject({
      status: "recorded",
      amountMinor: -5_000,
    });
    // Second partial refund: Stripe reports the cumulative total (12,000) → delta 7,000.
    expect(
      await (await stripeEvent(integration.id, refunded("1", 12_000, "evt_r2"))).json(),
    ).toMatchObject({
      amountMinor: -7_000,
    });
    const [conv] = await db.select().from(conversions);
    expect(conv).toMatchObject({
      source: "stripe",
      externalOrderId: "pi_1",
      amountMinor: 20_000,
      refundedMinor: 12_000,
    });
  });

  it("rejects events signed with another secret", async () => {
    const { owner, org } = await setup();
    const integration = await saveClientStripe(org, owner, { signingSecret: CLIENT_STRIPE_SECRET });
    const res = await stripeEvent(integration.id, session("2"), "whsec_attacker000000000");
    expect(res.status).toBe(401);
    expect(await db.select().from(conversions)).toHaveLength(0);
  });
});
