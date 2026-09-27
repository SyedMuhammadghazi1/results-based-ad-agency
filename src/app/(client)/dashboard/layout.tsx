import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { requireMembership } from "@/server/guards";
import { onboardingFor } from "@/server/orgs";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const m = await requireMembership();
  const progress = await onboardingFor(m.org);
  if (!progress.dashboardUnlocked) redirect(progress.next?.href ?? "/onboarding");
  return (
    <AppShell
      context={m.org.name}
      userLabel={m.user.email}
      nav={[
        { href: "/dashboard", label: "Revenue" },
        { href: "/dashboard/orders", label: "Attributed orders" },
        { href: "/dashboard/invoices", label: "Invoices" },
        { href: "/dashboard/settings", label: "Settings" },
      ]}
    >
      {children}
    </AppShell>
  );
}
