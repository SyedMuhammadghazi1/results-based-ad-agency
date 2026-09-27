import Stripe from "stripe";
import { env } from "@/env";

/**
 * The agency's own Stripe account (collecting performance fees). The client's Stripe account —
 * a revenue source — never uses this client; its webhooks are verified with per-org secrets.
 *
 * Tests inject a fake object implementing the subset of the SDK used here ("mocked at the SDK
 * boundary"), so the rest of the billing code runs unmodified.
 */
export type StripeClient = Pick<
  Stripe,
  "customers" | "invoices" | "invoiceItems" | "checkout" | "setupIntents"
>;

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function getStripe(): StripeClient {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not configured");
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    appInfo: { name: env.NEXT_PUBLIC_APP_NAME },
    maxNetworkRetries: 2,
    timeout: 20_000,
  });
  return client;
}

/** Verifies a Stripe webhook signature against the raw body (throws on failure). */
export function constructStripeEvent(
  rawBody: string,
  signature: string | null,
  secret: string,
): Stripe.Event {
  if (!signature) throw new Error("Missing stripe-signature header");
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** Generates a valid signature header — used by tests and the local webhook replay script. */
export function signStripePayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}
