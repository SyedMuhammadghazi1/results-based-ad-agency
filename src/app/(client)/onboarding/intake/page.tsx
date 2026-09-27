import { redirect } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { findMembership, requireRole } from "@/server/guards";
import { IntakeForm } from "../../intake-form";

export const metadata = { title: "Business details" };

export default async function IntakeStep() {
  const user = await requireRole(["client"]);
  const m = await findMembership(user.id);
  if (!m) redirect("/onboarding/organization");
  return (
    <>
      <PageHeader
        title="Tell us about your business"
        description="This replaces the kickoff meeting. You can update it any time from Settings."
      />
      <div className="card">
        <IntakeForm org={m.org} readOnly={m.memberRole !== "owner"} />
      </div>
    </>
  );
}
