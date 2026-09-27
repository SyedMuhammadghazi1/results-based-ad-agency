import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";
import { clientIp } from "@/server/http";
import { rateLimit, rateLimitedResponse } from "@/server/rate-limit";

const handlers = toNextJsHandler(auth);

/** Postgres-backed limits on credential endpoints (works across instances). */
const LIMITS: Array<{ match: RegExp; limit: number; windowSec: number }> = [
  { match: /\/sign-in\//, limit: 10, windowSec: 60 },
  { match: /\/sign-up\//, limit: 5, windowSec: 60 },
  { match: /\/(request-password-reset|forget-password|reset-password)/, limit: 5, windowSec: 300 },
];

export async function POST(req: Request) {
  const path = new URL(req.url).pathname;
  const rule = LIMITS.find((r) => r.match.test(path)) ?? { limit: 60, windowSec: 60 };
  const bucket = `auth:${path.split("/").slice(3).join("/")}`;
  const res = await rateLimit(bucket, clientIp(req.headers), rule.limit, rule.windowSec);
  if (!res.allowed) return rateLimitedResponse(res);
  return handlers.POST(req);
}

export const GET = handlers.GET;
