import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST as conversionsPOST } from "@/app/api/v1/conversions/route";
import { GET as ordersGET } from "@/app/api/client/orders/route";
import { GET as summaryGET } from "@/app/api/client/summary/route";
import { OPTIONS as touchOPTIONS, POST as touchPOST } from "@/app/api/track/touch/route";
import { db } from "@/db";
import { conversions, organizations, touches } from "@/db/schema";
import {
  activeCampaign,
  createUser,
  getRequest,
  jsonRequest,
  onboardedOrg,
  SITE,
  VISITOR,
} from "./helpers";

function touch(
  pk: string,
  params: Record<string, string>,
  opts: { origin?: string; vid?: string; type?: string } = {},
) {
  return touchPOST(
    new Request("http://localhost:3003/api/track/touch", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: opts.origin ?? SITE,
        "x-forwarded-for": "198.51.100.7",
      },
      body: JSON.stringify({
        pk,
        vid: opts.vid ?? VISITOR,
        type: opts.type ?? "touch",
        url: `${SITE}/products/bag?oa_cid=x&email=secret@example.com`,
        ref: "https://www.facebook.com/",
        params,
      }),
    }),
  );
}

function conversion(apiKey: string, body: Record<string, unknown>) {
  return conversionsPOST(
    jsonRequest("/api/v1/conversions", body, { authorization: `Bearer ${apiKey}` }),
  );
}

const nowIso = () => new Date().toISOString();

describe("touch + conversion → attribution → dashboard", () => {
  it("attributes an order to the campaign whose click preceded it and shows it on the dashboard", async () => {
    const owner = await createUser("client");
    const operator = await createUser("operator");
    const { org, apiKey } = await onboardedOrg(owner);
    const campaign = await activeCampaign(operator, org.id, "meta");

    // 1. Visitor lands from our ad.
    const t = await touch(org.publicKey, { oa_cid: campaign.trackingCode, utm_source: "meta" });
    expect(t.status).toBe(201);
    expect(t.headers.get("access-control-allow-origin")).toBe(SITE);
    const [stored] = await db.select().from(touches);
    expect(stored).toMatchObject({
      oaCid: campaign.trackingCode,
      landingPath: "/products/bag",
      referrerHost: "www.facebook.com",
    });
    // Query strings (which may hold PII) are never stored.
    expect(JSON.stringify(stored)).not.toContain("secret@example.com");

    // 2. The client's backend reports the paid order.
    const res = await conversion(apiKey, {
      type: "conversion",
      order_id: "A-1001",
      amount_minor: 25_000,
      currency: "USD",
      occurred_at: nowIso(),
      visitor_id: VISITOR,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      status: "recorded",
      attributed: true,
      reason: "last_paid_touch",
    });

    // 3. Organic order (no paid touch) and an order with no visitor are NOT attributed.
    await touch(org.publicKey, { utm_source: "newsletter" }, { vid: "organic_bbbbbbbbbbbbbbbb" });
    const organic = await conversion(apiKey, {
      type: "conversion",
      order_id: "A-1002",
      amount_minor: 99_000,
      currency: "USD",
      occurred_at: nowIso(),
      visitor_id: "organic_bbbbbbbbbbbbbbbb",
    });
    expect(await organic.json()).toMatchObject({
      status: "recorded",
      attributed: false,
      reason: "no_paid_touch_in_window",
    });
    const anonymous = await conversion(apiKey, {
      type: "conversion",
      order_id: "A-1003",
      amount: "50.00",
      currency: "usd",
      occurred_at: nowIso(),
    });
    expect(await anonymous.json()).toMatchObject({ attributed: false, reason: "unknown_visitor" });

    // 4. Dashboard numbers only include the attributed order.
    const summary = await (
      await summaryGET(getRequest("/api/client/summary", owner.headers))
    ).json();
    expect(summary).toMatchObject({
      currency: "USD",
      revenueThisMonthMinor: 25_000,
      attributedOrdersThisMonth: 1,
      feeAccruedThisMonthMinor: 2_500,
      feeRateBps: 1000,
    });
    expect(summary.last30Days).toHaveLength(30);
    expect(summary.last30DaysTotalMinor).toBe(25_000);
    // Revenue-only by design: no spend / ROAS / clicks leak into the client API.
    expect(Object.keys(summary).join(",")).not.toMatch(/spend|roas|click|impression|ctr|cpc/i);

    const orders = await (await ordersGET(getRequest("/api/client/orders", owner.headers))).json();
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0]).toMatchObject({
      externalOrderId: "A-1001",
      amountMinor: 25_000,
      campaignName: campaign.name,
    });
  });

  it("dedupes conversions and records refunds as negative adjustments", async () => {
    const owner = await createUser("client");
    const operator = await createUser("operator");
    const { org, apiKey } = await onboardedOrg(owner);
    const campaign = await activeCampaign(operator, org.id);
    await touch(org.publicKey, { oa_cid: campaign.trackingCode });
    const body = {
      type: "conversion",
      order_id: "R-1",
      amount_minor: 10_000,
      currency: "USD",
      occurred_at: nowIso(),
      visitor_id: VISITOR,
    };
    expect((await conversion(apiKey, body)).status).toBe(201);
    const dup = await conversion(apiKey, { ...body, amount_minor: 99_999 });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ status: "duplicate" });
    expect(await db.select().from(conversions)).toHaveLength(1);

    const refund = (refund_id: string, amount_minor: number) =>
      conversion(apiKey, {
        type: "refund",
        order_id: "R-1",
        refund_id,
        amount_minor,
        currency: "USD",
        occurred_at: nowIso(),
      });
    expect(await (await refund("rf-1", 3_000)).json()).toMatchObject({
      status: "recorded",
      amountMinor: -3_000,
    });
    expect(await (await refund("rf-1", 3_000)).json()).toMatchObject({ status: "duplicate" });
    // Over-refund is capped at what's left.
    expect(await (await refund("rf-2", 50_000)).json()).toMatchObject({
      status: "recorded",
      amountMinor: -7_000,
    });
    expect(await (await refund("rf-3", 1)).json()).toMatchObject({
      status: "ignored",
      reason: "already_fully_refunded",
    });
    expect(await (await refund("unknown-order", 1)).json()).toBeTruthy();

    const summary = await (
      await summaryGET(getRequest("/api/client/summary", owner.headers))
    ).json();
    expect(summary.revenueThisMonthMinor).toBe(0);
    expect(summary.attributedOrdersThisMonth).toBe(1);
  });

  it("rejects bad API keys, other currencies, future dates and invalid payloads", async () => {
    const owner = await createUser("client");
    const { apiKey } = await onboardedOrg(owner);
    const base = {
      type: "conversion",
      order_id: "X-1",
      amount_minor: 100,
      currency: "USD",
      occurred_at: nowIso(),
    };
    expect((await conversionsPOST(jsonRequest("/api/v1/conversions", base))).status).toBe(401);
    expect((await conversion("oa_sk_not-a-real-key-aaaaaaaaaaaaaaaa", base)).status).toBe(401);
    expect((await conversion(apiKey, { ...base, currency: "EUR" })).status).toBe(422);
    expect(
      (
        await conversion(apiKey, {
          ...base,
          occurred_at: new Date(Date.now() + 86_400_000).toISOString(),
        })
      ).status,
    ).toBe(422);
    expect((await conversion(apiKey, { ...base, amount_minor: -1 })).status).toBe(400);
    const bad = await conversionsPOST(
      jsonRequest("/api/v1/conversions", "{not json", { authorization: `Bearer ${apiKey}` }),
    );
    expect(bad.status).toBe(400);
  });

  it("only attributes clicks inside the agreement window", async () => {
    const owner = await createUser("client");
    const operator = await createUser("operator");
    const { org, apiKey } = await onboardedOrg(owner);
    const campaign = await activeCampaign(operator, org.id);
    await touch(org.publicKey, { oa_cid: campaign.trackingCode });
    // Move the touch 8 days into the past (window is 7 days).
    await db.update(touches).set({ occurredAt: new Date(Date.now() - 8 * 86_400_000) });
    const res = await conversion(apiKey, {
      type: "conversion",
      order_id: "W-1",
      amount_minor: 5_000,
      currency: "USD",
      occurred_at: nowIso(),
      visitor_id: VISITOR,
    });
    expect(await res.json()).toMatchObject({
      attributed: false,
      reason: "no_paid_touch_in_window",
    });
  });
});

describe("tracking endpoint", () => {
  it("enforces the org's allowed origins and validates payloads", async () => {
    const owner = await createUser("client");
    const { org } = await onboardedOrg(owner);
    expect(
      (await touch(org.publicKey, { oa_cid: "x" }, { origin: "https://evil.test" })).status,
    ).toBe(403);
    expect((await touch("oa_pk_doesnotexist00", { oa_cid: "x" })).status).toBe(404);
    const invalid = await touchPOST(
      new Request("http://localhost:3003/api/track/touch", {
        method: "POST",
        headers: { origin: SITE },
        body: '{"pk":1}',
      }),
    );
    expect(invalid.status).toBe(400);
    expect((await touch(org.publicKey, {})).status).toBe(200); // nothing to record
    expect(await db.select().from(touches)).toHaveLength(0);
  });

  it("marks tracking as installed on a ping", async () => {
    const owner = await createUser("client");
    const { org } = await onboardedOrg(owner);
    expect(org.trackingLastSeenAt).toBeNull();
    const res = await touch(org.publicKey, {}, { type: "ping" });
    expect(await res.json()).toEqual({ status: "ping" });
    const [after] = await db.select().from(organizations).where(eq(organizations.id, org.id));
    expect(after!.trackingLastSeenAt).not.toBeNull();
  });

  it("answers CORS preflights", () => {
    const res = touchOPTIONS(
      new Request("http://localhost:3003/api/track/touch", {
        method: "OPTIONS",
        headers: { origin: SITE },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("rate limits per IP", async () => {
    const owner = await createUser("client");
    const { org } = await onboardedOrg(owner);
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await touch(org.publicKey, {}, { type: "ping" })).status;
    expect(last).toBe(429);
  });
});
