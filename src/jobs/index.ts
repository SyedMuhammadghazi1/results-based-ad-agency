import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";
import { logger } from "@/server/logger";
import { runBudgetGuard } from "./budget-guard";
import { runCleanup } from "./cleanup";
import { runDunningJob } from "./dunning";
import { runMonthlyBilling } from "./monthly-billing";
import { runSyncSpend } from "./sync-spend";
import { runWeeklyRevenueReport } from "./weekly-revenue-report";

export type JobArgs = { now?: Date; period?: string };

/** Recommended schedules (UTC) — see docs/DEPLOYMENT.md and vercel.json. */
export const JOBS = {
  "sync-spend": { schedule: "15 4 * * *", run: (a: JobArgs) => runSyncSpend({ now: a.now }) },
  "budget-guard": { schedule: "5 * * * *", run: (a: JobArgs) => runBudgetGuard({ now: a.now }) },
  "monthly-billing": {
    schedule: "0 6 1 * *",
    run: (a: JobArgs) => runMonthlyBilling({ now: a.now, period: a.period }),
  },
  dunning: { schedule: "30 7 * * *", run: (a: JobArgs) => runDunningJob({ now: a.now }) },
  "weekly-revenue-report": {
    schedule: "0 13 * * 1",
    run: (a: JobArgs) => runWeeklyRevenueReport({ now: a.now }),
  },
  cleanup: { schedule: "45 3 * * *", run: (a: JobArgs) => runCleanup({ now: a.now }) },
} as const;

export type JobName = keyof typeof JOBS;

export function isJobName(name: string): name is JobName {
  return Object.prototype.hasOwnProperty.call(JOBS, name);
}

/** Runs a job and records it in job_runs (status, summary, error). */
export async function executeJob(name: JobName, args: JobArgs = {}) {
  const [run] = await db
    .insert(jobRuns)
    .values({ job: name, status: "running" })
    .returning({ id: jobRuns.id });
  const started = Date.now();
  try {
    const summary = (await JOBS[name].run(args)) as Record<string, unknown>;
    await db
      .update(jobRuns)
      .set({ status: "succeeded", finishedAt: new Date(), summary })
      .where(eq(jobRuns.id, run!.id));
    logger.info({ job: name, ms: Date.now() - started, summary }, "job succeeded");
    return { ok: true as const, job: name, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(jobRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(jobRuns.id, run!.id));
    logger.error({ err, job: name }, "job failed");
    return { ok: false as const, job: name, error: message };
  }
}
