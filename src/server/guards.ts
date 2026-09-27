import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { organizations, orgMembers, type Organization, type UserRole } from "@/db/schema";
import { auth } from "./auth";
import { forbidden, unauthorized } from "./http";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
};

export type Membership = {
  user: SessionUser;
  org: Organization;
  memberRole: "owner" | "member";
};

function toSessionUser(u: {
  id: string;
  email: string;
  name: string;
  role?: unknown;
}): SessionUser {
  const role = u.role === "operator" || u.role === "admin" ? u.role : "client";
  return { id: u.id, email: u.email, name: u.name, role };
}

export async function getSessionUserFromHeaders(h: Headers): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers: h });
  return s ? toSessionUser(s.user) : null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  return getSessionUserFromHeaders(await headers());
}

export async function findMembership(userId: string): Promise<Omit<Membership, "user"> | null> {
  const rows = await db
    .select({ org: organizations, memberRole: orgMembers.role })
    .from(orgMembers)
    .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.orgId, orgId)))
    .limit(1);
  return rows.length > 0;
}

// ----- Pages & server actions (redirect on failure) -------------------------

export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) redirect("/sign-in");
  return u;
}

export async function requireRole(roles: UserRole[]): Promise<SessionUser> {
  const u = await requireUser();
  if (!roles.includes(u.role)) redirect(u.role === "client" ? "/dashboard" : "/operator");
  return u;
}

export const requireOperator = () => requireRole(["operator", "admin"]);
export const requireAdmin = () => requireRole(["admin"]);

/** Client user with an organization; redirects into onboarding otherwise. */
export async function requireMembership(): Promise<Membership> {
  const u = await requireRole(["client"]);
  const m = await findMembership(u.id);
  if (!m) redirect("/onboarding/organization");
  return { user: u, ...m };
}

export async function requireOrgOwner(): Promise<Membership> {
  const m = await requireMembership();
  if (m.memberRole !== "owner") redirect("/dashboard");
  return m;
}

// ----- Route handlers (throw ApiError on failure) ---------------------------

export async function apiRequireUser(h: Headers): Promise<SessionUser> {
  const u = await getSessionUserFromHeaders(h);
  if (!u) throw unauthorized();
  return u;
}

export async function apiRequireRole(h: Headers, roles: UserRole[]): Promise<SessionUser> {
  const u = await apiRequireUser(h);
  if (!roles.includes(u.role)) throw forbidden();
  return u;
}

export async function apiRequireMembership(h: Headers): Promise<Membership> {
  const u = await apiRequireRole(h, ["client"]);
  const m = await findMembership(u.id);
  if (!m) throw forbidden();
  return { user: u, ...m };
}
