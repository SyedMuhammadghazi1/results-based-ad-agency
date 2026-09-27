import { PageHeader } from "@/components/app-shell";
import { requireMembership } from "@/server/guards";
import { activeAgreement } from "@/server/orgs";

export const metadata = { title: "Agreement" };

export default async function AgreementPage() {
  const m = await requireMembership();
  const a = await activeAgreement(m.org.id);
  if (!a) return <p>No agreement accepted yet.</p>;
  return (
    <>
      <PageHeader
        title="Performance agreement"
        description={`Version ${a.version}, accepted ${a.acceptedAt.toUTCString()}. SHA-256 of the text: ${a.termsHash}`}
      />
      <pre className="card font-sans text-sm whitespace-pre-wrap text-ink-2">{a.renderedTerms}</pre>
    </>
  );
}
