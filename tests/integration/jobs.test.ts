import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { emailSends, jobRuns, pendingRefunds } from "@/db/schema";
import { executeJob } from "@/jobs";
import { runCleanup } from "@/jobs/cleanup";
import { runWeeklyRevenueReport } from "@/jobs/weekly-revenue-report";
import { addDays } from "@/lib/dates";
import { recordConversion } from "@/server/conversions";
import { outbox } from "@/server/mailer";
import { acceptInvitation, inviteMember } from "@/server/orgs";
import { ingestTouch } from "@/server/tracking";
import { activeCampaign, createUser, onboardedOrg, SITE } from "./helpers";

describe("weekly-revenue-report", () => {
  it("emails every member one number plus the trend, once per week", async () => {
    const owner = await createUser("client");
    const operator = await createUser("operator");
    const { org } = await onboardedOrg(owner, { name: "Weekly Co" });
    await inviteMember(org, owner, "member@example.test");
    const token = outbox.at(-1)!.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1]!;
    await acceptInvitation(token, await createUser("client", "member@example.test"));
    const campaign = await activeCampaign(operator, org.id);

    const order = async (id: string, amountMinor: number, at: Date) => {
      const vid = `weekly_visitor_${id}`.padEnd(20, "0");
      await ingestTouch(
        { pk: org.publicKey, vid, type: "touch", params: { oa_cid: campaign.trackingCode } },
        SITE,
        new Date(at.getTime() - 60_000),
      );
      await recordConversion(org, "api", {
        kind: "conversion",
        externalOrderId: id,
        occurredAt: at,
        amountMinor,
        currency: "USD",
        visitorId: vid,
      });
    };
    // Report runs Monday 2026-09-21 → covers Sep 14–20; previous week Sep 7–13.
    await order("w1", 150_000, new Date("2026-09-15T10:00:00Z"));
    await order("w2", 90_000, new Date("2026-09-20T23:00:00Z"));
    await order("p1", 200_000, new Date("2026-09-08T10:00:00Z"));
    await order("next", 999_999, new Date("2026-09-21T10:00:00Z")); // after the window
    outbox.length = 0;

    const now = new Date("2026-09-21T13:00:00Z");
    expect(await runWeeklyRevenueReport({ now })).toMatchObject({
      periodKey: "week-ending-2026-09-20",
      sent: 1,
    });
    expect(outbox).toHaveLength(1);
    const email = outbox[0]!;
    expect(email.to).toEqual(expect.arrayContaining([owner.email, "member@example.test"]));
    expect(email.subject).toBe("Weekly Co: $2,400.00 in ad-driven revenue this week");
    expect(email.text).toContain("up 20% vs the previous 7 days");
    // No internal metrics in client emails.
    expect(email.text).not.toMatch(/spend|roas|click|impression/i);

    expect(await runWeeklyRevenueReport({ now })).toMatchObject({ sent: 0, skipped: 1 });
    expect(outbox).toHaveLength(1);
    expect(await db.select().from(emailSends)).toHaveLength(1);
  });
});

describe("job runner", () => {
  it("records runs in job_runs", async () => {
    const res = await executeJob("cleanup");
    expect(res.ok).toBe(true);
    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ job: "cleanup", status: "succeeded" });
    expect(run!.finishedAt).not.toBeNull();
  });
});

describe("cleanup", () => {
  it("expires refunds whose order never arrived within 90 days", async () => {
    const owner = await createUser("client");
    const { org } = await onboardedOrg(owner);
    const now = new Date("2026-09-29T03:45:00Z");
    const pending = (id: string, receivedAt: Date) => ({
      orgId: org.id,
      source: "shopify" as const,
      externalOrderId: `order-${id}`,
      externalRefundId: id,
      kind: "refund" as const,
      amountMinor: 1_000,
      currency: "USD",
      occurredAt: receivedAt,
      receivedAt,
    });
    await db
      .insert(pendingRefunds)
      .values([pending("old", addDays(now, -91)), pending("recent", addDays(now, -89))]);
    expect(await runCleanup({ now })).toMatchObject({ expiredPendingRefunds: 1 });
    const left = await db.select().from(pendingRefunds);
    expect(left.map((r) => r.externalRefundId)).toEqual(["recent"]);
  });
});
