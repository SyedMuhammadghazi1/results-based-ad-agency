import { NextResponse } from "next/server";
import { TOUCH_RATE_LIMITS, touchPayloadSchema } from "@/lib/tracking";
import { clientIp } from "@/server/client-ip";
import { handleRouteError, jsonError, rateLimitedResponse } from "@/server/http";
import { rateLimit, rateLimitByIp } from "@/server/rate-limit";
import { corsHeaders, ingestTouch } from "@/server/tracking";

export const dynamic = "force-dynamic";
const MAX_BODY = 8 * 1024;

export function OPTIONS(req: Request) {
  // Preflights carry no body (no public key), so the real origin check happens on POST.
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin"), true) });
}

/** Public endpoint called by t.js on client websites. */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  try {
    const { perIp, perKey } = TOUCH_RATE_LIMITS;
    // Checked first, so a flooding IP never eats into its target's per-key budget. Unknown
    // client IP: the per-key limit below still applies (no bucket shared by everyone).
    const ipLimit = await rateLimitByIp(
      "touch:ip",
      clientIp(req.headers),
      perIp.limit,
      perIp.windowSec,
      "skip",
    );
    if (ipLimit && !ipLimit.allowed)
      return rateLimitedResponse(ipLimit, corsHeaders(origin, false));

    const raw = await req.text();
    if (raw.length > MAX_BODY)
      return jsonError(413, "payload_too_large", undefined, corsHeaders(origin, false));
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return jsonError(400, "invalid_json", undefined, corsHeaders(origin, false));
    }
    const parsed = touchPayloadSchema.safeParse(json);
    if (!parsed.success)
      return jsonError(400, "invalid_request", "Invalid touch payload", corsHeaders(origin, false));

    const orgLimit = await rateLimit("touch:org", parsed.data.pk, perKey.limit, perKey.windowSec);
    if (!orgLimit.allowed) return rateLimitedResponse(orgLimit, corsHeaders(origin, false));

    const result = await ingestTouch(parsed.data, origin);
    if (result.status === "rejected") {
      const status = result.reason === "unknown_key" ? 404 : 403;
      return jsonError(status, result.reason, undefined, corsHeaders(origin, false));
    }
    return NextResponse.json(
      { status: result.status },
      { status: result.status === "recorded" ? 201 : 200, headers: corsHeaders(origin, true) },
    );
  } catch (err) {
    const res = handleRouteError(err, "track.touch");
    for (const [k, v] of Object.entries(corsHeaders(origin, false))) res.headers.set(k, v);
    return res;
  }
}
