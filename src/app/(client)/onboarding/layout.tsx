import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/site-chrome";
import { SignOutButton } from "@/components/sign-out-button";
import { ONBOARDING_STEPS } from "@/lib/onboarding";
import { findMembership, requireRole } from "@/server/guards";
import { onboardingFor } from "@/server/orgs";

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const user = await requireRole(["client"]);
  const m = await findMembership(user.id);
  const progress = m ? await onboardingFor(m.org) : null;
  const steps = progress?.steps ?? ONBOARDING_STEPS.map((s) => ({ ...s, done: false }));
  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline bg-white">
        <div className="container-page flex items-center justify-between py-3">
          <Logo />
          <div className="flex items-center gap-3">
            {progress?.dashboardUnlocked ? (
              <Link href="/dashboard" className="link text-sm">
                Go to dashboard
              </Link>
            ) : null}
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="container-page grid gap-8 py-8 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Onboarding steps">
          <ol className="space-y-2 text-sm">
            {steps.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${s.done ? "bg-brand-700 text-white" : "bg-zinc-200 text-zinc-700"}`}
                >
                  {s.done ? "✓" : i + 1}
                </span>
                <Link href={s.href} className="text-ink-2 hover:text-ink">
                  {s.label}
                  <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <main id="main" className="min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
