import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  alerts,
  applications,
  auditLog,
  billingPeriods,
  campaigns,
  orgIntakes,
  organizations,
  user,
  type UserRole,
} from "@/db/schema";
import { env } from "@/env";
import { evaluateBudget, pacing, roas } from "@/lib/budget";
import { addDays, dateRange, isoDate, periodContaining, startOfUtcDay } from "@/lib/dates";
import { isOverdue } from "@/lib/dunning";
import { fillDailySeries } from "@/lib/reporting";
import { audit } from "./audit";
import type { SessionUser } from "./guards";
import { onboardingFor } from "./orgs";
import { dailyNetRevenue, dailySpend, netAttributedRevenue, spendBetween } from "./reports";

export async function listClientOrgs(now = new Date()) {
  const orgs = await db.select().from(organizations).orderBy(organizations.name);
  const month = periodContaining(now);
  const nextMonth = isoDate(month.end);
  const intakes = await db.select().from(orgIntakes);
  const capByOrg = new Map(intakes.map((i) => [i.orgId, i.monthlySpendCapMinor]));
  const activeCampaigns = await db
    .select({ orgId: campaigns.orgId, n: count() })
    .from(campaigns)
    .where(eq(campaigns.status, "active"))
    .groupBy(campaigns.orgId);
  const openAlerts = await db
    .select({ orgId: alerts.orgId, n: count() })
    .from(alerts)
    .where(isNull(alerts.resolvedAt))
    .groupBy(alerts.orgId);

  return Promise.all(
    orgs.map(async (org) => {
      const [revenue, spend, progress] = await Promise.all([
        netAttributedRevenue(org.id, month.start, month.end),
        spendBetween(org.id, month.startDate, nextMonth),
        onboardingFor(org),
      ]);
      const cap = capByOrg.get(org.id) ?? null;
      return {
        org,
        onboarding: progress,
        revenueMtdMinor: revenue,
        spendMtdMinor: spend,
        roas: roas(revenue, spend),
        capMinor: cap,
        budgetState: cap ? evaluateBudget(spend, cap) : null,
        pacing: cap ? pacing(now, spend, cap) : null,
        activeCampaigns: Number(activeCampaigns.find((a) => a.orgId === org.id)?.n ?? 0),
        openAlerts: Number(openAlerts.find((a) => a.orgId === org.id)?.n ?? 0),
      };
    }),
  );
}

export async function orgPerformance(orgId: string, now = new Date()) {
  const today = startOfUtcDay(now);
  const since = addDays(today, -29);
  const until = addDays(today, 1);
  const [rev, spend] = await Promise.all([
    dailyNetRevenue(orgId, since, until),
    dailySpend(orgId, isoDate(since), isoDate(until)),
  ]);
  const dates = dateRange(since, today);
  const revenue = fillDailySeries(rev, dates);
  const spendSeries = fillDailySeries(spend, dates);
  const totalRevenue = revenue.reduce((s, d) => s + d.amountMinor, 0);
  const totalSpend = spendSeries.reduce((s, d) => s + d.amountMinor, 0);
  return {
    dates,
    revenue,
    spend: spendSeries,
    totalRevenueMinor: totalRevenue,
    totalSpendMinor: totalSpend,
    roas: roas(totalRevenue, totalSpend),
  };
}

export async function billingOverview(now = new Date()) {
  const rows = await db
    .select({ period: billingPeriods, orgName: organizations.name })
    .from(billingPeriods)
    .innerJoin(organizations, eq(billingPeriods.orgId, organizations.id))
    .orderBy(desc(billingPeriods.periodStart), organizations.name)
    .limit(500);
  return rows.map((r) => ({
    ...r,
    overdue: isOverdue(r.period, now, env.DUNNING_GRACE_DAYS),
  }));
}

export async function listAlerts(opts: { open?: boolean; orgId?: string; limit?: number } = {}) {
  return db
    .select({ alert: alerts, orgName: organizations.name })
    .from(alerts)
    .leftJoin(organizations, eq(alerts.orgId, organizations.id))
    .where(
      and(
        opts.open ? isNull(alerts.resolvedAt) : undefined,
        opts.orgId ? eq(alerts.orgId, opts.orgId) : undefined,
      ),
    )
    .orderBy(desc(alerts.createdAt))
    .limit(opts.limit ?? 200);
}

export async function resolveAlert(alertId: string, operator: SessionUser) {
  await db
    .update(alerts)
    .set({ resolvedAt: new Date(), resolvedByUserId: operator.id })
    .where(and(eq(alerts.id, alertId), isNull(alerts.resolvedAt)));
  await audit({
    actorUserId: operator.id,
    actorRole: operator.role,
    action: "alert.resolved",
    targetType: "alert",
    targetId: alertId,
  });
}

export async function auditEntries(opts: { orgId?: string; limit?: number } = {}) {
  return db
    .select({ entry: auditLog, actorEmail: user.email, orgName: organizations.name })
    .from(auditLog)
    .leftJoin(user, eq(auditLog.actorUserId, user.id))
    .leftJoin(organizations, eq(auditLog.orgId, organizations.id))
    .where(opts.orgId ? eq(auditLog.orgId, opts.orgId) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(opts.limit ?? 200);
}

export async function listApplications() {
  return db.select().from(applications).orderBy(desc(applications.createdAt)).limit(200);
}

export async function listStaff() {
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(inArray(user.role, ["operator", "admin"]))
    .orderBy(user.createdAt);
}

/** Admin-only: change a user's role. Admins cannot demote themselves (avoid lock-out). */
export async function setUserRole(admin: SessionUser, email: string, role: UserRole) {
  const rows = await db
    .select()
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1);
  const target = rows[0];
  if (!target) return { ok: false as const, message: "No user with that email" };
  if (target.id === admin.id)
    return { ok: false as const, message: "You cannot change your own role" };
  if (role !== "client") {
    // Staff must not also be members of a client org.
    const [m] = await db
      .execute<{ n: number }>(
        sql`select count(*)::int as n from org_members where user_id = ${target.id}`,
      )
      .then((r) => r.rows);
    if ((m?.n ?? 0) > 0)
      return { ok: false as const, message: "That user belongs to a client organization" };
  }
  await db.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, target.id));
  await audit({
    actorUserId: admin.id,
    actorRole: admin.role,
    action: "user.role_changed",
    targetType: "user",
    targetId: target.id,
    metadata: { from: target.role, to: role },
  });
  return { ok: true as const, message: `${target.email} is now ${role}` };
}
