import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";
import { clientIp } from "@/server/client-ip";
import { rateLimitedResponse } from "@/server/http";
import { rateLimit, rateLimitByIp } from "@/server/rate-limit";

const handlers = toNextJsHandler(auth);

type Rule = { limit: number; windowSec: number };

/**
 * Postgres-backed limits on credential endpoints (works across instances; Better Auth's own
 * in-memory limiter is disabled). Endpoints that name an account are limited per IP AND per
 * account (the email), so guessing one account's password from many IPs is throttled too.
 */
const LIMITS: Array<{ match: RegExp; ip: Rule; account?: Rule & { name: string } }> = [
  {
    match: /\/sign-in\//,
    ip: { limit: 10, windowSec: 60 },
    account: { name: "sign-in", limit: 10, windowSec: 600 },
  },
  {
    match: /\/sign-up\//,
    ip: { limit: 5, windowSec: 60 },
    account: { name: "sign-up", limit: 5, windowSec: 3600 },
  },
  {
    match: /\/(request-password-reset|forget-password)/,
    ip: { limit: 5, windowSec: 300 },
    account: { name: "password-reset", limit: 3, windowSec: 3600 },
  },
  { match: /\/reset-password/, ip: { limit: 5, windowSec: 300 } },
];
const DEFAULT_RULE: Rule = { limit: 60, windowSec: 60 };

/** Email in the request body (JSON, or a form like Better Auth also accepts), normalized. */
async function bodyEmail(req: Request): Promise<string | null> {
  try {
    const type = req.headers.get("content-type") ?? "";
    let email: unknown = null;
    if (
      type.includes("application/x-www-form-urlencoded") ||
      type.includes("multipart/form-data")
    ) {
      email = (await req.clone().formData()).get("email");
    } else {
      const body: unknown = await req.clone().json();
      if (body && typeof body === "object" && "email" in body) email = body.email;
    }
    const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
    return normalized ? normalized.slice(0, 254) : null;
  } catch {
    return null; // Better Auth rejects the malformed body itself.
  }
}

export async function POST(req: Request) {
  const path = new URL(req.url).pathname;
  const rule = LIMITS.find((r) => r.match.test(path));
  const bucket = `auth:${path.split("/").slice(3).join("/")}`;
  const ipRule = rule?.ip ?? DEFAULT_RULE;
  // Without a trusted client IP, account-keyed endpoints rely on the account limit alone rather
  // than one bucket shared with every unknown client.
  const byIp = await rateLimitByIp(
    bucket,
    clientIp(req.headers),
    ipRule.limit,
    ipRule.windowSec,
    rule?.account ? "skip" : "shared",
  );
  if (byIp && !byIp.allowed) return rateLimitedResponse(byIp);
  if (rule?.account) {
    const email = await bodyEmail(req);
    if (email) {
      const { name, limit, windowSec } = rule.account;
      const byAccount = await rateLimit(`auth-account:${name}`, email, limit, windowSec);
      if (!byAccount.allowed) return rateLimitedResponse(byAccount);
    }
  }
  return handlers.POST(req);
}

export const GET = handlers.GET;
