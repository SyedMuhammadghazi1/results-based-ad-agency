import { NextResponse } from "next/server";
import { normalizeS2sEvent, s2sEventSchema } from "@/lib/revenue-sources";
import { processRevenueEvent } from "@/server/conversions";
import { bearerToken, handleRouteError, jsonError, rateLimitedResponse } from "@/server/http";
import { findOrgByApiKey } from "@/server/orgs";
import { rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Server-to-server conversions & refunds, authenticated with the org's secret API key
 * (`Authorization: Bearer oa_sk_…`). Idempotent on (org, order_id) and (org, refund_id).
 */
export async function POST(req: Request) {
  try {
    const key = bearerToken(req.headers);
    if (!key) return jsonError(401, "unauthorized", "Missing API key");
    const org = await findOrgByApiKey(key);
    if (!org) return jsonError(401, "unauthorized", "Invalid API key");

    const limit = await rateLimit("s2s", org.id, 600, 60);
    if (!limit.allowed) return rateLimitedResponse(limit);

    const event = normalizeS2sEvent(s2sEventSchema.parse(await req.json()));
    const outcome = await processRevenueEvent(org, "api", event);
    const status = outcome.status === "recorded" ? 201 : outcome.status === "rejected" ? 422 : 200;
    return NextResponse.json(outcome, { status });
  } catch (err) {
    if (err instanceof SyntaxError) return jsonError(400, "invalid_json");
    if (err instanceof Error && err.name === "MoneyParseError")
      return jsonError(400, "invalid_amount", err.message);
    return handleRouteError(err, "v1.conversions");
  }
}
