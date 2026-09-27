import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  adSpendDaily,
  campaigns,
  CONNECTOR_KINDS,
  OBJECTIVES,
  PLATFORMS,
  type Campaign,
  type PauseReason,
} from "@/db/schema";
import { evaluateBudget } from "@/lib/budget";
import { randomCode } from "@/lib/crypto";
import { isoDate, periodContaining } from "@/lib/dates";
import { parseMoneyInput } from "@/lib/money";
import { onboardingProgress } from "@/lib/onboarding";
import { raiseAlert } from "./alerts";
import { audit } from "./audit";
import {
  availableConnectors,
  defaultConnectorResolver,
  type ConnectorResolver,
} from "./connectors";
import type { SessionUser } from "./guards";
import { logger } from "./logger";
import { DomainError, getIntake, getOrg, onboardingFacts } from "./orgs";

export type Actor = Pick<SessionUser, "id" | "role"> | { id: null; role: "system" };
export const SYSTEM: Actor = { id: null, role: "system" };

const creativeLine = z
  .string()
  .transform((line) => {
    const [name, url, format] = line.split("|").map((s) => s.trim());
    return { name: name ?? "", url: url ?? "", format: format || "image" };
  })
  .pipe(
    z.object({
      name: z.string().min(1).max(120),
      url: z.url({ protocol: /^https?$/ }),
      format: z.enum(["image", "video", "carousel", "text"]),
    }),
  );

export const campaignInputSchema = z.object({
  name: z.string().trim().min(3).max(120),
  platform: z.enum(PLATFORMS),
  objective: z.enum(OBJECTIVES),
  connector: z.enum(CONNECTOR_KINDS).optional(),
  dailyBudget: z
    .string()
    .trim()
    .regex(/^[\d,]+(\.\d{1,2})?$/, "Enter a budget like 50 or 50.00"),
  landingUrl: z.url({ protocol: /^https?$/ }),
  targetingNotes: z.string().trim().max(5000).default(""),
  /** One creative per line: `name | url | image|video|carousel|text` */
  creatives: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .pipe(z.array(creativeLine).max(50)),
});

export type CampaignInput = z.input<typeof campaignInputSchema>;

export async function getCampaign(id: string): Promise<Campaign | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listCampaigns(orgId: string) {
  return db.select().from(campaigns).where(eq(campaigns.orgId, orgId)).orderBy(campaigns.createdAt);
}

function actorFields(actor: Actor) {
  return { actorUserId: actor.id, actorRole: actor.role };
}

export async function createCampaign(
  actor: SessionUser,
  orgId: string,
  raw: CampaignInput,
  resolve: ConnectorResolver = defaultConnectorResolver,
): Promise<Campaign> {
  const input = campaignInputSchema.parse(raw);
  const org = await getOrg(orgId);
  if (!org) throw new DomainError("not_found", "Client not found");
  const allowed = await availableConnectors(orgId, input.platform);
  const connector = input.connector ?? allowed[0]!;
  if (!allowed.includes(connector)) {
    throw new DomainError(
      "connector_unavailable",
      `The ${connector} connector is not available for this client`,
    );
  }
  const dailyBudgetMinor = parseMoneyInput(input.dailyBudget, org.currency);
  if (dailyBudgetMinor <= 0) throw new DomainError("invalid_budget", "Budget must be positive");
  const trackingCode = randomCode(10);

  const conn = await resolve({ orgId, connector, platform: input.platform });
  const { externalId } = await conn.createCampaign({
    name: input.name,
    objective: input.objective,
    dailyBudgetMinor,
    currency: org.currency,
    landingUrl: input.landingUrl,
    trackingCode,
  });

  const [row] = await db
    .insert(campaigns)
    .values({
      orgId,
      name: input.name,
      platform: input.platform,
      objective: input.objective,
      connector,
      status: "draft",
      dailyBudgetMinor,
      currency: org.currency,
      landingUrl: input.landingUrl,
      trackingCode,
      externalId,
      creatives: input.creatives,
      targetingNotes: input.targetingNotes,
      createdByUserId: actor.id,
    })
    .returning();
  await audit({
    ...actorFields(actor),
    orgId,
    action: "campaign.created",
    targetType: "campaign",
    targetId: row!.id,
    metadata: { platform: input.platform, connector, dailyBudgetMinor },
  });
  return row!;
}

export async function updateCampaign(
  actor: SessionUser,
  campaignId: string,
  raw: CampaignInput,
  resolve: ConnectorResolver = defaultConnectorResolver,
) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new DomainError("not_found", "Campaign not found");
  const input = campaignInputSchema.parse({ ...raw, platform: campaign.platform });
  const dailyBudgetMinor = parseMoneyInput(input.dailyBudget, campaign.currency);
  if (dailyBudgetMinor <= 0) throw new DomainError("invalid_budget", "Budget must be positive");
  if (dailyBudgetMinor !== campaign.dailyBudgetMinor && campaign.externalId) {
    const conn = await resolve(campaign);
    const res = await conn.setDailyBudget(
      {
        externalId: campaign.externalId,
        dailyBudgetMinor: campaign.dailyBudgetMinor,
        currency: campaign.currency,
      },
      dailyBudgetMinor,
    );
    if (res.manual) {
      await raiseAlert({
        orgId: campaign.orgId,
        kind: "manual_action_required",
        severity: "warning",
        message: `Set the daily budget of "${campaign.name}" (${campaign.platform}) by hand`,
        data: { campaignId, dailyBudgetMinor },
      });
    }
  }
  await db
    .update(campaigns)
    .set({
      name: input.name,
      objective: input.objective,
      dailyBudgetMinor,
      landingUrl: input.landingUrl,
      targetingNotes: input.targetingNotes,
      creatives: input.creatives,
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));
  await audit({
    ...actorFields(actor),
    orgId: campaign.orgId,
    action: "campaign.updated",
    targetType: "campaign",
    targetId: campaignId,
    metadata: { dailyBudgetMinor },
  });
}

export async function monthToDateSpend(orgId: string, now = new Date()): Promise<number> {
  const period = periodContaining(now);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${adSpendDaily.spendMinor}), 0)` })
    .from(adSpendDaily)
    .where(and(eq(adSpendDaily.orgId, orgId), gte(adSpendDaily.date, period.startDate)));
  return Number(rows[0]?.total ?? 0);
}

/** Why a campaign may not go live right now (null = OK). */
export async function launchBlocker(orgId: string, now = new Date()): Promise<string | null> {
  const org = await getOrg(orgId);
  if (!org) return "Client not found";
  const progress = onboardingProgress(await onboardingFacts(org));
  if (!progress.dashboardUnlocked)
    return "The client has not accepted the performance agreement yet";
  if (!org.paymentMethodReadyAt) return "The client has no payment method on file";
  if (org.dunningPausedAt) return "The client has overdue invoices";
  const intake = await getIntake(orgId);
  if (
    intake &&
    evaluateBudget(await monthToDateSpend(orgId, now), intake.monthlySpendCapMinor) === "reached"
  ) {
    return "This month's ad spend cap has been reached";
  }
  return null;
}

export async function setCampaignStatus(
  actor: Actor,
  campaign: Campaign,
  status: "active" | "paused" | "archived",
  opts: { reason?: PauseReason; resolve?: ConnectorResolver; skipLaunchChecks?: boolean } = {},
): Promise<{ manual: boolean }> {
  const resolve = opts.resolve ?? defaultConnectorResolver;
  if (status === "active" && !opts.skipLaunchChecks) {
    const blocker = await launchBlocker(campaign.orgId);
    if (blocker) throw new DomainError("launch_blocked", blocker);
  }
  let manual = false;
  if (campaign.externalId && campaign.status !== status) {
    const conn = await resolve(campaign);
    const platformStatus = status === "active" ? "active" : "paused";
    if (!(campaign.status !== "active" && platformStatus === "paused")) {
      const res = await conn.setStatus(
        {
          externalId: campaign.externalId,
          dailyBudgetMinor: campaign.dailyBudgetMinor,
          currency: campaign.currency,
        },
        platformStatus,
      );
      manual = res.manual;
    }
  }
  const paused = status !== "active";
  await db
    .update(campaigns)
    .set({
      status,
      pausedReason: paused ? (opts.reason ?? "manual") : null,
      pausedAt: paused ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaign.id));
  if (manual) {
    await raiseAlert({
      orgId: campaign.orgId,
      kind: "manual_action_required",
      severity: "critical",
      message: `${status === "active" ? "Enable" : "Pause"} "${campaign.name}" by hand in ${campaign.platform}`,
      data: { campaignId: campaign.id, status },
    });
  }
  await audit({
    ...actorFields(actor),
    orgId: campaign.orgId,
    action: `campaign.${status}`,
    targetType: "campaign",
    targetId: campaign.id,
    metadata: { reason: opts.reason ?? null, manual },
  });
  return { manual };
}

/**
 * Pauses every active campaign of an org (budget cap, dunning). Failures on one campaign don't
 * stop the others; each failure raises a critical alert because spend continues.
 */
export async function pauseOrgCampaigns(
  orgId: string,
  reason: PauseReason,
  resolve: ConnectorResolver = defaultConnectorResolver,
): Promise<{ paused: number; failed: number }> {
  const active = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.orgId, orgId), eq(campaigns.status, "active")));
  let paused = 0;
  let failed = 0;
  for (const c of active) {
    try {
      await setCampaignStatus(SYSTEM, c, "paused", { reason, resolve });
      paused++;
    } catch (err) {
      failed++;
      logger.error({ err, campaignId: c.id }, "failed to pause campaign");
      await raiseAlert({
        orgId,
        kind: "connector_error",
        severity: "critical",
        message: `Could not pause "${c.name}" (${reason}): ${err instanceof Error ? err.message : "unknown error"}`,
        data: { campaignId: c.id },
      });
    }
  }
  return { paused, failed };
}

/** Pulls spend for one campaign and upserts `ad_spend_daily` (idempotent). */
export async function syncCampaignSpend(
  campaign: Campaign,
  since: Date,
  until: Date,
  resolve: ConnectorResolver = defaultConnectorResolver,
): Promise<number> {
  if (!campaign.externalId) return 0;
  const conn = await resolve(campaign);
  const rows = await conn.fetchDailySpend(
    {
      externalId: campaign.externalId,
      dailyBudgetMinor: campaign.dailyBudgetMinor,
      currency: campaign.currency,
    },
    isoDate(since),
    isoDate(until),
  );
  for (const r of rows) {
    await db
      .insert(adSpendDaily)
      .values({
        orgId: campaign.orgId,
        campaignId: campaign.id,
        date: r.date,
        spendMinor: r.spendMinor,
        currency: campaign.currency,
      })
      .onConflictDoUpdate({
        target: [adSpendDaily.campaignId, adSpendDaily.date],
        set: { spendMinor: r.spendMinor, fetchedAt: new Date() },
      });
  }
  return rows.length;
}

export async function campaignsNeedingSpendSync(since: Date, orgId?: string) {
  const where = [
    inArray(campaigns.status, ["active", "paused"]),
    sql`(${campaigns.status} = 'active' or ${campaigns.pausedAt} >= ${since.toISOString()})`,
  ];
  if (orgId) where.push(eq(campaigns.orgId, orgId));
  return db
    .select()
    .from(campaigns)
    .where(and(...where));
}
