import { DAY_MS } from "./dates";
import type { CampaignStatus, Platform } from "@/db/schema";

/**
 * Attribution engine (pure).
 *
 * Model: LAST PAID-MEDIA TOUCH within the agreement's click window before the conversion.
 *
 * A touch only counts as paid media we ran when it carries one of OUR identifiers:
 *   1. `oa_cid` matching a campaign of the same organization (our tracking template adds it to
 *      every ad click) → attributed to that campaign; or
 *   2. no `oa_cid`, but a platform click id that only paid clicks carry — `gclid` (Google Ads
 *      auto-tagging) or `ttclid` (TikTok Ads) — AND the org has a campaign we run on that
 *      platform. Attributed to that platform (and to the campaign when it is the only one).
 *
 * Never counted: `fbclid` alone (Facebook appends it to organic outbound links too), UTM
 * parameters alone (anyone can set them), an `oa_cid` that belongs to another org or to no
 * campaign, direct/organic visits. The client only pays for ad-driven revenue.
 */

export type TouchParams = {
  oaCid?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  ttclid?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
};

export type CampaignRef = {
  id: string;
  trackingCode: string;
  platform: Platform;
  status: CampaignStatus;
};

export type Classification =
  | { paid: true; campaignId: string | null; platform: Platform; via: "oa_cid" | "click_id" }
  | { paid: false; reason: NotPaidReason };

export type NotPaidReason =
  | "no_identifiers"
  | "unknown_campaign_code"
  | "fbclid_only"
  | "utm_only"
  | "click_id_without_managed_campaign";

const CLICK_ID_PLATFORMS: Array<{ key: "gclid" | "ttclid"; platform: Platform }> = [
  { key: "gclid", platform: "google" },
  { key: "ttclid", platform: "tiktok" },
];

function present(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function classifyTouch(touch: TouchParams, orgCampaigns: CampaignRef[]): Classification {
  if (present(touch.oaCid)) {
    const campaign = orgCampaigns.find((c) => c.trackingCode === touch.oaCid);
    if (campaign) {
      return { paid: true, campaignId: campaign.id, platform: campaign.platform, via: "oa_cid" };
    }
    // An oa_cid we do not recognise could be spoofed or belong to another org: never billable.
    return { paid: false, reason: "unknown_campaign_code" };
  }

  for (const { key, platform } of CLICK_ID_PLATFORMS) {
    if (!present(touch[key])) continue;
    const managed = orgCampaigns.filter((c) => c.platform === platform && c.status !== "draft");
    if (managed.length === 0) return { paid: false, reason: "click_id_without_managed_campaign" };
    return {
      paid: true,
      campaignId: managed.length === 1 ? managed[0]!.id : null,
      platform,
      via: "click_id",
    };
  }

  if (present(touch.fbclid)) return { paid: false, reason: "fbclid_only" };
  if (present(touch.utmSource) || present(touch.utmMedium)) return { paid: false, reason: "utm_only" };
  return { paid: false, reason: "no_identifiers" };
}

export type AttributableTouch = TouchParams & { id: string; occurredAt: Date };

export type AttributionInput = {
  conversionAt: Date;
  /** Null/undefined when the conversion carried no visitor id. */
  visitorKnown: boolean;
  touches: AttributableTouch[];
  campaigns: CampaignRef[];
  windowDays: number;
};

export type AttributionResult =
  | {
      attributed: true;
      reason: "last_paid_touch";
      touchId: string;
      campaignId: string | null;
      platform: Platform;
    }
  | {
      attributed: false;
      reason: "unknown_visitor" | "no_paid_touch_in_window" | "no_agreement" | "invalid_window";
    };

/**
 * Picks the most recent paid touch with `conversionAt - window <= touch.occurredAt <= conversionAt`.
 * Both boundaries are inclusive. Touches after the conversion are ignored. Ties on the timestamp
 * are broken deterministically by touch id (lexicographically greatest wins).
 */
export function attributeConversion(input: AttributionInput): AttributionResult {
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1) {
    return { attributed: false, reason: "invalid_window" };
  }
  if (!input.visitorKnown) return { attributed: false, reason: "unknown_visitor" };

  const convAt = input.conversionAt.getTime();
  const windowStart = convAt - input.windowDays * DAY_MS;

  let best: { touch: AttributableTouch; cls: Extract<Classification, { paid: true }> } | null =
    null;
  for (const touch of input.touches) {
    const t = touch.occurredAt.getTime();
    if (t > convAt || t < windowStart) continue;
    const cls = classifyTouch(touch, input.campaigns);
    if (!cls.paid) continue;
    if (
      !best ||
      t > best.touch.occurredAt.getTime() ||
      (t === best.touch.occurredAt.getTime() && touch.id > best.touch.id)
    ) {
      best = { touch, cls };
    }
  }

  if (!best) return { attributed: false, reason: "no_paid_touch_in_window" };
  return {
    attributed: true,
    reason: "last_paid_touch",
    touchId: best.touch.id,
    campaignId: best.cls.campaignId,
    platform: best.cls.platform,
  };
}

/** Earliest touch timestamp that can matter for a conversion (used to bound DB queries). */
export function windowStartFor(conversionAt: Date, windowDays: number): Date {
  return new Date(conversionAt.getTime() - windowDays * DAY_MS);
}

export type RefundPlan =
  | { ok: true; adjustmentMinor: number; newRefundedMinor: number }
  | { ok: false; reason: "non_positive_refund" | "already_fully_refunded" };

/**
 * Computes the negative adjustment for a refund, capping cumulative refunds at the original
 * conversion amount (so net revenue for a conversion can never go below zero).
 */
export function planRefund(
  conversionAmountMinor: number,
  alreadyRefundedMinor: number,
  refundMinor: number,
): RefundPlan {
  if (!Number.isSafeInteger(refundMinor) || refundMinor <= 0) {
    return { ok: false, reason: "non_positive_refund" };
  }
  const remaining = conversionAmountMinor - alreadyRefundedMinor;
  if (remaining <= 0) return { ok: false, reason: "already_fully_refunded" };
  const applied = Math.min(refundMinor, remaining);
  return { ok: true, adjustmentMinor: -applied, newRefundedMinor: alreadyRefundedMinor + applied };
}
