import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, orgIntakes, organizations } from "@/db/schema";
import { evaluateBudget, shouldResumeCapPause } from "@/lib/budget";
import { periodContaining, startOfUtcDay } from "@/lib/dates";
import { formatMinor } from "@/lib/money";
import { raiseAlert } from "@/server/alerts";
import {
  launchBlocker,
  monthToDateSpend,
  pauseOrgCampaigns,
  setCampaignStatus,
  SYSTEM,
  syncCampaignSpend,
} from "@/server/campaigns";
import type { ConnectorResolver } from "@/server/connectors";
import { logger } from "@/server/logger";

/**
 * Hourly: refreshes today's spend for live campaigns, then pauses every campaign of a client whose
 * month-to-date spend reached their monthly cap, and alerts operators. Campaigns paused by the
 * cap in an earlier month are resumed once the new month starts (if nothing else blocks them).
 */
export async function runBudgetGuard(opts: { now?: Date; resolve?: ConnectorResolver } = {}) {
  const now = opts.now ?? new Date();
  const month = periodContaining(now);
  const today = startOfUtcDay(now);
  const orgs = await db
    .select({ org: organizations, cap: orgIntakes.monthlySpendCapMinor })
    .from(organizations)
    .innerJoin(orgIntakes, eq(orgIntakes.orgId, organizations.id));

  const summary = {
    orgsChecked: orgs.length,
    capReached: 0,
    near: 0,
    campaignsPaused: 0,
    campaignsResumed: 0,
  };

  for (const { org, cap } of orgs) {
    const live = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.orgId, org.id), eq(campaigns.status, "active")));
    for (const c of live) {
      try {
        await syncCampaignSpend(c, today, today, opts.resolve);
      } catch (err) {
        logger.warn({ err, campaignId: c.id }, "budget guard: spend refresh failed");
      }
    }

    const mtd = await monthToDateSpend(org.id, now);
    const state = evaluateBudget(mtd, cap);

    if (state === "reached") {
      summary.capReached++;
      if (live.length > 0) {
        const res = await pauseOrgCampaigns(org.id, "budget_cap", opts.resolve);
        summary.campaignsPaused += res.paused;
      }
      await raiseAlert({
        orgId: org.id,
        kind: "budget_cap_reached",
        severity: "critical",
        message: `${org.name}: month-to-date spend ${formatMinor(mtd, org.currency)} reached the ${formatMinor(cap, org.currency)} cap — campaigns paused`,
        dedupeKey: `budget_cap:${org.id}:${month.key}`,
        data: { mtdSpendMinor: mtd, capMinor: cap },
      });
      continue;
    }

    if (state === "near") {
      summary.near++;
      await raiseAlert({
        orgId: org.id,
        kind: "budget_cap_near",
        severity: "warning",
        message: `${org.name}: month-to-date spend is at ${Math.floor((mtd * 100) / cap)}% of the monthly cap`,
        dedupeKey: `budget_near:${org.id}:${month.key}`,
        data: { mtdSpendMinor: mtd, capMinor: cap },
      });
    }

    const capPaused = await db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.orgId, org.id),
          eq(campaigns.status, "paused"),
          eq(campaigns.pausedReason, "budget_cap"),
          isNotNull(campaigns.pausedAt),
        ),
      );
    for (const c of capPaused) {
      if (
        !shouldResumeCapPause({
          pausedAt: c.pausedAt!,
          now,
          mtdSpendMinor: mtd,
          capMinor: cap,
          dunning: org.dunningPausedAt !== null,
        })
      ) {
        continue;
      }
      if (await launchBlocker(org.id, now)) continue;
      try {
        await setCampaignStatus(SYSTEM, c, "active", {
          resolve: opts.resolve,
          skipLaunchChecks: true,
        });
        summary.campaignsResumed++;
      } catch (err) {
        logger.error({ err, campaignId: c.id }, "budget guard: resume failed");
      }
    }
  }
  return summary;
}
