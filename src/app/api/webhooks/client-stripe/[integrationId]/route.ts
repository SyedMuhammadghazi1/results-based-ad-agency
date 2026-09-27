import { normalizeClientStripeEvent } from "@/lib/revenue-sources";
import { handleRouteError, jsonError, rateLimitedResponse } from "@/server/http";
import { loadWebhookIntegration } from "@/server/integrations";
import { rateLimit } from "@/server/rate-limit";
import { constructStripeEvent } from "@/server/stripe";
import { handleRevenueWebhook } from "@/server/webhooks";

export const dynamic = "force-dynamic";

/** The CLIENT's own Stripe account (a revenue source), verified with the org's signing secret. */
export async function POST(req: Request, ctx: { params: Promise<{ integrationId: string }> }) {
  try {
    const { integrationId } = await ctx.params;
    const limit = await rateLimit("webhook:client-stripe", integrationId, 1200, 60);
    if (!limit.allowed) return rateLimitedResponse(limit);

    const raw = await req.text();
    const found = await loadWebhookIntegration(integrationId, "stripe");
    if (!found) return jsonError(404, "not_found");
    let event;
    try {
      event = constructStripeEvent(raw, req.headers.get("stripe-signature"), found.secret);
    } catch {
      return jsonError(401, "invalid_signature");
    }
    return await handleRevenueWebhook({
      provider: `stripe_client:${integrationId}`,
      deliveryId: event.id,
      type: event.type,
      org: found.org,
      integrationId,
      source: "stripe",
      event: normalizeClientStripeEvent(event),
    });
  } catch (err) {
    return handleRouteError(err, "webhook.client_stripe");
  }
}
