import { redirect } from "next/navigation";
import { findMembership, requireRole } from "@/server/guards";
import { onboardingFor } from "@/server/orgs";

export default async function OnboardingIndex() {
  const user = await requireRole(["client"]);
  const m = await findMembership(user.id);
  if (!m) redirect("/onboarding/organization");
  const p = await onboardingFor(m.org);
  redirect(p.next?.href ?? "/dashboard");
}
