import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { requireOperator } from "@/server/guards";

export default async function OperatorLayout({ children }: { children: ReactNode }) {
  const user = await requireOperator();
  const nav = [
    { href: "/operator", label: "Clients" },
    { href: "/operator/alerts", label: "Alerts" },
    { href: "/operator/billing", label: "Billing" },
    { href: "/operator/applications", label: "Applications" },
    { href: "/operator/jobs", label: "Jobs" },
    { href: "/operator/audit", label: "Audit log" },
  ];
  if (user.role === "admin") nav.push({ href: "/operator/team", label: "Team" });
  return (
    <AppShell
      nav={nav}
      userLabel={user.email}
      context={user.role === "admin" ? "Admin" : "Operator"}
    >
      {children}
    </AppShell>
  );
}
