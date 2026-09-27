import { sql } from "drizzle-orm";
import { db } from "@/db";
import { jsonError } from "./http";

/**
 * Postgres-backed fixed-window rate limiter. One row per key; the window resets in the same
 * UPSERT, so it works across any number of app instances without Redis.
 */

export type RateLimitResult = { allowed: boolean; count: number; limit: number; resetAt: Date };

export function windowStart(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export async function rateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSec: number,
  now = new Date(),
): Promise<RateLimitResult> {
  const start = windowStart(now, windowSec);
  const key = `${bucket}:${identifier}`.slice(0, 300);
  const result = await db.execute<{ count: number }>(sql`
    insert into rate_limits (key, window_start, count)
    values (${key}, ${start.toISOString()}, 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start = excluded.window_start
                   then rate_limits.count + 1 else 1 end,
      window_start = excluded.window_start
    returning count
  `);
  const count = Number(result.rows[0]?.count ?? 1);
  return {
    allowed: count <= limit,
    count,
    limit,
    resetAt: new Date(start.getTime() + windowSec * 1000),
  };
}

export function rateLimitedResponse(r: RateLimitResult, extraHeaders?: HeadersInit) {
  const retryAfter = Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000));
  return jsonError(429, "rate_limited", "Too many requests", {
    "retry-after": String(retryAfter),
    ...Object.fromEntries(new Headers(extraHeaders).entries()),
  });
}

export async function purgeExpiredRateLimits(olderThan: Date): Promise<number> {
  const res = await db.execute(
    sql`delete from rate_limits where window_start < ${olderThan.toISOString()}`,
  );
  return res.rowCount ?? 0;
}
