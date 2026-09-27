import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { adSpendDaily, alerts, campaigns, organizations } from "@/db/schema";
import { runBudgetGuard } from "@/jobs/budget-guard";
import { runSyncSpend } from "@/jobs/sync-spend";
import { SandboxConnector } from "@/lib/connectors/sandbox";
import { isoDate } from "@/lib/dates";
import { outbox } from "@/server/mailer";
import { activeCampaign, createUser, onboardedOrg } from "./helpers";

async function client(cap: string) {
  const owner = await createUser("client");
  const operator = await createUser("operator");
  const { org } = await onboardedOrg(owner, { cap });
  await db
    .update(organizations)
    .set({ paymentMethodReadyAt: new Date() })
    .where(eq(organizations.id, org.id));
  const a = await activeCampaign(operator, org.id, "meta", "100");
  const b = await activeCampaign(operator, org.id, "google", "50");
  return { org, a, b };
}

describe("budget-guard", () => {
  it("pauses every live campaign via the connector once month-to-date spend reaches the cap", async () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const { org, a, b } = await client("300"); // $300 cap
    // $280 already spent earlier this month.
    await db
      .insert(adSpendDaily)
      .values({
        orgId: org.id,
        campaignId: a.id,
        date: "2026-09-10",
        spendMinor: 28_000,
        currency: "USD",
      });

    const sandbox = new SandboxConnector();
    const summary = await runBudgetGuard({ now, resolve: async () => sandbox });
    // Today's refreshed sandbox spend (>= 55% of $150 of daily budgets) pushes MTD over $300.
    expect(summary).toMatchObject({ capReached: 1, campaignsPaused: 2 });
    const rows = await db.select().from(campaigns).where(eq(campaigns.orgId, org.id));
    expect(rows.every((c) => c.status === "paused" && c.pausedReason === "budget_cap")).toBe(true);
    const pauses = sandbox.calls.filter((c) => c.op === "setStatus");
    expect(pauses.map((p) => p.op === "setStatus" && p.externalId).sort()).toEqual(
      [a.externalId, b.externalId].sort(),
    );
    expect(sandbox.calls.some((c) => c.op === "fetchDailySpend" && c.since === "2026-09-20")).toBe(
      true,
    );

    const raised = await db.select().from(alerts).where(eq(alerts.orgId, org.id));
    expect(raised.filter((x) => x.kind === "budget_cap_reached")).toHaveLength(1);
    expect(outbox.some((e) => e.subject.includes("CRITICAL"))).toBe(true);

    // Idempotent: a second hourly run pauses nothing new and raises no duplicate alert.
    const second = await runBudgetGuard({ now, resolve: async () => sandbox });
    expect(second.campaignsPaused).toBe(0);
    expect(
      (await db.select().from(alerts).where(eq(alerts.orgId, org.id))).filter(
        (x) => x.kind === "budget_cap_reached",
      ),
    ).toHaveLength(1);
  });

  it("warns near the cap without pausing", async () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const { org, a } = await client("1000");
    await db
      .insert(adSpendDaily)
      .values({
        orgId: org.id,
        campaignId: a.id,
        date: "2026-09-05",
        spendMinor: 80_000,
        currency: "USD",
      });
    // Connector reports no spend today, so MTD = $920 = 92% of the $1,000 cap.
    await db
      .insert(adSpendDaily)
      .values({
        orgId: org.id,
        campaignId: a.id,
        date: "2026-09-06",
        spendMinor: 12_000,
        currency: "USD",
      });
    const zero = new SandboxConnector();
    zero.fetchDailySpend = async () => [];
    const summary = await runBudgetGuard({ now, resolve: async () => zero });
    expect(summary).toMatchObject({ near: 1, capReached: 0, campaignsPaused: 0 });
    expect((await db.select().from(alerts)).map((x) => x.kind)).toEqual(["budget_cap_near"]);
  });

  it("resumes cap-paused campaigns when a new month starts", async () => {
    const { org, a } = await client("300");
    await db
      .update(campaigns)
      .set({
        status: "paused",
        pausedReason: "budget_cap",
        pausedAt: new Date("2026-08-28T00:00:00Z"),
      })
      .where(eq(campaigns.id, a.id));
    const zero = new SandboxConnector();
    zero.fetchDailySpend = async () => [];
    const summary = await runBudgetGuard({
      now: new Date("2026-09-01T01:05:00Z"),
      resolve: async () => zero,
    });
    expect(summary.campaignsResumed).toBe(1);
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, a.id));
    expect(row).toMatchObject({ status: "active", pausedReason: null });
    expect(zero.calls.some((c) => c.op === "setStatus" && c.status === "active")).toBe(true);
    expect(org.id).toBeTruthy();
  });
});

describe("sync-spend", () => {
  it("upserts daily spend idempotently", async () => {
    const { org } = await client("100000");
    const now = new Date("2026-09-20T04:15:00Z");
    const first = await runSyncSpend({ now, days: 3 });
    expect(first).toMatchObject({
      campaigns: 2,
      rowsUpserted: 6,
      failed: 0,
      since: "2026-09-18",
      until: "2026-09-20",
    });
    await runSyncSpend({ now, days: 3 });
    const rows = await db.select().from(adSpendDaily).where(eq(adSpendDaily.orgId, org.id));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.date))).toEqual(
      new Set(["2026-09-18", "2026-09-19", isoDate(now)]),
    );
  });

  it("raises a connector alert (once per day) when a platform call fails", async () => {
    await client("100000");
    const failing = new SandboxConnector();
    failing.fetchDailySpend = async () => {
      throw new Error("token expired");
    };
    const now = new Date("2026-09-20T04:15:00Z");
    expect(await runSyncSpend({ now, resolve: async () => failing })).toMatchObject({ failed: 2 });
    await runSyncSpend({ now, resolve: async () => failing });
    expect(
      (await db.select().from(alerts)).filter((a) => a.kind === "connector_error"),
    ).toHaveLength(2);
  });
});
