import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { paymentsBypassed } from "@/env";
import { confirmSetupSession } from "@/server/billing";
import { findMembership, requireRole } from "@/server/guards";
import { logger } from "@/server/logger";
import { getOrg, onboardingFor } from "@/server/orgs";
import { stripeConfigured } from "@/server/stripe";
import { startPaymentSetupAction } from "../../actions";

export const metadata = { title: "Payment method" };

export default async function PaymentStep({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; session_id?: string }>;
}) {
  const user = await requireRole(["client"]);
  const m = await findMembership(user.id);
  if (!m) redirect("/onboarding/organization");
  const progress = await onboardingFor(m.org);
  if (!progress.dashboardUnlocked) redirect(progress.next?.href ?? "/onboarding");
  const { status, session_id } = await searchParams;

  let org = m.org;
  if (status === "success" && session_id && !org.paymentMethodReadyAt && stripeConfigured()) {
    try {
      await confirmSetupSession(org, session_id);
      org = (await getOrg(org.id)) ?? org;
    } catch (err) {
      logger.warn({ err }, "could not confirm setup session; waiting for webhook");
    }
  }
  const canSetup = stripeConfigured() || paymentsBypassed;

  return (
    <>
      <PageHeader
        title="Add a payment method"
        description="Performance fees are charged automatically on the 1st of each month — only if our ads generated revenue."
      />
      <div className="card max-w-xl space-y-4">
        {org.paymentMethodReadyAt ? (
          <>
            <StatusBadge status="connected" label="Payment method on file" />
            <p className="text-sm text-ink-2">
              You&apos;re all set. Our operators will now build and launch your campaigns.
            </p>
            <Link href="/dashboard" className="btn btn-primary">
              Go to dashboard
            </Link>
          </>
        ) : (
          <>
            {status === "cancelled" ? (
              <p role="status" className="text-sm text-amber-900">
                Setup was cancelled — no payment method was saved.
              </p>
            ) : null}
            {status === "success" ? (
              <p role="status" className="text-sm text-ink-2">
                Thanks — we&apos;re confirming your payment method with Stripe. Refresh in a few
                seconds.
              </p>
            ) : null}
            <p className="text-sm text-ink-2">
              You&apos;ll enter card or bank details on Stripe&apos;s secure page. Nothing is
              charged now. Campaigns go live only once a payment method is on file.
            </p>
            {m.memberRole !== "owner" ? (
              <p className="text-sm">Only the organization owner can add a payment method.</p>
            ) : canSetup ? (
              <ActionForm
                action={startPaymentSetupAction}
                submitLabel="Add payment method with Stripe"
                pendingLabel="Opening Stripe…"
                extraActions={
                  <Link href="/dashboard" className="btn btn-secondary">
                    Skip for now
                  </Link>
                }
              />
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-amber-900">
                  Payments are not configured on this server yet.
                </p>
                <Link href="/dashboard" className="btn btn-secondary">
                  Skip for now
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
