import { raiseAlert } from "@/server/alerts";
import { campaignsNeedingSpendSync, syncCampaignSpend } from "@/server/campaigns";
import type { ConnectorResolver } from "@/server/connectors";
import { logger } from "@/server/logger";
import { addDays, isoDate, startOfUtcDay } from "@/lib/dates";

/**
 * Daily: pulls spend per campaign per day into ad_spend_daily (internal only). Re-fetches the last
 * `days` days because platforms restate recent spend. Upserts, so re-running is harmless.
 */
export async function runSyncSpend(
  opts: { now?: Date; days?: number; resolve?: ConnectorResolver } = {},
) {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 3;
  const until = startOfUtcDay(now);
  const since = addDays(until, -(days - 1));
  const list = await campaignsNeedingSpendSync(since);
  let rows = 0;
  let failed = 0;
  for (const c of list) {
    try {
      rows += await syncCampaignSpend(c, since, until, opts.resolve);
    } catch (err) {
      failed++;
      logger.error({ err, campaignId: c.id }, "spend sync failed");
      await raiseAlert({
        orgId: c.orgId,
        kind: "connector_error",
        severity: "warning",
        message: `Spend sync failed for "${c.name}": ${err instanceof Error ? err.message : "unknown error"}`,
        dedupeKey: `sync_failed:${c.id}:${isoDate(now)}`,
      });
    }
  }
  return {
    campaigns: list.length,
    rowsUpserted: rows,
    failed,
    since: isoDate(since),
    until: isoDate(until),
  };
}
