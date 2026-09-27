import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  agreements,
  integrations,
  orgIntakes,
  orgInvitations,
  orgMembers,
  organizations,
  user,
  type Agreement,
  type Organization,
} from "@/db/schema";
import { appName, env } from "@/env";
import {
  AGREEMENT_VERSION,
  billingTermsSummary,
  hashAgreement,
  renderAgreement,
} from "@/lib/agreement";
import { generateApiKey, generatePublicKey, randomToken, sha256Hex } from "@/lib/crypto";
import { normalizeCurrency, parseMoneyInput, SUPPORTED_CURRENCIES } from "@/lib/money";
import { onboardingProgress, type OnboardingFacts } from "@/lib/onboarding";
import { normalizeOrigin } from "@/lib/tracking";
import { audit } from "./audit";
import type { SessionUser } from "./guards";
import { sendEmail } from "./mailer";

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const createOrgSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(120),
  currency: z.enum(SUPPORTED_CURRENCIES),
});

export async function createOrganization(
  u: SessionUser,
  input: z.infer<typeof createOrgSchema>,
): Promise<Organization> {
  if (u.role !== "client")
    throw new DomainError("not_client", "Only client accounts can create organizations");
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(eq(orgMembers.userId, u.id))
      .limit(1);
    if (existing.length > 0)
      throw new DomainError("already_member", "You already belong to an organization");
    const [org] = await tx
      .insert(organizations)
      .values({
        name: input.name,
        currency: normalizeCurrency(input.currency),
        publicKey: generatePublicKey(),
        offeredFeeRateBps: env.DEFAULT_FEE_RATE_BPS,
        offeredAttributionWindowDays: env.DEFAULT_ATTRIBUTION_WINDOW_DAYS,
      })
      .returning();
    await tx.insert(orgMembers).values({ orgId: org!.id, userId: u.id, role: "owner" });
    await audit(
      {
        actorUserId: u.id,
        actorRole: u.role,
        orgId: org!.id,
        action: "org.created",
        targetType: "organization",
        targetId: org!.id,
      },
      tx,
    );
    return org!;
  });
}

export async function getOrg(orgId: string): Promise<Organization | null> {
  const rows = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return rows[0] ?? null;
}

export async function getIntake(orgId: string) {
  const rows = await db.select().from(orgIntakes).where(eq(orgIntakes.orgId, orgId)).limit(1);
  return rows[0] ?? null;
}

export async function activeAgreement(orgId: string): Promise<Agreement | null> {
  const rows = await db
    .select()
    .from(agreements)
    .where(and(eq(agreements.orgId, orgId), isNull(agreements.supersededAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function onboardingFacts(org: Organization): Promise<OnboardingFacts> {
  const [intake, agreement, sources] = await Promise.all([
    getIntake(org.id),
    activeAgreement(org.id),
    db
      .select({ kind: integrations.kind })
      .from(integrations)
      .where(
        and(eq(integrations.orgId, org.id), sql`${integrations.kind} in ('shopify','stripe')`),
      ),
  ]);
  return {
    hasOrg: true,
    hasIntake: intake !== null,
    hasAgreement: agreement !== null,
    trackingSeen: org.trackingLastSeenAt !== null,
    revenueSourceConnected: sources.length > 0 || org.apiKeyHash !== null,
    paymentMethodReady: org.paymentMethodReadyAt !== null,
  };
}

export async function onboardingFor(org: Organization) {
  return onboardingProgress(await onboardingFacts(org));
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

const moneyInput = z
  .string()
  .trim()
  .regex(/^\$?\s*[\d,]+(\.\d{1,2})?$/, "Enter an amount like 1500 or 1,500.00");

export const intakeSchema = z.object({
  website: z
    .string()
    .trim()
    .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
    .pipe(z.url({ protocol: /^https?$/, message: "Enter a valid website URL" })),
  productOffer: z.string().trim().min(10, "Tell us a little more (10+ characters)").max(2000),
  averageOrderValue: moneyInput,
  grossMarginPct: z.coerce.number().min(0).max(100),
  targetGeos: z
    .string()
    .trim()
    .min(2, "Add at least one target country or region")
    .transform((v) =>
      v
        .split(/[,\n]/)
        .map((g) => g.trim())
        .filter(Boolean)
        .slice(0, 50),
    ),
  monthlySpendCap: moneyInput,
  creativeAssetLinks: z
    .string()
    .optional()
    .default("")
    .transform((v) =>
      v
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url({ protocol: /^https?$/, message: "Creative links must be URLs" })).max(20)),
});

export type IntakeInput = z.input<typeof intakeSchema>;

export async function saveIntake(org: Organization, u: SessionUser, raw: IntakeInput) {
  const input = intakeSchema.parse(raw);
  const aov = parseMoneyInput(input.averageOrderValue, org.currency);
  const cap = parseMoneyInput(input.monthlySpendCap, org.currency);
  if (aov <= 0) throw new DomainError("invalid_aov", "Average order value must be positive");
  if (cap <= 0) throw new DomainError("invalid_cap", "Monthly ad spend cap must be positive");
  const values = {
    website: input.website,
    productOffer: input.productOffer,
    averageOrderValueMinor: aov,
    grossMarginBps: Math.round(input.grossMarginPct * 100),
    targetGeos: input.targetGeos,
    monthlySpendCapMinor: cap,
    creativeAssetLinks: input.creativeAssetLinks,
    submittedByUserId: u.id,
    updatedAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(orgIntakes)
      .values({ orgId: org.id, ...values })
      .onConflictDoUpdate({ target: orgIntakes.orgId, set: values });
    const origin = normalizeOrigin(input.website);
    if (origin && !org.allowedOrigins.includes(origin)) {
      const www = origin.replace("://", "://www.");
      const additions = origin.includes("://www.") ? [origin] : [origin, www];
      await tx
        .update(organizations)
        .set({
          allowedOrigins: [...new Set([...org.allowedOrigins, ...additions])],
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, org.id));
    }
    await audit(
      {
        actorUserId: u.id,
        actorRole: u.role,
        orgId: org.id,
        action: "intake.saved",
        targetType: "organization",
        targetId: org.id,
        metadata: { monthlySpendCapMinor: cap },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Performance agreement
// ---------------------------------------------------------------------------

export function agreementTermsFor(org: Organization) {
  const terms = {
    appName,
    orgName: org.name,
    feeRateBps: org.offeredFeeRateBps,
    attributionWindowDays: org.offeredAttributionWindowDays,
    currency: org.currency,
    dunningGraceDays: env.DUNNING_GRACE_DAYS,
  };
  const rendered = renderAgreement(terms);
  return { terms, rendered, hash: hashAgreement(rendered), version: AGREEMENT_VERSION };
}

export async function acceptAgreement(p: {
  org: Organization;
  user: SessionUser;
  /** Hash of the text the user was shown; must match the current rendering. */
  shownHash: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<Agreement> {
  const { terms, rendered, hash, version } = agreementTermsFor(p.org);
  if (p.shownHash !== hash) {
    throw new DomainError(
      "terms_changed",
      "The agreement changed while you were reading it. Please review it again.",
    );
  }
  const intake = await getIntake(p.org.id);
  if (!intake) throw new DomainError("intake_missing", "Complete the business details first");
  return db.transaction(async (tx) => {
    await tx
      .update(agreements)
      .set({ supersededAt: new Date() })
      .where(and(eq(agreements.orgId, p.org.id), isNull(agreements.supersededAt)));
    const [row] = await tx
      .insert(agreements)
      .values({
        orgId: p.org.id,
        version,
        feeRateBps: terms.feeRateBps,
        attributionWindowDays: terms.attributionWindowDays,
        billingTerms: billingTermsSummary(terms),
        renderedTerms: rendered,
        termsHash: hash,
        acceptedByUserId: p.user.id,
        acceptedIp: p.ip,
        acceptedUserAgent: p.userAgent?.slice(0, 500) ?? null,
      })
      .returning();
    if (p.org.status === "onboarding") {
      await tx
        .update(organizations)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(organizations.id, p.org.id));
    }
    await audit(
      {
        actorUserId: p.user.id,
        actorRole: p.user.role,
        orgId: p.org.id,
        action: "agreement.accepted",
        targetType: "agreement",
        targetId: row!.id,
        ip: p.ip,
        metadata: { version, feeRateBps: terms.feeRateBps, termsHash: hash },
      },
      tx,
    );
    return row!;
  });
}

export const offerSchema = z.object({
  feeRatePct: z.coerce.number().min(0.01).max(100),
  attributionWindowDays: z.coerce.number().int().min(1).max(90),
});

/** Operators adjust the commercial offer; clients must accept a new agreement version. */
export async function setOffer(
  orgId: string,
  operator: SessionUser,
  raw: z.input<typeof offerSchema>,
) {
  const input = offerSchema.parse(raw);
  const feeRateBps = Math.round(input.feeRatePct * 100);
  await db
    .update(organizations)
    .set({
      offeredFeeRateBps: feeRateBps,
      offeredAttributionWindowDays: input.attributionWindowDays,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));
  await audit({
    actorUserId: operator.id,
    actorRole: operator.role,
    orgId,
    action: "offer.updated",
    targetType: "organization",
    targetId: orgId,
    metadata: { feeRateBps, attributionWindowDays: input.attributionWindowDays },
  });
}

// ---------------------------------------------------------------------------
// Tracking keys
// ---------------------------------------------------------------------------

/** Creates or rotates the org's server-to-server API key. The plaintext is returned ONCE. */
export async function rotateApiKey(org: Organization, u: SessionUser, ip?: string | null) {
  const { key, hash, prefix } = generateApiKey();
  await db
    .update(organizations)
    .set({
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
      apiKeyCreatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, org.id));
  await audit({
    actorUserId: u.id,
    actorRole: u.role,
    orgId: org.id,
    action: org.apiKeyHash ? "api_key.rotated" : "api_key.created",
    targetType: "organization",
    targetId: org.id,
    ip,
    metadata: { prefix },
  });
  return key;
}

export async function findOrgByApiKey(key: string): Promise<Organization | null> {
  if (!/^oa_sk_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.apiKeyHash, sha256Hex(key)))
    .limit(1);
  return rows[0] ?? null;
}

export const originsSchema = z
  .string()
  .transform((v) =>
    v
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).max(20));

export async function setAllowedOrigins(org: Organization, u: SessionUser, raw: string) {
  const list = originsSchema.parse(raw);
  const normalized = list.map((o) => normalizeOrigin(o));
  if (normalized.some((o) => o === null)) {
    throw new DomainError("invalid_origin", "Each origin must look like https://shop.example.com");
  }
  const origins = [...new Set(normalized as string[])];
  await db
    .update(organizations)
    .set({ allowedOrigins: origins, updatedAt: new Date() })
    .where(eq(organizations.id, org.id));
  await audit({
    actorUserId: u.id,
    actorRole: u.role,
    orgId: org.id,
    action: "tracking.origins_updated",
    targetType: "organization",
    targetId: org.id,
    metadata: { origins },
  });
}

// ---------------------------------------------------------------------------
// Members & invitations
// ---------------------------------------------------------------------------

export async function listMembers(orgId: string) {
  return db
    .select({
      id: orgMembers.id,
      role: orgMembers.role,
      name: user.name,
      email: user.email,
      since: orgMembers.createdAt,
    })
    .from(orgMembers)
    .innerJoin(user, eq(orgMembers.userId, user.id))
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(orgMembers.createdAt);
}

export async function listInvitations(orgId: string) {
  return db
    .select()
    .from(orgInvitations)
    .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt)))
    .orderBy(desc(orgInvitations.createdAt));
}

export const INVITE_TTL_DAYS = 7;

export async function inviteMember(org: Organization, inviter: SessionUser, emailRaw: string) {
  const email = z.email().parse(emailRaw.trim().toLowerCase());
  const token = randomToken(32);
  await db.insert(orgInvitations).values({
    orgId: org.id,
    email,
    tokenHash: sha256Hex(token),
    invitedByUserId: inviter.id,
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
  });
  const url = `${env.APP_URL}/invite/${token}`;
  await sendEmail({
    to: email,
    subject: `${inviter.name} invited you to ${org.name} on ${appName}`,
    text: `You've been invited to see ${org.name}'s ad-driven revenue on ${appName}.\n\nAccept the invitation (valid ${INVITE_TTL_DAYS} days): ${url}`,
  });
  await audit({
    actorUserId: inviter.id,
    actorRole: inviter.role,
    orgId: org.id,
    action: "member.invited",
    targetType: "invitation",
  });
  return url;
}

export async function findInvitation(token: string) {
  const rows = await db
    .select({ invitation: orgInvitations, orgName: organizations.name })
    .from(orgInvitations)
    .innerJoin(organizations, eq(orgInvitations.orgId, organizations.id))
    .where(eq(orgInvitations.tokenHash, sha256Hex(token)))
    .limit(1);
  const row = rows[0];
  if (!row || row.invitation.acceptedAt || row.invitation.expiresAt < new Date()) return null;
  return row;
}

export async function acceptInvitation(token: string, u: SessionUser) {
  if (u.role !== "client")
    throw new DomainError("not_client", "Staff accounts cannot join client organizations");
  const found = await findInvitation(token);
  if (!found)
    throw new DomainError("invalid_invitation", "This invitation is invalid or has expired");
  if (found.invitation.email !== u.email.toLowerCase()) {
    throw new DomainError(
      "wrong_account",
      "Sign in with the email address the invitation was sent to",
    );
  }
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(orgMembers).where(eq(orgMembers.userId, u.id)).limit(1);
    if (existing.length > 0)
      throw new DomainError("already_member", "You already belong to an organization");
    await tx
      .insert(orgMembers)
      .values({ orgId: found.invitation.orgId, userId: u.id, role: "member" });
    await tx
      .update(orgInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(orgInvitations.id, found.invitation.id));
    await audit(
      {
        actorUserId: u.id,
        actorRole: u.role,
        orgId: found.invitation.orgId,
        action: "member.joined",
        targetType: "invitation",
        targetId: found.invitation.id,
      },
      tx,
    );
  });
  return found.invitation.orgId;
}
