import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  integrations,
  organizations,
  type Integration,
  type IntegrationKind,
  type Organization,
} from "@/db/schema";
import { env } from "@/env";
import { audit } from "./audit";
import type { SessionUser } from "./guards";
import { decrypt, encrypt } from "./keyring";

export async function listIntegrations(orgId: string): Promise<Integration[]> {
  return db.select().from(integrations).where(eq(integrations.orgId, orgId));
}

export async function getIntegration(orgId: string, kind: IntegrationKind) {
  const rows = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.kind, kind)))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertIntegration(
  orgId: string,
  kind: IntegrationKind,
  values: { secret?: string; config?: Record<string, string>; status?: Integration["status"] },
) {
  const set = {
    ...(values.secret !== undefined ? { encryptedSecret: encrypt(values.secret) } : {}),
    ...(values.config !== undefined ? { config: values.config } : {}),
    status: values.status ?? "pending",
    lastError: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(integrations)
    .values({ orgId, kind, ...set })
    .onConflictDoUpdate({ target: [integrations.orgId, integrations.kind], set })
    .returning();
  return row!;
}

export function webhookUrl(integration: Pick<Integration, "id" | "kind">): string {
  const base = env.APP_URL.replace(/\/$/, "");
  return integration.kind === "shopify"
    ? `${base}/api/webhooks/shopify/${integration.id}`
    : `${base}/api/webhooks/client-stripe/${integration.id}`;
}

export const shopifySchema = z.object({
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, "Use your store's .myshopify.com domain"),
  webhookSecret: z
    .string()
    .trim()
    .min(16, "Paste the webhook signing secret from Shopify")
    .max(200),
});

export async function saveShopify(
  org: Organization,
  u: SessionUser,
  raw: z.input<typeof shopifySchema>,
) {
  const input = shopifySchema.parse(raw);
  const row = await upsertIntegration(org.id, "shopify", {
    secret: input.webhookSecret,
    config: { shopDomain: input.shopDomain },
  });
  await audit({
    actorUserId: u.id,
    actorRole: u.role,
    orgId: org.id,
    action: "integration.shopify_saved",
    targetType: "integration",
    targetId: row.id,
  });
  return row;
}

export const clientStripeSchema = z.object({
  signingSecret: z
    .string()
    .trim()
    .regex(/^whsec_[A-Za-z0-9]+$/, "Stripe signing secrets start with whsec_"),
});

export async function saveClientStripe(
  org: Organization,
  u: SessionUser,
  raw: z.input<typeof clientStripeSchema>,
) {
  const input = clientStripeSchema.parse(raw);
  const row = await upsertIntegration(org.id, "stripe", {
    secret: input.signingSecret,
    config: {},
  });
  await audit({
    actorUserId: u.id,
    actorRole: u.role,
    orgId: org.id,
    action: "integration.stripe_saved",
    targetType: "integration",
    targetId: row.id,
  });
  return row;
}

/** Reserves the integration row (so its webhook URL can be shown) before the secret exists. */
export async function ensureIntegrationRow(orgId: string, kind: "shopify" | "stripe") {
  const existing = await getIntegration(orgId, kind);
  if (existing) return existing;
  const [row] = await db
    .insert(integrations)
    .values({ orgId, kind, status: "pending" })
    .onConflictDoNothing()
    .returning();
  return row ?? (await getIntegration(orgId, kind))!;
}

/** Loads an integration + its org + decrypted secret for webhook verification. */
export async function loadWebhookIntegration(integrationId: string, kind: "shopify" | "stripe") {
  if (!/^[0-9a-f-]{36}$/i.test(integrationId)) return null;
  const rows = await db
    .select({ integration: integrations, org: organizations })
    .from(integrations)
    .innerJoin(organizations, eq(integrations.orgId, organizations.id))
    .where(and(eq(integrations.id, integrationId), eq(integrations.kind, kind)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.integration.encryptedSecret) return null;
  return { ...row, secret: decrypt(row.integration.encryptedSecret) };
}

export async function markIntegrationEvent(integrationId: string) {
  await db
    .update(integrations)
    .set({ lastEventAt: new Date(), status: "connected", lastError: null })
    .where(eq(integrations.id, integrationId));
}

// ----- Ad-platform OAuth tokens -------------------------------------------

export async function saveAdPlatformToken(
  orgId: string,
  kind: "meta_ads" | "google_ads",
  token: string,
  actor: SessionUser,
) {
  const existing = await getIntegration(orgId, kind);
  const row = await upsertIntegration(orgId, kind, {
    secret: token,
    config: existing?.config ?? {},
    status: existing?.config?.accountId ? "connected" : "pending",
  });
  await audit({
    actorUserId: actor.id,
    actorRole: actor.role,
    orgId,
    action: `integration.${kind}_connected`,
    targetType: "integration",
    targetId: row.id,
  });
  return row;
}

export const adAccountSchema = z.object({
  accountId: z
    .string()
    .trim()
    .transform((v) => v.replace(/^act_/, "").replace(/-/g, ""))
    .pipe(z.string().regex(/^\d{5,20}$/, "Enter the numeric account id")),
  loginCustomerId: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/-/g, "") : undefined))
    .pipe(
      z
        .string()
        .regex(/^\d{10}$/)
        .optional(),
    ),
});

export async function setAdAccount(
  orgId: string,
  kind: "meta_ads" | "google_ads",
  raw: z.input<typeof adAccountSchema>,
  actor: SessionUser,
) {
  const input = adAccountSchema.parse(raw);
  const existing = await getIntegration(orgId, kind);
  const config: Record<string, string> = {
    ...(existing?.config ?? {}),
    accountId: input.accountId,
  };
  if (input.loginCustomerId) config.loginCustomerId = input.loginCustomerId;
  await upsertIntegration(orgId, kind, {
    config,
    status: existing?.encryptedSecret ? "connected" : "pending",
  });
  await audit({
    actorUserId: actor.id,
    actorRole: actor.role,
    orgId,
    action: `integration.${kind}_account_set`,
    targetType: "integration",
    metadata: { accountId: input.accountId },
  });
}
