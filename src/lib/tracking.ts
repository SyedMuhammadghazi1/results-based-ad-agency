import { z } from "zod";
import type { Platform } from "@/db/schema";

/** Parameters the tracking script forwards (everything else in the URL is dropped). */
export const TRACKED_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
  "ttclid",
  "oa_cid",
] as const;

const param = z.string().trim().max(500).optional();

export const touchPayloadSchema = z.object({
  pk: z.string().regex(/^oa_pk_[a-z0-9]{8,64}$/),
  vid: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  type: z.enum(["touch", "ping"]).default("touch"),
  url: z.string().max(2048).optional(),
  ref: z.string().max(2048).optional(),
  params: z
    .object({
      utm_source: param,
      utm_medium: param,
      utm_campaign: param,
      utm_content: param,
      utm_term: param,
      gclid: param,
      fbclid: param,
      ttclid: param,
      oa_cid: param,
    })
    .default({}),
});

export type TouchPayload = z.infer<typeof touchPayloadSchema>;

export function hasTrackedParams(params: TouchPayload["params"]): boolean {
  return TRACKED_PARAMS.some((k) => typeof params[k] === "string" && params[k]!.length > 0);
}

/** Normalises "https://Shop.Example.com/path" → "https://shop.example.com". Null when invalid. */
export function normalizeOrigin(value: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowed.includes(normalized);
}

/** Splits a page URL into host + path. Query strings/fragments are never stored. */
export function splitUrl(value: string | undefined): { host: string | null; path: string | null } {
  if (!value) return { host: null, path: null };
  try {
    const u = new URL(value);
    return { host: u.host.toLowerCase().slice(0, 255), path: u.pathname.slice(0, 500) };
  } catch {
    return { host: null, path: null };
  }
}

export function referrerHost(value: string | undefined): string | null {
  return splitUrl(value).host;
}

/**
 * URL template operators paste into the ad platform. Every click then carries `oa_cid`, which
 * is what makes revenue attributable (and billable).
 */
export function trackingUrlTemplate(
  platform: Platform,
  trackingCode: string,
  landingUrl: string,
): { finalUrl: string; template: string; notes: string } {
  const utm = (source: string, medium: string, extra: string) =>
    `oa_cid=${trackingCode}&utm_source=${source}&utm_medium=${medium}${extra}`;
  switch (platform) {
    case "google":
      return {
        finalUrl: landingUrl,
        template: `{lpurl}?${utm("google", "cpc", "&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}")}`,
        notes:
          "Paste into Campaign settings → Campaign URL options → Tracking template. Keep auto-tagging (gclid) on.",
      };
    case "meta":
      return {
        finalUrl: landingUrl,
        template: utm("meta", "paid_social", "&utm_campaign={{campaign.id}}&utm_content={{ad.id}}"),
        notes: "Paste into the ad's Tracking → URL parameters field.",
      };
    case "tiktok":
      return {
        finalUrl: landingUrl,
        template: utm("tiktok", "paid_social", "&utm_campaign=__CAMPAIGN_ID__&utm_content=__CID__"),
        notes: "Append to the ad's destination URL (URL parameters). Keep ttclid enabled.",
      };
  }
}

export function buildTrackedLandingUrl(landingUrl: string, trackingCode: string): string {
  const u = new URL(landingUrl);
  u.searchParams.set("oa_cid", trackingCode);
  return u.toString();
}

export function installSnippet(appUrl: string, publicKey: string): string {
  return `<script async src="${appUrl.replace(/\/$/, "")}/t.js" data-key="${publicKey}"></script>`;
}
