import { redirect } from "next/navigation";
import { findMembership, requireUser } from "@/server/guards";
import { onboardingFor } from "@/server/orgs";

/** Post-login router: staff → operator console; clients → dashboard or their next onboarding step. */
export default async function AppHome() {
  const user = await requireUser();
  if (user.role !== "client") redirect("/operator");
  const m = await findMembership(user.id);
  if (!m) redirect("/onboarding/organization");
  const progress = await onboardingFor(m.org);
  redirect(progress.dashboardUnlocked ? "/dashboard" : (progress.next?.href ?? "/dashboard"));
}
