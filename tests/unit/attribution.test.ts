import { describe, expect, it } from "vitest";
import {
  attributeConversion,
  classifyTouch,
  planPendingRefunds,
  planRefund,
  planRefundEvent,
  revenueShareOfGrossRefund,
  windowStartFor,
  type AttributableTouch,
  type CampaignRef,
  type RefundEventInput,
} from "@/lib/attribution";

const DAY = 86_400_000;
const conversionAt = new Date("2026-08-20T12:00:00.000Z");
const at = (msBefore: number) => new Date(conversionAt.getTime() - msBefore);

const metaCampaign: CampaignRef = {
  id: "c-meta",
  trackingCode: "metacode01",
  platform: "meta",
  status: "active",
};
const googleCampaign: CampaignRef = {
  id: "c-google",
  trackingCode: "googcode01",
  platform: "google",
  status: "active",
};
const campaigns = [metaCampaign, googleCampaign];

function touch(
  id: string,
  occurredAt: Date,
  params: Partial<AttributableTouch> = {},
): AttributableTouch {
  return { id, occurredAt, ...params };
}

function attribute(
  touches: AttributableTouch[],
  windowDays = 7,
  visitorKnown = true,
  list = campaigns,
) {
  return attributeConversion({ conversionAt, visitorKnown, touches, campaigns: list, windowDays });
}

describe("classifyTouch", () => {
  it("attributes an oa_cid that matches one of the org's campaigns", () => {
    expect(classifyTouch({ oaCid: "metacode01" }, campaigns)).toEqual({
      paid: true,
      campaignId: "c-meta",
      platform: "meta",
      via: "oa_cid",
    });
  });

  it("rejects an oa_cid that belongs to no campaign of this org (spoofed or foreign)", () => {
    expect(classifyTouch({ oaCid: "someoneelse" }, campaigns)).toEqual({
      paid: false,
      reason: "unknown_campaign_code",
    });
  });

  it("does not fall back to click ids when an unknown oa_cid is present", () => {
    expect(classifyTouch({ oaCid: "bogus", gclid: "abc" }, campaigns)).toMatchObject({
      paid: false,
    });
  });

  it("counts gclid when we run a Google campaign for the org", () => {
    expect(classifyTouch({ gclid: "Cj0KCQ" }, campaigns)).toEqual({
      paid: true,
      campaignId: "c-google",
      platform: "google",
      via: "click_id",
    });
  });

  it("leaves campaignId null when several managed campaigns share the platform", () => {
    const two = [...campaigns, { ...googleCampaign, id: "c-google-2", trackingCode: "googcode02" }];
    expect(classifyTouch({ gclid: "x" }, two)).toMatchObject({
      paid: true,
      campaignId: null,
      platform: "google",
    });
  });

  it("ignores gclid when we run no Google campaign (the client's own ads are not ours)", () => {
    expect(classifyTouch({ gclid: "x" }, [metaCampaign])).toEqual({
      paid: false,
      reason: "click_id_without_managed_campaign",
    });
  });

  it("ignores gclid when the only Google campaign is still a draft", () => {
    expect(classifyTouch({ gclid: "x" }, [{ ...googleCampaign, status: "draft" }])).toMatchObject({
      paid: false,
    });
  });

  it("counts ttclid only with a managed TikTok campaign", () => {
    const tiktok: CampaignRef = {
      id: "c-tt",
      trackingCode: "ttcode0001",
      platform: "tiktok",
      status: "paused",
    };
    expect(classifyTouch({ ttclid: "t" }, [tiktok])).toMatchObject({
      paid: true,
      platform: "tiktok",
    });
    expect(classifyTouch({ ttclid: "t" }, campaigns)).toMatchObject({ paid: false });
  });

  it("never counts fbclid alone (Facebook adds it to organic links)", () => {
    expect(classifyTouch({ fbclid: "IwAR" }, campaigns)).toEqual({
      paid: false,
      reason: "fbclid_only",
    });
  });

  it("never counts UTM parameters alone", () => {
    expect(classifyTouch({ utmSource: "facebook", utmMedium: "cpc" }, campaigns)).toEqual({
      paid: false,
      reason: "utm_only",
    });
  });

  it("treats blank identifiers as absent", () => {
    expect(classifyTouch({ oaCid: "  ", gclid: "" }, campaigns)).toEqual({
      paid: false,
      reason: "no_identifiers",
    });
  });
});

describe("attributeConversion", () => {
  it("returns unknown_visitor when the conversion carries no visitor id", () => {
    expect(attribute([touch("t1", at(DAY), { oaCid: "metacode01" })], 7, false)).toEqual({
      attributed: false,
      reason: "unknown_visitor",
    });
  });

  it("returns no_paid_touch_in_window when the visitor has no touches", () => {
    expect(attribute([])).toEqual({ attributed: false, reason: "no_paid_touch_in_window" });
  });

  it("attributes the only paid touch inside the window", () => {
    expect(attribute([touch("t1", at(2 * DAY), { oaCid: "metacode01" })])).toEqual({
      attributed: true,
      reason: "last_paid_touch",
      touchId: "t1",
      campaignId: "c-meta",
      platform: "meta",
    });
  });

  it("includes a touch exactly at the window start (inclusive boundary)", () => {
    const res = attribute([touch("t1", at(7 * DAY), { oaCid: "metacode01" })]);
    expect(res).toMatchObject({ attributed: true, touchId: "t1" });
  });

  it("excludes a touch 1 ms before the window start", () => {
    expect(attribute([touch("t1", at(7 * DAY + 1), { oaCid: "metacode01" })])).toEqual({
      attributed: false,
      reason: "no_paid_touch_in_window",
    });
  });

  it("includes a touch at exactly the conversion time", () => {
    expect(attribute([touch("t1", at(0), { oaCid: "metacode01" })])).toMatchObject({
      attributed: true,
    });
  });

  it("ignores touches after the conversion", () => {
    const later = new Date(conversionAt.getTime() + 1);
    expect(attribute([touch("t1", later, { oaCid: "metacode01" })])).toEqual({
      attributed: false,
      reason: "no_paid_touch_in_window",
    });
  });

  it("picks the LAST paid touch among several", () => {
    const res = attribute([
      touch("t-old", at(5 * DAY), { oaCid: "metacode01" }),
      touch("t-new", at(1 * DAY), { oaCid: "googcode01" }),
      touch("t-mid", at(3 * DAY), { oaCid: "metacode01" }),
    ]);
    expect(res).toMatchObject({
      attributed: true,
      touchId: "t-new",
      campaignId: "c-google",
      platform: "google",
    });
  });

  it("skips a later organic/unpaid touch and credits the earlier paid one", () => {
    const res = attribute([
      touch("t-paid", at(4 * DAY), { oaCid: "metacode01" }),
      touch("t-organic", at(1 * DAY), { fbclid: "IwAR" }),
      touch("t-utm", at(DAY / 2), { utmSource: "newsletter" }),
    ]);
    expect(res).toMatchObject({ attributed: true, touchId: "t-paid" });
  });

  it("ignores a paid touch after the conversion even if it is the latest", () => {
    const res = attribute([
      touch("t-before", at(2 * DAY), { oaCid: "metacode01" }),
      touch("t-after", new Date(conversionAt.getTime() + DAY), { oaCid: "googcode01" }),
    ]);
    expect(res).toMatchObject({ attributed: true, touchId: "t-before" });
  });

  it("respects a custom window", () => {
    const touches = [touch("t1", at(10 * DAY), { oaCid: "metacode01" })];
    expect(attribute(touches, 7)).toMatchObject({ attributed: false });
    expect(attribute(touches, 14)).toMatchObject({ attributed: true });
    expect(attribute(touches, 10)).toMatchObject({ attributed: true });
  });

  it("breaks timestamp ties deterministically by touch id", () => {
    const same = at(DAY);
    const a = attribute([
      touch("a", same, { oaCid: "metacode01" }),
      touch("b", same, { oaCid: "googcode01" }),
    ]);
    const b = attribute([
      touch("b", same, { oaCid: "googcode01" }),
      touch("a", same, { oaCid: "metacode01" }),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ touchId: "b" });
  });

  it("does not attribute when the matching campaign belongs to another org", () => {
    const otherOrgCampaigns: CampaignRef[] = [
      { id: "x", trackingCode: "zzzz", platform: "meta", status: "active" },
    ];
    expect(
      attribute([touch("t1", at(DAY), { oaCid: "metacode01" })], 7, true, otherOrgCampaigns),
    ).toMatchObject({
      attributed: false,
    });
  });

  it("rejects an invalid window", () => {
    expect(attribute([touch("t1", at(DAY), { oaCid: "metacode01" })], 0)).toEqual({
      attributed: false,
      reason: "invalid_window",
    });
  });

  it("windowStartFor returns the inclusive lower bound", () => {
    expect(windowStartFor(conversionAt, 7).toISOString()).toBe("2026-08-13T12:00:00.000Z");
  });
});

describe("planRefund", () => {
  it("creates a negative adjustment for a partial refund", () => {
    expect(planRefund(10_000, 0, 2_500)).toEqual({
      ok: true,
      adjustmentMinor: -2_500,
      newRefundedMinor: 2_500,
    });
  });

  it("handles a full refund", () => {
    expect(planRefund(10_000, 0, 10_000)).toEqual({
      ok: true,
      adjustmentMinor: -10_000,
      newRefundedMinor: 10_000,
    });
  });

  it("caps cumulative refunds at the original amount", () => {
    expect(planRefund(10_000, 7_000, 5_000)).toEqual({
      ok: true,
      adjustmentMinor: -3_000,
      newRefundedMinor: 10_000,
    });
  });

  it("ignores refunds once the order is fully refunded", () => {
    expect(planRefund(10_000, 10_000, 1)).toEqual({ ok: false, reason: "already_fully_refunded" });
  });

  it("rejects zero, negative and fractional refunds", () => {
    expect(planRefund(10_000, 0, 0)).toMatchObject({ ok: false, reason: "non_positive_refund" });
    expect(planRefund(10_000, 0, -5)).toMatchObject({ ok: false });
    expect(planRefund(10_000, 0, 1.5)).toMatchObject({ ok: false });
  });
});

describe("revenueShareOfGrossRefund", () => {
  // $216 order = $200 revenue + $16 tax; Stripe reports refunds tax-inclusive.
  it("pro-rates a tax-inclusive refund to the revenue (ex-tax) share, round-half-up", () => {
    expect(revenueShareOfGrossRefund(5_000, 20_000, 21_600)).toBe(4_630); // 4 629.63
    expect(revenueShareOfGrossRefund(12_000, 20_000, 21_600)).toBe(11_111); // 11 111.11
    expect(revenueShareOfGrossRefund(21_600, 20_000, 21_600)).toBe(20_000); // full refund
  });

  it("is the identity when there is no tax or the gross amount is unknown", () => {
    expect(revenueShareOfGrossRefund(5_000, 20_000, 20_000)).toBe(5_000);
    expect(revenueShareOfGrossRefund(5_000, 20_000, undefined)).toBe(5_000);
    expect(revenueShareOfGrossRefund(5_000, 20_000, 0)).toBe(5_000);
  });
});

describe("planRefundEvent", () => {
  it("applies a per-refund amount with the cap (order-then-refund behaviour is unchanged)", () => {
    const conv = { amountMinor: 10_000, refundedMinor: 0 };
    expect(
      planRefundEvent(conv, { kind: "refund", externalRefundId: "r1", amountMinor: 3_000 }),
    ).toEqual(planRefund(10_000, 0, 3_000));
    expect(
      planRefundEvent(
        { amountMinor: 10_000, refundedMinor: 7_000 },
        {
          kind: "refund",
          externalRefundId: "r2",
          amountMinor: 5_000,
        },
      ),
    ).toEqual({ ok: true, adjustmentMinor: -3_000, newRefundedMinor: 10_000 });
  });

  it("pro-rates Stripe's cumulative tax-inclusive refunds and turns them into deltas", () => {
    const cumulative = (n: number): RefundEventInput => ({
      kind: "refund_cumulative",
      externalRefundId: `ch_1:${n}`,
      cumulativeRefundedMinor: n,
      chargedGrossMinor: 21_600,
    });
    expect(planRefundEvent({ amountMinor: 20_000, refundedMinor: 0 }, cumulative(5_000))).toEqual({
      ok: true,
      adjustmentMinor: -4_630,
      newRefundedMinor: 4_630,
    });
    expect(
      planRefundEvent({ amountMinor: 20_000, refundedMinor: 4_630 }, cumulative(12_000)),
    ).toMatchObject({ ok: true, adjustmentMinor: -6_481 });
    // An older cumulative total than what is already recorded adds nothing.
    expect(
      planRefundEvent({ amountMinor: 20_000, refundedMinor: 11_111 }, cumulative(5_000)),
    ).toEqual({ ok: false, reason: "no_new_refund" });
  });
});

describe("planPendingRefunds (refunds that arrived before their order)", () => {
  const conv = { amountMinor: 10_000, refundedMinor: 0 };
  const refund = (id: string, amountMinor: number): RefundEventInput => ({
    kind: "refund",
    externalRefundId: id,
    amountMinor,
  });
  const adjustments = (plans: ReturnType<typeof planPendingRefunds>) =>
    plans.flatMap((p) => (p.plan.ok ? [p.plan.adjustmentMinor] : []));

  it("nets refund-then-order exactly like order-then-refund", () => {
    const plans = planPendingRefunds(conv, [refund("r1", 3_000), refund("r2", 2_500)]);
    expect(adjustments(plans)).toEqual([-3_000, -2_500]);
    // Same result as applying them one by one after the order.
    const first = planRefund(10_000, 0, 3_000);
    const second = planRefund(10_000, first.ok ? first.newRefundedMinor : 0, 2_500);
    expect(adjustments(plans)).toEqual([first, second].map((p) => (p.ok ? p.adjustmentMinor : 0)));
  });

  it("caps the total at the order amount across pending refunds", () => {
    const plans = planPendingRefunds(conv, [
      refund("r1", 6_000),
      refund("r2", 6_000),
      refund("r3", 1),
    ]);
    expect(adjustments(plans)).toEqual([-6_000, -4_000]);
    expect(plans[2]!.plan).toEqual({ ok: false, reason: "already_fully_refunded" });
  });

  it("dedupes a refund delivered twice, and refunds already recorded", () => {
    const plans = planPendingRefunds(
      conv,
      [refund("r1", 3_000), refund("r1", 3_000), refund("r0", 1_000)],
      new Set(["r0"]),
    );
    expect(adjustments(plans)).toEqual([-3_000]);
    expect(plans.map((p) => p.plan)).toMatchObject([
      { ok: true },
      { ok: false, reason: "duplicate" },
      { ok: false, reason: "duplicate" },
    ]);
  });

  it("converges on the latest cumulative Stripe total whatever order the events arrived in", () => {
    const cumulative = (n: number): RefundEventInput => ({
      kind: "refund_cumulative",
      externalRefundId: `ch_1:${n}`,
      cumulativeRefundedMinor: n,
      chargedGrossMinor: 21_600,
    });
    const order = { amountMinor: 20_000, refundedMinor: 0 };
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const inOrder = adjustments(planPendingRefunds(order, [cumulative(5_000), cumulative(12_000)]));
    const reversed = adjustments(
      planPendingRefunds(order, [cumulative(12_000), cumulative(5_000)]),
    );
    expect(inOrder).toEqual([-4_630, -6_481]);
    expect(sum(reversed)).toBe(sum(inOrder));
    expect(sum(inOrder)).toBe(-11_111);
  });
});
