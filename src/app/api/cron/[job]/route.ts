import { NextResponse } from "next/server";
import { env } from "@/env";
import { executeJob, isJobName } from "@/jobs";
import { safeEqual } from "@/lib/crypto";
import { bearerToken, jsonError } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request, ctx: { params: Promise<{ job: string }> }) {
  const token = bearerToken(req.headers);
  if (!env.CRON_SECRET || !token || !safeEqual(token, env.CRON_SECRET))
    return jsonError(401, "unauthorized");
  const { job } = await ctx.params;
  if (!isJobName(job)) return jsonError(404, "unknown_job");
  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? undefined;
  if (period && !/^\d{4}-\d{2}$/.test(period)) return jsonError(400, "invalid_period");
  const result = await executeJob(job, { period });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

/** POST for generic schedulers (GitHub Actions, cron services); GET for Vercel Cron. */
export const POST = run;
export const GET = run;
