import { lt } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, pendingRefunds, session, verification, webhookEvents } from "@/db/schema";
import { addDays } from "@/lib/dates";
import { PENDING_REFUND_TTL_DAYS } from "@/server/conversions";
import { purgeExpiredRateLimits } from "@/server/rate-limit";

/**
 * Daily housekeeping: expired sessions/verification tokens, stale limiter rows, old logs, and
 * refunds whose order never arrived (e.g. orders from before tracking was installed).
 */
export async function runCleanup(opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const rateLimits = await purgeExpiredRateLimits(addDays(now, -1));
  const sessions = await db.delete(session).where(lt(session.expiresAt, now));
  const verifications = await db.delete(verification).where(lt(verification.expiresAt, now));
  const webhooks = await db
    .delete(webhookEvents)
    .where(lt(webhookEvents.processedAt, addDays(now, -90)));
  const runs = await db.delete(jobRuns).where(lt(jobRuns.startedAt, addDays(now, -90)));
  const refunds = await db
    .delete(pendingRefunds)
    .where(lt(pendingRefunds.receivedAt, addDays(now, -PENDING_REFUND_TTL_DAYS)));
  return {
    rateLimits,
    sessions: sessions.rowCount ?? 0,
    verifications: verifications.rowCount ?? 0,
    webhookEvents: webhooks.rowCount ?? 0,
    jobRuns: runs.rowCount ?? 0,
    expiredPendingRefunds: refunds.rowCount ?? 0,
  };
}
