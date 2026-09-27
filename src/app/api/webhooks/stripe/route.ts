import { NextResponse } from "next/server";
import { env } from "@/env";
import { handlePlatformStripeEvent } from "@/server/billing";
import { handleRouteError, jsonError } from "@/server/http";
import { logger } from "@/server/logger";
import { constructStripeEvent, getStripe, stripeConfigured } from "@/server/stripe";

export const dynamic = "force-dynamic";

/**
 * The agency's Stripe account: payment-method setup (Checkout, setup mode) and invoice status.
 * Signature verified against the raw body; processed event ids are stored for idempotency.
 */
export async function POST(req: Request) {
  if (!env.STRIPE_WEBHOOK_SECRET) return jsonError(503, "stripe_not_configured");
  const raw = await req.text();
  let event;
  try {
    event = constructStripeEvent(
      raw,
      req.headers.get("stripe-signature"),
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "stripe webhook signature failed",
    );
    return jsonError(400, "invalid_signature");
  }
  try {
    const result = await handlePlatformStripeEvent(event, stripeConfigured() ? getStripe() : null);
    return NextResponse.json({ received: true, result });
  } catch (err) {
    return handleRouteError(err, "webhook.stripe");
  }
}
