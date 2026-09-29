import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ipRateLimitKey } from "@/lib/client-ip";

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

/** How much larger the one shared bucket for requests without a trusted client IP is. */
export const UNKNOWN_IP_LIMIT_FACTOR = 20;

/**
 * Per-client-IP limit (IPv6 by /64, see `ipRateLimitKey`). When the IP is unknown (`null`):
 * - `"skip"` — for endpoints that ALSO limit per account / org key: those limits still apply, and
 *   unknown clients never share one bucket that a single attacker could exhaust for everyone;
 * - `"shared"` — for endpoints whose only key is the IP: one bucket for all unknown clients with
 *   `UNKNOWN_IP_LIMIT_FACTOR`× the limit, as a global ceiling.
 * Returns `null` when no limit was applied.
 */
export async function rateLimitByIp(
  bucket: string,
  ip: string | null,
  limit: number,
  windowSec: number,
  whenUnknown: "skip" | "shared",
): Promise<RateLimitResult | null> {
  if (ip) return rateLimit(bucket, ipRateLimitKey(ip), limit, windowSec);
  if (whenUnknown === "skip") return null;
  return rateLimit(bucket, "unknown-ip", limit * UNKNOWN_IP_LIMIT_FACTOR, windowSec);
}

export async function purgeExpiredRateLimits(olderThan: Date): Promise<number> {
  const res = await db.execute(
    sql`delete from rate_limits where window_start < ${olderThan.toISOString()}`,
  );
  return res.rowCount ?? 0;
}
