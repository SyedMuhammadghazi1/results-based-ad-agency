import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { POST as platformStripePOST } from "@/app/api/webhooks/stripe/route";
import { db } from "@/db";
import {
  agreements,
  alerts,
  billingPeriods,
  campaigns,
  conversions,
  organizations,
  type Organization,
} from "@/db/schema";
import { runDunningJob } from "@/jobs/dunning";
import { runMonthlyBilling } from "@/jobs/monthly-billing";
import { SandboxConnector } from "@/lib/connectors/sandbox";
import { parsePeriodKey } from "@/lib/dates";
import { recordConversion, recordRefund } from "@/server/conversions";
import { outbox } from "@/server/mailer";
import { acceptAgreement, agreementTermsFor, getOrg, setOffer } from "@/server/orgs";
import type { StripeClient } from "@/server/stripe";
import { signStripePayload } from "@/server/stripe";
import { ingestTouch } from "@/server/tracking";
import { activeCampaign, createUser, onboardedOrg, SITE, type TestUser } from "./helpers";

/**
 * In-memory fake of the Stripe SDK surface we use, emulating idempotency keys and Stripe's
 * automatic finalization of drafts created with `auto_advance: true` (`advanceClock()` = ~1 hour
 * later; a finalized $0 invoice is immediately `paid`).
 */
function fakeStripe() {
  const invoices = new Map<
    string,
    {
      id: string;
      status: string;
      amount_due: number;
      hosted_invoice_url: string | null;
      auto_advance: boolean;
    }
  >();
  const idempotent = new Map<string, unknown>();
  let n = 0;
  const once = async <T>(key: string | undefined, fn: () => T): Promise<T> => {
    if (key && idempotent.has(key)) return idempotent.get(key) as T;
    const v = fn();
    if (key) idempotent.set(key, v);
    return v;
  };
  const advanceClock = () => {
    for (const inv of invoices.values()) {
      if (inv.status === "draft" && inv.auto_advance) {
        inv.status = inv.amount_due === 0 ? "paid" : "open";
      }
    }
  };
  const stripe = {
    customers: {
      create: vi.fn(async (_p: unknown, o?: { idempotencyKey?: string }) =>
        once(o?.idempotencyKey, () => ({ id: `cus_${++n}` })),
      ),
      update: vi.fn(async () => ({})),
    },
    invoices: {
      create: vi.fn(async (p: { auto_advance?: boolean }, o?: { idempotencyKey?: string }) =>
        once(o?.idempotencyKey, () => {
          const inv = {
            id: `in_${++n}`,
            status: "draft",
            amount_due: 0,
            hosted_invoice_url: null,
            auto_advance: p.auto_advance ?? false,
          };
          invoices.set(inv.id, inv);
          return inv;
        }),
      ),
      retrieve: vi.fn(async (id: string) => ({ ...invoices.get(id)! })),
      finalizeInvoice: vi.fn(async (id: string, _p: unknown, o?: { idempotencyKey?: string }) =>
        once(o?.idempotencyKey, () => {
          const inv = invoices.get(id)!;
          inv.status = "open";
          inv.hosted_invoice_url = `https://invoice.stripe.test/${id}`;
          return { ...inv };
        }),
      ),
    },
    invoiceItems: {
      create: vi.fn(
        async (p: { invoice: string; amount: number }, o?: { idempotencyKey?: string }) =>
          once(o?.idempotencyKey, () => {
            invoices.get(p.invoice)!.amount_due += p.amount;
            return { id: `ii_${++n}` };
          }),
      ),
    },
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
    setupIntents: { retrieve: vi.fn() },
  };
  return { stripe: stripe as unknown as StripeClient, mock: stripe, invoices, advanceClock };
}

let visitorSeq = 0;
async function attributedOrder(
  org: Organization,
  trackingCode: string,
  orderId: string,
  amountMinor: number,
  at: Date,
) {
  const vid = `billing_visitor_${String(++visitorSeq).padStart(6, "0")}`;
  await ingestTouch(
    { pk: org.publicKey, vid, type: "touch", params: { oa_cid: trackingCode } },
    SITE,
    new Date(at.getTime() - 3_600_000),
  );
  const res = await recordConversion(org, "api", {
    kind: "conversion",
    externalOrderId: orderId,
    occurredAt: at,
    amountMinor,
    currency: org.currency,
    visitorId: vid,
  });
  expect(res).toMatchObject({ status: "recorded", attributed: true });
}

async function billableClient(): Promise<{
  owner: TestUser;
  org: Organization;
  code: string;
  campaignId: string;
}> {
  const owner = await createUser("client");
  const operator = await createUser("operator");
  const { org } = await onboardedOrg(owner);
  await db
    .update(organizations)
    .set({ stripeCustomerId: "cus_existing" })
    .where(eq(organizations.id, org.id));
  const c = await activeCampaign(operator, org.id);
  return { owner, org: (await getOrg(org.id))!, code: c.trackingCode, campaignId: c.id };
}

const JULY = parsePeriodKey("2026-07");
const AUG = parsePeriodKey("2026-08");
const SEP_1 = new Date("2026-09-01T06:00:00Z");
const day = (p: { start: Date }, d: number) =>
  new Date(p.start.getTime() + (d - 1) * 86_400_000 + 12 * 3_600_000);

describe("monthly billing", () => {
  it("creates exactly one statement and one Stripe invoice even when run twice (and concurrently)", async () => {
    const { org, code } = await billableClient();
    await attributedOrder(org, code, "B-1", 123_456, day(AUG, 3));
    await attributedOrder(org, code, "B-2", 76_544, day(AUG, 30));
    // A September order is not part of the August statement.
    await attributedOrder(org, code, "B-3", 50_000, new Date("2026-09-02T10:00:00Z"));
    const { stripe, mock } = fakeStripe();

    const first = await runMonthlyBilling({ now: SEP_1, stripe });
    expect(first).toMatchObject({ period: "2026-08", created: 1, invoiced: 1, failed: 0 });
    const [again, concurrent] = await Promise.all([
      runMonthlyBilling({ now: SEP_1, stripe }),
      runMonthlyBilling({ now: SEP_1, stripe }),
    ]);
    expect(again).toMatchObject({ created: 0, exists: 1 });
    expect(concurrent).toMatchObject({ created: 0, exists: 1 });

    const rows = await db.select().from(billingPeriods);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      grossRevenueMinor: 200_000,
      netRevenueMinor: 200_000,
      grossFeeMinor: 20_000,
      amountDueMinor: 20_000,
      status: "open",
      stripeInvoiceId: "in_1",
      hostedInvoiceUrl: "https://invoice.stripe.test/in_1",
    });
    expect(mock.invoices.create).toHaveBeenCalledTimes(1);
    expect(mock.invoiceItems.create).toHaveBeenCalledTimes(1);
    expect(mock.invoiceItems.create.mock.calls[0]![0]).toMatchObject({
      amount: 20_000,
      currency: "usd",
      customer: "cus_existing",
    });
    // The draft must not auto-advance before its fee line exists; finalizing turns it on.
    expect(mock.invoices.create.mock.calls[0]![0]).toMatchObject({
      collection_method: "charge_automatically",
      auto_advance: false,
    });
    expect(mock.invoices.finalizeInvoice.mock.calls[0]![1]).toMatchObject({ auto_advance: true });
    // The September order stays unbilled.
    const sept = await db.select().from(conversions).where(eq(conversions.externalOrderId, "B-3"));
    expect(sept[0]!.billingPeriodId).toBeNull();
  });

  it("zero attributed revenue → no invoice", async () => {
    const { org } = await billableClient();
    // Unattributed revenue never counts.
    await recordConversion(org, "api", {
      kind: "conversion",
      externalOrderId: "organic-1",
      occurredAt: day(AUG, 5),
      amountMinor: 500_000,
      currency: "USD",
      visitorId: null,
    });
    const { stripe, mock } = fakeStripe();
    expect(await runMonthlyBilling({ now: SEP_1, stripe })).toMatchObject({
      no_charge: 1,
      invoiced: 0,
    });
    const [row] = await db.select().from(billingPeriods);
    expect(row).toMatchObject({ status: "no_charge", amountDueMinor: 0, stripeInvoiceId: null });
    expect(mock.invoices.create).not.toHaveBeenCalled();
  });

  it("turns refunds of already-billed revenue into credits carried across periods", async () => {
    const { org, code } = await billableClient();
    const { stripe, mock } = fakeStripe();
    // July: $1,000 → $100 fee.
    await attributedOrder(org, code, "J-1", 100_000, day(JULY, 10));
    await runMonthlyBilling({ now: new Date("2026-08-01T06:00:00Z"), stripe });
    // August: $500 refund of the July order (credit $50) and a new $200 order (fee $20).
    await recordRefund(org, "api", {
      kind: "refund",
      externalOrderId: "J-1",
      externalRefundId: "rf-J-1",
      occurredAt: day(AUG, 2),
      amountMinor: 50_000,
      currency: "USD",
    });
    await attributedOrder(org, code, "A-1", 20_000, day(AUG, 4));
    // Also a same-month partial refund of the August order: net $200 - $50 = $150 → fee $15.
    await recordRefund(org, "api", {
      kind: "refund",
      externalOrderId: "A-1",
      externalRefundId: "rf-A-1",
      occurredAt: day(AUG, 6),
      amountMinor: 5_000,
      currency: "USD",
    });
    await runMonthlyBilling({ now: SEP_1, stripe });
    const aug = (
      await db.select().from(billingPeriods).where(eq(billingPeriods.periodStart, "2026-08-01"))
    )[0]!;
    expect(aug).toMatchObject({
      grossRevenueMinor: 20_000,
      netRevenueMinor: 15_000,
      grossFeeMinor: 1_500,
      creditGeneratedMinor: 5_000,
      creditAppliedMinor: 1_500,
      creditCarriedOutMinor: 3_500,
      amountDueMinor: 0,
      status: "no_charge",
    });
    // September: $1,000 → $100 fee − $35 credit = $65.
    await attributedOrder(org, code, "S-1", 100_000, new Date("2026-09-03T10:00:00Z"));
    await runMonthlyBilling({ now: new Date("2026-10-01T06:00:00Z"), period: "2026-09", stripe });
    const sep = (
      await db.select().from(billingPeriods).where(eq(billingPeriods.periodStart, "2026-09-01"))
    )[0]!;
    expect(sep).toMatchObject({
      grossFeeMinor: 10_000,
      creditCarriedInMinor: 3_500,
      creditAppliedMinor: 3_500,
      amountDueMinor: 6_500,
      status: "open",
    });
    expect(mock.invoices.create).toHaveBeenCalledTimes(2); // July and September only
  });

  it("bills each rate separately after a new agreement version", async () => {
    const { owner, org, code } = await billableClient();
    await attributedOrder(org, code, "R-10", 100_005, day(AUG, 2));
    const operator = await createUser("operator");
    await setOffer(org.id, operator, { feeRatePct: 8, attributionWindowDays: 7 });
    const updated = (await getOrg(org.id))!;
    const second = await acceptAgreement({
      org: updated,
      user: owner,
      shownHash: agreementTermsFor(updated).hash,
      ip: null,
      userAgent: null,
    });
    // The new version took effect mid-August.
    await db
      .update(agreements)
      .set({ acceptedAt: new Date("2026-08-15T00:00:00Z") })
      .where(eq(agreements.id, second.id));
    await attributedOrder(updated, code, "R-8", 100_005, day(AUG, 20));
    const { stripe } = fakeStripe();
    await runMonthlyBilling({ now: SEP_1, stripe });
    const [row] = await db.select().from(billingPeriods);
    expect(row!.feeLines).toEqual([
      { feeRateBps: 800, netRevenueMinor: 100_005, feeMinor: 8_000 },
      { feeRateBps: 1000, netRevenueMinor: 100_005, feeMinor: 10_001 },
    ]);
    expect(row!.amountDueMinor).toBe(18_001);
  });

  it("rejects a statement containing another currency and bills nothing", async () => {
    const { org, code } = await billableClient();
    await attributedOrder(org, code, "C-1", 10_000, day(AUG, 2));
    await db
      .update(conversions)
      .set({ currency: "EUR" })
      .where(eq(conversions.externalOrderId, "C-1"));
    const { stripe, mock } = fakeStripe();
    expect(await runMonthlyBilling({ now: SEP_1, stripe })).toMatchObject({
      failed: 1,
      created: 0,
    });
    expect(await db.select().from(billingPeriods)).toHaveLength(0);
    expect(mock.invoices.create).not.toHaveBeenCalled();
  });

  it("keeps the statement pending when there is no Stripe customer, then resumes", async () => {
    const { org, code } = await billableClient();
    await db
      .update(organizations)
      .set({ stripeCustomerId: null })
      .where(eq(organizations.id, org.id));
    await attributedOrder(org, code, "N-1", 10_000, day(AUG, 2));
    const { stripe, mock } = fakeStripe();
    await runMonthlyBilling({ now: SEP_1, stripe });
    let [row] = await db.select().from(billingPeriods);
    expect(row).toMatchObject({ status: "pending_invoice", amountDueMinor: 1_000 });
    expect(row!.lastPaymentError).toMatch(/payment method/);
    expect((await db.select().from(alerts)).map((a) => a.kind)).toContain("payment_failed");

    await db
      .update(organizations)
      .set({ stripeCustomerId: "cus_later" })
      .where(eq(organizations.id, org.id));
    expect(await runMonthlyBilling({ now: SEP_1, stripe })).toMatchObject({ exists: 1 });
    [row] = await db.select().from(billingPeriods);
    expect(row).toMatchObject({ status: "open", stripeInvoiceId: "in_1" });
    expect(mock.invoices.create).toHaveBeenCalledTimes(1);
  });

  it("resumes an invoice whose fee line failed without Stripe finalizing it empty in between", async () => {
    const { org, code } = await billableClient();
    await attributedOrder(org, code, "F-1", 100_000, day(AUG, 2));
    const { stripe, mock, invoices, advanceClock } = fakeStripe();
    mock.invoiceItems.create.mockRejectedValueOnce(new Error("Stripe API connection error"));

    expect(await runMonthlyBilling({ now: SEP_1, stripe })).toMatchObject({
      created: 1,
      invoiced: 0,
    });
    let [row] = await db.select().from(billingPeriods);
    expect(row).toMatchObject({ status: "pending_invoice", stripeInvoiceId: "in_1" });
    expect(row!.lastPaymentError).toMatch(/connection error/);

    // Hours pass before someone re-runs the job: Stripe must not have auto-finalized the empty
    // draft (a $0 invoice would be marked paid and the fee never collected).
    advanceClock();
    expect(invoices.get("in_1")!.status).toBe("draft");

    expect(await runMonthlyBilling({ now: SEP_1, stripe })).toMatchObject({ exists: 1 });
    [row] = await db.select().from(billingPeriods);
    expect(row).toMatchObject({ status: "open", amountDueMinor: 10_000, lastPaymentError: null });
    expect(invoices.get("in_1")).toMatchObject({ status: "open", amount_due: 10_000 });
  });
});

describe("invoice webhooks and dunning", () => {
  function platformEvent(event: object, secret = "whsec_test_platform_secret") {
    const raw = JSON.stringify(event);
    return platformStripePOST(
      new Request("http://localhost:3003/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signStripePayload(raw, secret) },
        body: raw,
      }),
    );
  }
  const invoiceEvent = (id: string, type: string, invoiceId: string) => ({
    id,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: invoiceId,
        object: "invoice",
        hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
      },
    },
  });

  async function issuedInvoice() {
    const ctx = await billableClient();
    await attributedOrder(ctx.org, ctx.code, "D-1", 100_000, day(AUG, 2));
    const { stripe } = fakeStripe();
    await runMonthlyBilling({ now: SEP_1, stripe });
    const [row] = await db.select().from(billingPeriods);
    return { ...ctx, row: row! };
  }

  it("invoice.payment_failed then invoice.paid update the statement; replays are ignored", async () => {
    const { row, org } = await issuedInvoice();
    const failed = await platformEvent(
      invoiceEvent("evt_f1", "invoice.payment_failed", row.stripeInvoiceId!),
    );
    expect(await failed.json()).toMatchObject({ result: "processed" });
    let [after] = await db.select().from(billingPeriods);
    expect(after!.status).toBe("payment_failed");
    expect(outbox.some((e) => e.subject.includes("payment for your 2026-08 invoice failed"))).toBe(
      true,
    );
    expect(
      (await db.select().from(alerts).where(eq(alerts.orgId, org.id))).some(
        (a) => a.kind === "payment_failed",
      ),
    ).toBe(true);

    expect(
      await (
        await platformEvent(invoiceEvent("evt_p1", "invoice.paid", row.stripeInvoiceId!))
      ).json(),
    ).toMatchObject({
      result: "processed",
    });
    expect(
      await (
        await platformEvent(invoiceEvent("evt_p1", "invoice.paid", row.stripeInvoiceId!))
      ).json(),
    ).toMatchObject({
      result: "duplicate",
    });
    [after] = await db.select().from(billingPeriods);
    expect(after).toMatchObject({ status: "paid" });
    expect(after!.paidAt).not.toBeNull();
  });

  it("rejects webhooks with a bad signature", async () => {
    const res = await platformEvent(invoiceEvent("evt_x", "invoice.paid", "in_x"), "whsec_wrong");
    expect(res.status).toBe(400);
  });

  it("pauses campaigns when an invoice is overdue beyond the grace period, and clears on payment", async () => {
    const { row, org, campaignId } = await issuedInvoice();
    const sandbox = new SandboxConnector();
    const resolve = async () => sandbox;

    // 10 days after issue: still within the 14-day grace period.
    expect(
      await runDunningJob({ now: new Date(row.issuedAt!.getTime() + 10 * 86_400_000), resolve }),
    ).toMatchObject({
      orgsPaused: 0,
    });
    const res = await runDunningJob({
      now: new Date(row.issuedAt!.getTime() + 15 * 86_400_000),
      resolve,
    });
    expect(res).toMatchObject({ overdueInvoices: 1, orgsPaused: 1, campaignsPaused: 1 });
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(camp).toMatchObject({ status: "paused", pausedReason: "dunning" });
    expect(sandbox.calls.filter((c) => c.op === "setStatus")).toEqual([
      expect.objectContaining({ op: "setStatus", status: "paused" }),
    ]);
    expect((await getOrg(org.id))!.dunningPausedAt).not.toBeNull();

    await platformEvent(invoiceEvent("evt_paid", "invoice.paid", row.stripeInvoiceId!));
    expect((await getOrg(org.id))!.dunningPausedAt).toBeNull();
  });
});
