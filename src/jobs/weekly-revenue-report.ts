import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agreements, emailSends, orgMembers, organizations, user } from "@/db/schema";
import { appName, env } from "@/env";
import { addDays, isoDate, startOfUtcDay } from "@/lib/dates";
import { formatMinor } from "@/lib/money";
import { describeTrend, revenueTrend } from "@/lib/reporting";
import { logger } from "@/server/logger";
import { sendEmail } from "@/server/mailer";
import { netAttributedRevenue } from "@/server/reports";

/**
 * Weekly: emails every member of each active client ONE number — attributed revenue over the last
 * 7 full UTC days — and the trend vs the 7 days before. Idempotent per org per week.
 */
export async function runWeeklyRevenueReport(opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const end = startOfUtcDay(now);
  const start = addDays(end, -7);
  const prevStart = addDays(end, -14);
  const periodKey = `week-ending-${isoDate(addDays(end, -1))}`;

  const orgs = await db
    .select({ org: organizations })
    .from(organizations)
    .innerJoin(
      agreements,
      and(eq(agreements.orgId, organizations.id), isNull(agreements.supersededAt)),
    );

  let sent = 0;
  let skipped = 0;
  for (const { org } of orgs) {
    const members = await db
      .select({ email: user.email })
      .from(orgMembers)
      .innerJoin(user, eq(orgMembers.userId, user.id))
      .where(eq(orgMembers.orgId, org.id));
    if (members.length === 0) continue;

    const claimed = await db
      .insert(emailSends)
      .values({ orgId: org.id, kind: "weekly_revenue", periodKey, recipients: members.length })
      .onConflictDoNothing()
      .returning({ id: emailSends.id });
    if (claimed.length === 0) {
      skipped++;
      continue;
    }

    const [current, previous] = await Promise.all([
      netAttributedRevenue(org.id, start, end),
      netAttributedRevenue(org.id, prevStart, start),
    ]);
    const trend = revenueTrend(current, previous);
    const amount = formatMinor(current, org.currency);
    try {
      await sendEmail({
        to: members.map((m) => m.email),
        subject: `${org.name}: ${amount} in ad-driven revenue this week`,
        text: [
          `Attributed revenue, ${isoDate(start)} to ${isoDate(addDays(end, -1))}:`,
          ``,
          `  ${amount}`,
          ``,
          `That's ${describeTrend(trend)}.`,
          ``,
          `Every attributed order is listed in your dashboard: ${env.APP_URL}/dashboard`,
          ``,
          `— ${appName}`,
        ].join("\n"),
      });
      sent++;
    } catch (err) {
      logger.error({ err, orgId: org.id }, "weekly report email failed; will retry next run");
      await db.delete(emailSends).where(eq(emailSends.id, claimed[0]!.id));
    }
  }
  return { periodKey, orgs: orgs.length, sent, skipped };
}
