import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { organizations, touches, type Organization } from "@/db/schema";
import {
  hasTrackedParams,
  isOriginAllowed,
  referrerHost,
  splitUrl,
  type TouchPayload,
} from "@/lib/tracking";

export type TouchResult =
  | { status: "recorded"; touchId: string }
  | { status: "ping" }
  | { status: "ignored"; reason: "no_tracked_params" }
  | { status: "rejected"; reason: "unknown_key" | "origin_not_allowed" };

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export async function findOrgByPublicKey(pk: string): Promise<Organization | null> {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.publicKey, pk))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Records a touch from the first-party tracking script. Only visits carrying tracked parameters
 * are stored (organic visits are irrelevant to attribution); a "ping" only proves installation.
 * No IP address or full URL (query string) is stored.
 */
export async function ingestTouch(
  payload: TouchPayload,
  origin: string | null,
  now = new Date(),
): Promise<TouchResult> {
  const org = await findOrgByPublicKey(payload.pk);
  if (!org) return { status: "rejected", reason: "unknown_key" };
  if (!isOriginAllowed(origin, org.allowedOrigins)) {
    return { status: "rejected", reason: "origin_not_allowed" };
  }

  // Throttled "tracking installed" heartbeat.
  await db
    .update(organizations)
    .set({ trackingLastSeenAt: now })
    .where(
      and(
        eq(organizations.id, org.id),
        or(
          isNull(organizations.trackingLastSeenAt),
          lt(organizations.trackingLastSeenAt, new Date(now.getTime() - LAST_SEEN_THROTTLE_MS)),
        ),
      ),
    );

  if (payload.type === "ping") return { status: "ping" };
  if (!hasTrackedParams(payload.params)) return { status: "ignored", reason: "no_tracked_params" };

  const landing = splitUrl(payload.url);
  const p = payload.params;
  const [row] = await db
    .insert(touches)
    .values({
      orgId: org.id,
      visitorId: payload.vid,
      occurredAt: now,
      landingHost: landing.host,
      landingPath: landing.path,
      referrerHost: referrerHost(payload.ref),
      utmSource: p.utm_source || null,
      utmMedium: p.utm_medium || null,
      utmCampaign: p.utm_campaign || null,
      utmContent: p.utm_content || null,
      utmTerm: p.utm_term || null,
      gclid: p.gclid || null,
      fbclid: p.fbclid || null,
      ttclid: p.ttclid || null,
      oaCid: p.oa_cid || null,
    })
    .returning({ id: touches.id });
  return { status: "recorded", touchId: row!.id };
}

/** CORS headers for the touch endpoint: only reflect origins the org allowed. */
export function corsHeaders(origin: string | null, allowed: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origin && allowed) h["access-control-allow-origin"] = origin;
  return h;
}
