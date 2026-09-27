import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agreements, organizations, user, type Organization, type UserRole } from "@/db/schema";
import { auth } from "@/server/auth";
import { createCampaign, setCampaignStatus, SYSTEM } from "@/server/campaigns";
import type { SessionUser } from "@/server/guards";
import {
  acceptAgreement,
  agreementTermsFor,
  createOrganization,
  getOrg,
  rotateApiKey,
  saveIntake,
} from "@/server/orgs";

export const APP = "http://localhost:3003";
export const SITE = "https://shop.example-a.test";
export const PASSWORD = "correct-horse-battery";

export type TestUser = SessionUser & { headers: Headers };

let counter = 0;

/** Creates a user through Better Auth and returns a session cookie for route handlers. */
export async function createUser(role: UserRole = "client", email?: string): Promise<TestUser> {
  const address = email ?? `user${++counter}-${Date.now()}@example.test`;
  await auth.api.signUpEmail({
    body: { email: address, password: PASSWORD, name: `Test ${counter}` },
  });
  if (role !== "client") await db.update(user).set({ role }).where(eq(user.email, address));
  const res = await auth.api.signInEmail({
    body: { email: address, password: PASSWORD },
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const [row] = await db.select().from(user).where(eq(user.email, address));
  return { id: row!.id, email: address, name: row!.name, role, headers: new Headers({ cookie }) };
}

/** A client org that completed intake + agreement, with an API key and optional campaigns. */
export async function onboardedOrg(
  owner: SessionUser,
  opts: {
    name?: string;
    currency?: "USD" | "EUR";
    cap?: string;
    website?: string;
    feeRatePct?: number;
    agreementAcceptedAt?: Date;
  } = {},
): Promise<{ org: Organization; apiKey: string }> {
  let org = await createOrganization(owner, {
    name: opts.name ?? "Org A",
    currency: opts.currency ?? "USD",
  });
  if (opts.feeRatePct) {
    await db
      .update(organizations)
      .set({ offeredFeeRateBps: Math.round(opts.feeRatePct * 100) })
      .where(eq(organizations.id, org.id));
    org = (await getOrg(org.id))!;
  }
  await saveIntake(org, owner, {
    website: opts.website ?? SITE,
    productOffer: "Handmade leather goods for travellers",
    averageOrderValue: "120",
    grossMarginPct: 60,
    targetGeos: "US, CA",
    monthlySpendCap: opts.cap ?? "10000",
    creativeAssetLinks: "",
  });
  org = (await getOrg(org.id))!;
  const agreement = await acceptAgreement({
    org,
    user: owner,
    shownHash: agreementTermsFor(org).hash,
    ip: "203.0.113.5",
    userAgent: "vitest",
  });
  // Backdate acceptance so tests can record orders in earlier (fixed) months.
  await db
    .update(agreements)
    .set({ acceptedAt: opts.agreementAcceptedAt ?? new Date("2026-01-01T00:00:00Z") })
    .where(eq(agreements.id, agreement.id));
  const apiKey = await rotateApiKey((await getOrg(org.id))!, owner);
  return { org: (await getOrg(org.id))!, apiKey };
}

export async function activeCampaign(
  operator: SessionUser,
  orgId: string,
  platform: "meta" | "google" | "tiktok" = "meta",
  dailyBudget = "100",
) {
  const c = await createCampaign(operator, orgId, {
    name: `${platform} prospecting`,
    platform,
    objective: "sales",
    connector: "sandbox",
    dailyBudget,
    landingUrl: `${SITE}/`,
    targetingNotes: "",
    creatives: "",
  });
  await setCampaignStatus(SYSTEM, c, "active", { skipLaunchChecks: true });
  return { ...c, status: "active" as const };
}

export function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Request(url.startsWith("http") ? url : `${APP}${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function getRequest(path: string, headers?: Headers) {
  return new Request(`${APP}${path}`, { headers });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

export const VISITOR = "visitor_aaaaaaaaaaaaaaaa";
