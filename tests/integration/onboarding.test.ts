import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { POST as platformStripePOST } from "@/app/api/webhooks/stripe/route";
import { db } from "@/db";
import { agreements, auditLog, integrations, orgMembers, organizations } from "@/db/schema";
import { buildKeyring, decryptSecret, envelopeKeyId, sha256Hex } from "@/lib/crypto";
import { onboardingProgress } from "@/lib/onboarding";
import { startPaymentMethodSetup } from "@/server/billing";
import { launchBlocker } from "@/server/campaigns";
import { saveShopify } from "@/server/integrations";
import { keyring } from "@/server/keyring";
import { outbox } from "@/server/mailer";
import {
  acceptAgreement,
  acceptInvitation,
  agreementTermsFor,
  createOrganization,
  DomainError,
  getOrg,
  inviteMember,
  onboardingFacts,
  saveIntake,
} from "@/server/orgs";
import { reencryptAllSecrets } from "@/server/secrets-rotation";
import { signStripePayload, type StripeClient } from "@/server/stripe";
import { createUser, SITE } from "./helpers";

const intake = {
  website: "shop.example-a.test",
  productOffer: "Handmade leather goods for travellers",
  averageOrderValue: "1,250.50",
  grossMarginPct: 55.5,
  targetGeos: "US, CA\nUK",
  monthlySpendCap: "$20,000",
  creativeAssetLinks: "https://drive.example.com/a https://drive.example.com/b",
};

describe("client onboarding", () => {
  it("walks org → intake → agreement and records who accepted which terms, when and from where", async () => {
    const owner = await createUser("client");
    let org = await createOrganization(owner, { name: "Acme", currency: "USD" });
    await expect(
      createOrganization(owner, { name: "Second", currency: "USD" }),
    ).rejects.toBeInstanceOf(DomainError);

    await saveIntake(org, owner, intake);
    org = (await getOrg(org.id))!;
    expect(org.allowedOrigins).toEqual([
      "https://shop.example-a.test",
      "https://www.shop.example-a.test",
    ]);

    // Accepting terms other than the ones currently rendered is refused.
    await expect(
      acceptAgreement({ org, user: owner, shownHash: "stale", ip: "203.0.113.9", userAgent: "UA" }),
    ).rejects.toMatchObject({ code: "terms_changed" });

    const offer = agreementTermsFor(org);
    const a = await acceptAgreement({
      org,
      user: owner,
      shownHash: offer.hash,
      ip: "203.0.113.9",
      userAgent: "UA/1.0",
    });
    expect(a).toMatchObject({
      version: offer.version,
      feeRateBps: 1000,
      attributionWindowDays: 7,
      acceptedByUserId: owner.id,
      acceptedIp: "203.0.113.9",
      acceptedUserAgent: "UA/1.0",
      termsHash: sha256Hex(a.renderedTerms),
    });
    expect(a.renderedTerms).toContain("Acme");
    expect((await getOrg(org.id))!.status).toBe("active");
    const actions = (await db.select().from(auditLog)).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["org.created", "intake.saved", "agreement.accepted"]),
    );

    // Re-accepting (e.g. a new version) supersedes the old row; only one is in force.
    await acceptAgreement({ org, user: owner, shownHash: offer.hash, ip: null, userAgent: null });
    const rows = await db.select().from(agreements).where(eq(agreements.orgId, org.id));
    expect(rows.filter((r) => r.supersededAt === null)).toHaveLength(1);

    const progress = onboardingProgress(await onboardingFacts((await getOrg(org.id))!));
    expect(progress).toMatchObject({ dashboardUnlocked: true, readyToLaunch: false });
    expect(progress.next?.id).toBe("tracking");
    expect(await launchBlocker(org.id)).toMatch(/payment method/);
  });

  it("stores intake money as integer minor units", async () => {
    const owner = await createUser("client");
    const org = await createOrganization(owner, { name: "Acme", currency: "USD" });
    await saveIntake(org, owner, intake);
    const { orgIntakes } = await import("@/db/schema");
    const [row] = await db.select().from(orgIntakes);
    expect(row).toMatchObject({
      averageOrderValueMinor: 125_050,
      monthlySpendCapMinor: 2_000_000,
      grossMarginBps: 5550,
    });
    expect(row!.targetGeos).toEqual(["US", "CA", "UK"]);
    await expect(saveIntake(org, owner, { ...intake, monthlySpendCap: "abc" })).rejects.toThrow();
  });

  it("invites a teammate who joins the same org (only with the invited email)", async () => {
    const owner = await createUser("client");
    const org = await createOrganization(owner, { name: "Acme", currency: "USD" });
    await inviteMember(org, owner, "Teammate@Example.test");
    const link = outbox
      .find((e) => e.subject.includes("invited you"))!
      .text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1]!;

    const stranger = await createUser("client", "stranger@example.test");
    await expect(acceptInvitation(link, stranger)).rejects.toMatchObject({ code: "wrong_account" });
    const teammate = await createUser("client", "teammate@example.test");
    expect(await acceptInvitation(link, teammate)).toBe(org.id);
    const [m] = await db.select().from(orgMembers).where(eq(orgMembers.userId, teammate.id));
    expect(m).toMatchObject({ orgId: org.id, role: "member" });
    await expect(acceptInvitation(link, teammate)).rejects.toMatchObject({
      code: "invalid_invitation",
    });
  });

  it("adds a payment method through Stripe Checkout in setup mode (Stripe mocked at the SDK)", async () => {
    const owner = await createUser("client");
    const org = await createOrganization(owner, { name: "Acme", currency: "EUR" });
    const stripe = {
      customers: {
        create: vi.fn(async () => ({ id: "cus_new" })),
        update: vi.fn(async () => ({})),
      },
      checkout: {
        sessions: {
          create: vi.fn(async () => ({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" })),
          retrieve: vi.fn(),
        },
      },
      setupIntents: {
        retrieve: vi.fn(async () => ({
          id: "seti_1",
          status: "succeeded",
          payment_method: "pm_1",
        })),
      },
      invoices: {},
      invoiceItems: {},
    };
    const { url } = await startPaymentMethodSetup(org, owner, stripe as unknown as StripeClient);
    expect(url).toBe("https://checkout.stripe.test/cs_1");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "setup",
        customer: "cus_new",
        currency: "eur",
        metadata: { orgId: org.id },
      }),
    );
    expect((await getOrg(org.id))!.stripeCustomerId).toBe("cus_new");

    // checkout.session.completed arrives on the platform webhook.
    const { handlePlatformStripeEvent } = await import("@/server/billing");
    const event = {
      id: "evt_setup_1",
      object: "event",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_1",
          mode: "setup",
          status: "complete",
          customer: "cus_new",
          setup_intent: "seti_1",
          metadata: { orgId: org.id },
        },
      },
    };
    await handlePlatformStripeEvent(event as never, stripe as unknown as StripeClient);
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_new", {
      invoice_settings: { default_payment_method: "pm_1" },
    });
    expect((await getOrg(org.id))!.paymentMethodReadyAt).not.toBeNull();
    // The route verifies signatures before anything else.
    const raw = JSON.stringify(event);
    const bad = await platformStripePOST(
      new Request("http://localhost:3003/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=bad" },
        body: raw,
      }),
    );
    expect(bad.status).toBe(400);
    expect(signStripePayload(raw, "whsec_x")).toMatch(/^t=\d+,v1=/);
  });
});

describe("secret rotation", () => {
  it("re-encrypts integration secrets with the new key while old envelopes stay readable", async () => {
    const owner = await createUser("client");
    const org = await createOrganization(owner, { name: "Acme", currency: "USD" });
    await saveShopify(org, owner, {
      shopDomain: "acme.myshopify.com",
      webhookSecret: "shpss_rotate_me_0123456789",
    });
    const [before] = await db.select().from(integrations);
    expect(envelopeKeyId(before!.encryptedSecret!)).toBe("t1");

    const current = keyring();
    const newKey = randomBytes(32).toString("base64");
    const oldKey = current.keys.get("t1")!.toString("base64");
    const rotated = buildKeyring("t2", newKey, `t1:${oldKey}`);
    expect(await reencryptAllSecrets(rotated)).toEqual({ total: 1, rotated: 1 });
    expect(await reencryptAllSecrets(rotated)).toEqual({ total: 1, rotated: 0 });
    const [after] = await db.select().from(integrations);
    expect(envelopeKeyId(after!.encryptedSecret!)).toBe("t2");
    expect(decryptSecret(after!.encryptedSecret!, rotated)).toBe("shpss_rotate_me_0123456789");
    expect(SITE).toBeTruthy();
    expect(await db.select().from(organizations)).toHaveLength(1);
  });
});
