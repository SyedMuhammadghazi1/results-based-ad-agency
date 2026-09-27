import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./site-chrome";
import { SignOutButton } from "./sign-out-button";

export type NavItem = { href: string; label: string };

export function AppShell({
  nav,
  userLabel,
  context,
  children,
}: {
  nav: NavItem[];
  userLabel: string;
  context?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline bg-white">
        <div className="container-page flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3">
            <Logo />
            {context ? <span className="badge bg-zinc-100 text-zinc-800">{context}</span> : null}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-ink-2 sm:inline">{userLabel}</span>
            <SignOutButton />
          </div>
        </div>
        <nav className="container-page" aria-label="Section">
          <ul className="-mb-px flex gap-4 overflow-x-auto text-sm">
            {nav.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  className="inline-block border-b-2 border-transparent py-2 whitespace-nowrap text-ink-2 hover:border-hairline hover:text-ink"
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="container-page py-8">
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
