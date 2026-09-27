import { NextResponse } from "next/server";
import type { ConversionSource } from "@/db/schema";
import type { RevenueEvent } from "@/lib/revenue-sources";
import { alreadyProcessed, markProcessed } from "./billing";
import { processRevenueEvent } from "./conversions";
import { markIntegrationEvent } from "./integrations";
import { logger } from "./logger";
import type { Organization } from "@/db/schema";

/**
 * Shared tail of the revenue-source webhooks: dedupe by delivery id, record the event, answer
 * 200 for anything we understood (even if ignored/rejected) so providers don't retry forever.
 */
export async function handleRevenueWebhook(p: {
  provider: string;
  deliveryId: string | null;
  type: string;
  org: Organization;
  integrationId: string;
  source: ConversionSource;
  event: RevenueEvent;
}): Promise<NextResponse> {
  if (p.deliveryId && (await alreadyProcessed(p.provider, p.deliveryId))) {
    return NextResponse.json({ status: "duplicate_delivery" });
  }
  const outcome = await processRevenueEvent(p.org, p.source, p.event);
  await markIntegrationEvent(p.integrationId);
  if (p.deliveryId) await markProcessed(p.provider, p.deliveryId, p.type);
  if (outcome.status === "rejected") {
    logger.warn(
      { orgId: p.org.id, source: p.source, reason: outcome.reason },
      "revenue event rejected",
    );
  }
  return NextResponse.json(outcome);
}
