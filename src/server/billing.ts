import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db";
import {
  agreements,
  billingPeriods,
  conversionAdjustments,
  conversions,
  orgMembers,
  organizations,
  user,
  webhookEvents,
  type BillingPeriod,
  type Organization,
} from "@/db/schema";
import { appName, env, paymentsBypassed } from "@/env";
import { computeStatement, describeStatement, type Statement } from "@/lib/billing";
import type { Period } from "@/lib/dates";
import { isOverdue } from "@/lib/dunning";
import { formatMinor } from "@/lib/money";
import { raiseAlert } from "./alerts";
import { audit } from "./audit";
import { pauseOrgCampaigns } from "./campaigns";
import type { ConnectorResolver } from "./connectors";
import type { SessionUser } from "./guards";
import { logger } from "./logger";
import { sendEmail } from "./mailer";
import { DomainError } from "./orgs";
import { getStripe, type StripeClient } from "./stripe";

// ---------------------------------------------------------------------------
// Monthly statement
// ---------------------------------------------------------------------------

/**
 * Loads every unbilled item up to the period end and computes the statement (no writes). Refunds
 * still waiting for their order (`pending_refunds`) are deliberately not read: they only become
 * adjustments once matched to a conversion.
 */
export async function draftStatement(
  org: Organization,
  periodEnd: Date,
  periodStart: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db = db,
): Promise<Statement> {
  const convRows = await tx
    .select({
      id: conversions.id,
      amountMinor: conversions.amountMinor,
      currency: conversions.currency,
      feeRateBps: conversions.feeRateBps,
    })
    .from(conversions)
    .where(
      and(
        eq(conversions.orgId, org.id),
        eq(conversions.attributed, true),
        isNull(conversions.billingPeriodId),
        lt(conversions.occurredAt, periodEnd),
      ),
    );
  const inStatement = new Set(convRows.map((c) => c.id));

  const adjRows = await tx
    .select({
      id: conversionAdjustments.id,
      conversionId: conversionAdjustments.conversionId,
      amountMinor: conversionAdjustments.amountMinor,
      currency: conversionAdjustments.currency,
      feeRateBps: conversions.feeRateBps,
      conversionBillingPeriodId: conversions.billingPeriodId,
    })
    .from(conversionAdjustments)
    .innerJoin(conversions, eq(conversionAdjustments.conversionId, conversions.id))
    .where(
      and(
        eq(conversionAdjustments.orgId, org.id),
        eq(conversions.attributed, true),
        isNull(conversionAdjustments.billingPeriodId),
        lt(conversionAdjustments.occurredAt, periodEnd),
      ),
    );
  // A refund waits until its conversion is billed (or is on this statement).
  const adjustments = adjRows
    .filter((a) => a.conversionBillingPeriodId !== null || inStatement.has(a.conversionId))
    .map((a) => ({
      id: a.id,
      conversionId: a.conversionId,
      amountMinor: a.amountMinor,
      currency: a.currency,
      feeRateBps: a.feeRateBps ?? 0,
      conversionBilledEarlier: a.conversionBillingPeriodId !== null,
    }));

  const prev = await tx
    .select({ carry: billingPeriods.creditCarriedOutMinor })
    .from(billingPeriods)
    .where(and(eq(billingPeriods.orgId, org.id), lt(billingPeriods.periodStart, periodStart)))
    .orderBy(desc(billingPeriods.periodStart))
    .limit(1);

  return computeStatement({
    currency: org.currency,
    conversions: convRows.map((c) => ({ ...c, feeRateBps: c.feeRateBps ?? 0 })),
    adjustments,
    creditCarriedInMinor: prev[0]?.carry ?? 0,
  });
}

export type BillOutcome =
  | { status: "created"; billingPeriodId: string; amountDueMinor: number; invoiced: boolean }
  | { status: "no_charge"; billingPeriodId: string }
  | { status: "exists"; billingPeriodId: string; resumed: boolean };

/**
 * Bills one org for one period. Idempotent: the (org, period_start) unique constraint plus a
 * per-org advisory lock guarantee a single statement; the Stripe invoice is created with
 * idempotency keys and its id is persisted before any further step, so a crashed run resumes.
 */
export async function billOrgForPeriod(
  org: Organization,
  period: Period,
  stripe: StripeClient | null,
  now = new Date(),
): Promise<BillOutcome> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${org.id}`}))`);
    const existing = await tx
      .select()
      .from(billingPeriods)
      .where(
        and(eq(billingPeriods.orgId, org.id), eq(billingPeriods.periodStart, period.startDate)),
      )
      .limit(1);
    if (existing[0]) return { existing: existing[0] as BillingPeriod };

    const s = await draftStatement(org, period.end, period.startDate, tx);
    const [row] = await tx
      .insert(billingPeriods)
      .values({
        orgId: org.id,
        periodStart: period.startDate,
        periodEnd: period.endDate,
        currency: org.currency,
        grossRevenueMinor: s.grossRevenueMinor,
        netRevenueMinor: s.netRevenueMinor,
        feeLines: s.feeLines,
        grossFeeMinor: s.grossFeeMinor,
        creditGeneratedMinor: s.creditGeneratedMinor,
        creditCarriedInMinor: s.creditCarriedInMinor,
        creditAppliedMinor: s.creditAppliedMinor,
        creditCarriedOutMinor: s.creditCarriedOutMinor,
        amountDueMinor: s.amountDueMinor,
        status: s.shouldInvoice ? "pending_invoice" : "no_charge",
      })
      .returning();
    if (s.conversionIds.length > 0) {
      await tx
        .update(conversions)
        .set({ billingPeriodId: row!.id })
        .where(inArray(conversions.id, s.conversionIds));
    }
    if (s.adjustmentIds.length > 0) {
      await tx
        .update(conversionAdjustments)
        .set({ billingPeriodId: row!.id })
        .where(inArray(conversionAdjustments.id, s.adjustmentIds));
    }
    await audit(
      {
        orgId: org.id,
        actorRole: "system",
        action: "billing.statement_created",
        targetType: "billing_period",
        targetId: row!.id,
        metadata: {
          period: period.key,
          amountDueMinor: s.amountDueMinor,
          netRevenueMinor: s.netRevenueMinor,
        },
      },
      tx,
    );
    return { created: row!, statement: s };
  });

  if ("existing" in result && result.existing) {
    const row: BillingPeriod = result.existing;
    if (row.status === "pending_invoice" && stripe) {
      await issueStripeInvoice(row, org, stripe, now);
      return { status: "exists", billingPeriodId: row.id, resumed: true };
    }
    return { status: "exists", billingPeriodId: row.id, resumed: false };
  }

  const { created, statement } = result as { created: BillingPeriod; statement: Statement };
  if (!statement.shouldInvoice) return { status: "no_charge", billingPeriodId: created.id };
  let invoiced = false;
  if (stripe) invoiced = await issueStripeInvoice(created, org, stripe, now);
  return {
    status: "created",
    billingPeriodId: created.id,
    amountDueMinor: statement.amountDueMinor,
    invoiced,
  };
}

export async function issueStripeInvoice(
  row: BillingPeriod,
  org: Organization,
  stripe: StripeClient,
  now = new Date(),
): Promise<boolean> {
  if (!org.stripeCustomerId) {
    await db
      .update(billingPeriods)
      .set({ lastPaymentError: "No Stripe customer / payment method on file", updatedAt: now })
      .where(eq(billingPeriods.id, row.id));
    await raiseAlert({
      orgId: org.id,
      kind: "payment_failed",
      severity: "critical",
      message: `${org.name}: fee of ${formatMinor(row.amountDueMinor, row.currency)} for ${row.periodStart.slice(0, 7)} cannot be invoiced — no payment method on file`,
      dedupeKey: `no_customer:${row.id}`,
    });
    return false;
  }
  const format = (n: number) => formatMinor(n, row.currency);
  const periodKey = row.periodStart.slice(0, 7);
  const description = describeStatement(
    {
      ...row,
      feeLines: row.feeLines,
      shouldInvoice: true,
      conversionIds: [],
      adjustmentIds: [],
    },
    periodKey,
    format,
  );

  try {
    let invoiceId = row.stripeInvoiceId;
    if (!invoiceId) {
      const created = await stripe.invoices.create(
        {
          customer: org.stripeCustomerId,
          collection_method: "charge_automatically",
          // Stripe auto-finalizes auto-advancing drafts after ~1 hour. If adding the fee line
          // below fails, an empty draft would become a $0 "paid" invoice (fee never collected),
          // so the draft stays manual until finalizeInvoice turns automatic collection on.
          auto_advance: false,
          currency: row.currency.toLowerCase(),
          description: `${appName} performance fee — ${periodKey}`,
          pending_invoice_items_behavior: "exclude",
          metadata: { orgId: org.id, billingPeriodId: row.id, period: periodKey },
        },
        { idempotencyKey: `bp_${row.id}_invoice` },
      );
      invoiceId = created.id!;
      await db
        .update(billingPeriods)
        .set({ stripeInvoiceId: invoiceId, updatedAt: now })
        .where(eq(billingPeriods.id, row.id));
    }

    let invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.status === "draft") {
      if ((invoice.amount_due ?? 0) === 0) {
        await stripe.invoiceItems.create(
          {
            customer: org.stripeCustomerId,
            invoice: invoiceId,
            amount: row.amountDueMinor,
            currency: row.currency.toLowerCase(),
            description,
          },
          { idempotencyKey: `bp_${row.id}_item` },
        );
      }
      invoice = await stripe.invoices.finalizeInvoice(
        invoiceId,
        { auto_advance: true },
        { idempotencyKey: `bp_${row.id}_finalize` },
      );
    }
    await db
      .update(billingPeriods)
      .set({
        status: invoice.status === "paid" ? "paid" : "open",
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        issuedAt: row.issuedAt ?? now,
        paidAt: invoice.status === "paid" ? now : null,
        lastPaymentError: null,
        updatedAt: now,
      })
      .where(eq(billingPeriods.id, row.id));
    await audit({
      orgId: org.id,
      actorRole: "system",
      action: "billing.invoice_issued",
      targetType: "billing_period",
      targetId: row.id,
      metadata: { stripeInvoiceId: invoiceId, amountDueMinor: row.amountDueMinor },
    });
    return true;
  } catch (err) {
    logger.error({ err, billingPeriodId: row.id }, "failed to issue Stripe invoice");
    await db
      .update(billingPeriods)
      .set({
        lastPaymentError: err instanceof Error ? err.message.slice(0, 500) : "Stripe error",
        updatedAt: now,
      })
      .where(eq(billingPeriods.id, row.id));
    return false;
  }
}

/**
 * Orgs to bill for a period: an agreement was in force before the period ended, or there is
 * unbilled attributed revenue (or refunds) dated before the period end.
 */
export async function billableOrgs(period: Period): Promise<Organization[]> {
  const end = period.end.toISOString();
  return db
    .select()
    .from(organizations)
    .where(
      sql`exists (select 1 from ${agreements} a where a.org_id = ${organizations.id} and a.accepted_at < ${end})
        or exists (select 1 from ${conversions} c where c.org_id = ${organizations.id} and c.attributed
                   and c.billing_period_id is null and c.occurred_at < ${end})`,
    );
}

// ---------------------------------------------------------------------------
// Payment method (Stripe Checkout in setup mode)
// ---------------------------------------------------------------------------

export async function ensureStripeCustomer(
  org: Organization,
  u: SessionUser,
  stripe: StripeClient,
) {
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const customer = await stripe.customers.create(
    { name: org.name, email: u.email, metadata: { orgId: org.id } },
    { idempotencyKey: `org_${org.id}_customer` },
  );
  await db
    .update(organizations)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(organizations.id, org.id));
  return customer.id;
}

export async function startPaymentMethodSetup(
  org: Organization,
  u: SessionUser,
  stripe: StripeClient | null = null,
): Promise<{ url: string }> {
  if (paymentsBypassed) {
    await markPaymentMethodReady(org.id, "bypass");
    await audit({
      actorUserId: u.id,
      actorRole: u.role,
      orgId: org.id,
      action: "payment_method.bypassed",
    });
    return { url: "/onboarding/payment?status=success" };
  }
  const client = stripe ?? getStripe();
  const customer = await ensureStripeCustomer(org, u, client);
  const base = env.APP_URL.replace(/\/$/, "");
  const session = await client.checkout.sessions.create({
    mode: "setup",
    customer,
    currency: org.currency.toLowerCase(),
    success_url: `${base}/onboarding/payment?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/onboarding/payment?status=cancelled`,
    metadata: { orgId: org.id },
    setup_intent_data: { metadata: { orgId: org.id } },
  });
  if (!session.url) throw new DomainError("stripe_error", "Stripe did not return a checkout URL");
  await audit({
    actorUserId: u.id,
    actorRole: u.role,
    orgId: org.id,
    action: "payment_method.setup_started",
  });
  return { url: session.url };
}

async function markPaymentMethodReady(orgId: string, source: string) {
  await db
    .update(organizations)
    .set({ paymentMethodReadyAt: new Date(), updatedAt: new Date() })
    .where(and(eq(organizations.id, orgId), isNull(organizations.paymentMethodReadyAt)));
  logger.info({ orgId, source }, "payment method ready");
}

/** Makes the setup-intent's payment method the customer's default for invoices. */
async function applySetupSession(session: Stripe.Checkout.Session, stripe: StripeClient) {
  const orgId = session.metadata?.orgId;
  if (!orgId || session.mode !== "setup" || session.status !== "complete") return false;
  const siId =
    typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!siId || !customerId) return false;
  const si = await stripe.setupIntents.retrieve(siId);
  const pm = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  if (si.status !== "succeeded" || !pm) return false;
  const org = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org[0] || org[0].stripeCustomerId !== customerId) return false;
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm } });
  await markPaymentMethodReady(orgId, "stripe");
  await audit({ orgId, actorRole: "system", action: "payment_method.ready" });
  return true;
}

/** Called when the client returns from Checkout (in case the webhook is delayed). */
export async function confirmSetupSession(
  org: Organization,
  sessionId: string,
  stripe?: StripeClient,
) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return false;
  const client = stripe ?? getStripe();
  const session = await client.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.orgId !== org.id) return false;
  return applySetupSession(session, client);
}

// ---------------------------------------------------------------------------
// Platform Stripe webhooks
// ---------------------------------------------------------------------------

async function alreadyProcessed(provider: string, eventId: string) {
  const rows = await db
    .select({ id: webhookEvents.eventId })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, eventId)))
    .limit(1);
  return rows.length > 0;
}

export async function markProcessed(provider: string, eventId: string, type: string) {
  await db.insert(webhookEvents).values({ provider, eventId, type }).onConflictDoNothing();
}

export { alreadyProcessed };

async function periodByInvoice(invoiceId: string | undefined | null) {
  if (!invoiceId) return null;
  const rows = await db
    .select({ period: billingPeriods, org: organizations })
    .from(billingPeriods)
    .innerJoin(organizations, eq(billingPeriods.orgId, organizations.id))
    .where(eq(billingPeriods.stripeInvoiceId, invoiceId))
    .limit(1);
  return rows[0] ?? null;
}

async function ownerEmails(orgId: string) {
  const rows = await db
    .select({ email: user.email })
    .from(orgMembers)
    .innerJoin(user, eq(orgMembers.userId, user.id))
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")));
  return rows.map((r) => r.email);
}

export async function handlePlatformStripeEvent(
  event: Stripe.Event,
  stripe: StripeClient | null,
  now = new Date(),
): Promise<"processed" | "duplicate" | "ignored"> {
  const provider = "stripe_platform";
  if (await alreadyProcessed(provider, event.id)) return "duplicate";
  let handled = true;

  switch (event.type) {
    case "checkout.session.completed": {
      if (stripe) await applySetupSession(event.data.object, stripe);
      break;
    }
    case "invoice.finalized": {
      const inv = event.data.object;
      const found = await periodByInvoice(inv.id);
      if (found && !found.period.hostedInvoiceUrl) {
        await db
          .update(billingPeriods)
          .set({ hostedInvoiceUrl: inv.hosted_invoice_url ?? null, updatedAt: now })
          .where(eq(billingPeriods.id, found.period.id));
      }
      break;
    }
    case "invoice.paid": {
      const found = await periodByInvoice(event.data.object.id);
      if (!found) break;
      await db
        .update(billingPeriods)
        .set({ status: "paid", paidAt: now, lastPaymentError: null, updatedAt: now })
        .where(eq(billingPeriods.id, found.period.id));
      await audit({
        orgId: found.org.id,
        actorRole: "system",
        action: "billing.invoice_paid",
        targetType: "billing_period",
        targetId: found.period.id,
      });
      if (found.org.dunningPausedAt) await clearDunningIfSettled(found.org.id, now);
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object;
      const found = await periodByInvoice(inv.id);
      if (!found) break;
      // Stripe does not guarantee event order: a late failure never reopens a settled invoice.
      const updated = await db
        .update(billingPeriods)
        .set({
          status: "payment_failed",
          lastPaymentError: inv.last_finalization_error?.message ?? "Payment failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(billingPeriods.id, found.period.id),
            notInArray(billingPeriods.status, ["paid", "void", "uncollectible"]),
          ),
        )
        .returning({ id: billingPeriods.id });
      if (updated.length === 0) break;
      await raiseAlert({
        orgId: found.org.id,
        kind: "payment_failed",
        severity: "warning",
        message: `${found.org.name}: payment failed for the ${found.period.periodStart.slice(0, 7)} invoice`,
        dedupeKey: `payment_failed:${event.id}`,
      });
      await sendEmail({
        to: await ownerEmails(found.org.id),
        subject: `${appName}: payment for your ${found.period.periodStart.slice(0, 7)} invoice failed`,
        text: `We couldn't charge your payment method for ${formatMinor(found.period.amountDueMinor, found.period.currency)}.\n\nPlease update it or pay the invoice here: ${found.period.hostedInvoiceUrl ?? `${env.APP_URL}/dashboard/invoices`}\n\nCampaigns pause automatically if the invoice stays unpaid for ${env.DUNNING_GRACE_DAYS} days.`,
      });
      break;
    }
    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      const found = await periodByInvoice(event.data.object.id);
      if (!found) break;
      // An uncollectible invoice can still be paid later; a late event must not undo "paid".
      await db
        .update(billingPeriods)
        .set({ status: event.type === "invoice.voided" ? "void" : "uncollectible", updatedAt: now })
        .where(and(eq(billingPeriods.id, found.period.id), ne(billingPeriods.status, "paid")));
      // It no longer counts as overdue; without this the dunning hold (which blocks every
      // campaign launch) could never be lifted.
      if (found.org.dunningPausedAt) await clearDunningIfSettled(found.org.id, now);
      break;
    }
    default:
      handled = false;
  }
  await markProcessed(provider, event.id, event.type);
  return handled ? "processed" : "ignored";
}

// ---------------------------------------------------------------------------
// Dunning
// ---------------------------------------------------------------------------

export async function overdueInvoices(now: Date, orgId?: string) {
  const rows = await db
    .select({ period: billingPeriods, org: organizations })
    .from(billingPeriods)
    .innerJoin(organizations, eq(billingPeriods.orgId, organizations.id))
    .where(
      and(
        or(eq(billingPeriods.status, "open"), eq(billingPeriods.status, "payment_failed")),
        isNotNull(billingPeriods.issuedAt),
        orgId ? eq(billingPeriods.orgId, orgId) : undefined,
      ),
    );
  return rows.filter((r) => isOverdue(r.period, now, env.DUNNING_GRACE_DAYS));
}

async function clearDunningIfSettled(orgId: string, now: Date) {
  if ((await overdueInvoices(now, orgId)).length > 0) return;
  await db
    .update(organizations)
    .set({ dunningPausedAt: null, updatedAt: now })
    .where(eq(organizations.id, orgId));
  await raiseAlert({
    orgId,
    kind: "dunning_paused",
    severity: "info",
    message: "Overdue invoices settled — campaigns paused for dunning can be resumed",
    dedupeKey: `dunning_cleared:${orgId}:${now.toISOString().slice(0, 10)}`,
  });
}

export async function runDunning(now = new Date(), resolve?: ConnectorResolver) {
  const overdue = await overdueInvoices(now);
  const orgIds = [...new Set(overdue.map((o) => o.org.id))];
  let paused = 0;
  for (const orgId of orgIds) {
    const org = overdue.find((o) => o.org.id === orgId)!.org;
    const res = await pauseOrgCampaigns(orgId, "dunning", resolve);
    paused += res.paused;
    if (!org.dunningPausedAt) {
      await db
        .update(organizations)
        .set({ dunningPausedAt: now, updatedAt: now })
        .where(eq(organizations.id, orgId));
      await raiseAlert({
        orgId,
        kind: "dunning_paused",
        severity: "critical",
        message: `${org.name}: invoice overdue > ${env.DUNNING_GRACE_DAYS} days — campaigns paused`,
        dedupeKey: `dunning:${orgId}:${overdue.find((o) => o.org.id === orgId)!.period.id}`,
      });
    }
  }
  return { overdueInvoices: overdue.length, orgsPaused: orgIds.length, campaignsPaused: paused };
}
