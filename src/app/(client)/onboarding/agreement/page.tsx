import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { formatBps } from "@/lib/money";
import { findMembership, requireRole } from "@/server/guards";
import { activeAgreement, agreementTermsFor, getIntake } from "@/server/orgs";
import { acceptAgreementAction } from "../../actions";

export const metadata = { title: "Performance agreement" };

export default async function AgreementStep() {
  const user = await requireRole(["client"]);
  const m = await findMembership(user.id);
  if (!m) redirect("/onboarding/organization");
  if (!(await getIntake(m.org.id))) redirect("/onboarding/intake");
  const current = await activeAgreement(m.org.id);
  const offer = agreementTermsFor(m.org);
  const alreadyAccepted = current?.termsHash === offer.hash;

  return (
    <>
      <PageHeader
        title="Performance agreement"
        description={`You pay ${formatBps(offer.terms.feeRateBps)} of attributed revenue. Attribution window: ${offer.terms.attributionWindowDays} days. Nothing else.`}
      />
      <div className="card space-y-4">
        <pre
          className="max-h-[28rem] overflow-auto rounded-lg bg-plane p-4 font-sans text-sm whitespace-pre-wrap text-ink-2"
          tabIndex={0}
        >
          {offer.rendered}
        </pre>
        <p className="text-xs text-muted">
          Version {offer.version} · SHA-256 {offer.hash.slice(0, 16)}…
        </p>
        {alreadyAccepted ? (
          <div role="status" className="rounded-lg bg-brand-50 p-3 text-sm text-brand-800">
            Accepted on {current!.acceptedAt.toUTCString()}.{" "}
            <Link href="/onboarding/tracking" className="link">
              Continue to tracking setup
            </Link>
          </div>
        ) : m.memberRole !== "owner" ? (
          <p className="text-sm text-ink-2">
            Only the organization owner can accept the agreement.
          </p>
        ) : (
          <ActionForm action={acceptAgreementAction} submitLabel="Accept agreement">
            <input type="hidden" name="termsHash" value={offer.hash} />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="accept" value="yes" required className="mt-1" />
              <span>
                I have read the agreement above and accept it on behalf of{" "}
                <strong>{m.org.name}</strong>.
              </span>
            </label>
          </ActionForm>
        )}
      </div>
    </>
  );
}
