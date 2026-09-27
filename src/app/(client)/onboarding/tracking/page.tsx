import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { findMembership, requireRole } from "@/server/guards";
import { onboardingFor } from "@/server/orgs";
import { TrackingPanel } from "../../tracking-panel";

export const metadata = { title: "Tracking setup" };

export default async function TrackingStep() {
  const user = await requireRole(["client"]);
  const m = await findMembership(user.id);
  if (!m) redirect("/onboarding/organization");
  const progress = await onboardingFor(m.org);
  if (!progress.dashboardUnlocked) redirect(progress.next?.href ?? "/onboarding");
  return (
    <>
      <PageHeader
        title="Install tracking & connect revenue"
        description="This is how we know which orders our ads drove — and the only revenue you're ever billed on."
      />
      <TrackingPanel org={m.org} isOwner={m.memberRole === "owner"} />
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/onboarding/payment" className="btn btn-primary">
          Continue to payment method
        </Link>
        <Link href="/dashboard" className="btn btn-secondary">
          Go to dashboard
        </Link>
      </div>
    </>
  );
}
