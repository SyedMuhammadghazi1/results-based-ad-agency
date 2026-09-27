import { verifyShopifyHmac } from "@/lib/crypto";
import { normalizeShopifyWebhook } from "@/lib/revenue-sources";
import { handleRouteError, jsonError, rateLimitedResponse } from "@/server/http";
import { loadWebhookIntegration } from "@/server/integrations";
import { rateLimit } from "@/server/rate-limit";
import { handleRevenueWebhook } from "@/server/webhooks";

export const dynamic = "force-dynamic";

/** Shopify `orders/paid` + `refunds/create`, verified with HMAC-SHA256 of the raw body. */
export async function POST(req: Request, ctx: { params: Promise<{ integrationId: string }> }) {
  try {
    const { integrationId } = await ctx.params;
    const limit = await rateLimit("webhook:shopify", integrationId, 1200, 60);
    if (!limit.allowed) return rateLimitedResponse(limit);

    const raw = await req.text();
    const found = await loadWebhookIntegration(integrationId, "shopify");
    if (!found) return jsonError(404, "not_found");
    if (!verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256"), found.secret)) {
      return jsonError(401, "invalid_signature");
    }
    const topic = req.headers.get("x-shopify-topic") ?? "";
    const event = normalizeShopifyWebhook(topic, JSON.parse(raw));
    return await handleRevenueWebhook({
      provider: `shopify:${integrationId}`,
      deliveryId: req.headers.get("x-shopify-webhook-id"),
      type: topic,
      org: found.org,
      integrationId,
      source: "shopify",
      event,
    });
  } catch (err) {
    return handleRouteError(err, "webhook.shopify");
  }
}
