import Link from "next/link";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Outcome Ads";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold text-ink">
      <span
        aria-hidden="true"
        className="grid h-7 w-7 place-items-center rounded-md bg-brand-700 text-sm text-white"
      >
        ↗
      </span>
      {appName}
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-hairline bg-white">
      <nav
        className="container-page flex flex-wrap items-center justify-between gap-3 py-3"
        aria-label="Main"
      >
        <Logo />
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <li>
            <Link href="/#how-it-works" className="text-ink-2 hover:text-ink">
              How it works
            </Link>
          </li>
          <li>
            <Link href="/faq" className="text-ink-2 hover:text-ink">
              FAQ
            </Link>
          </li>
          <li>
            <Link href="/sign-in" className="text-ink-2 hover:text-ink">
              Sign in
            </Link>
          </li>
          <li>
            <Link href="/apply" className="btn btn-primary btn-sm">
              Apply
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-hairline bg-white">
      <div className="container-page flex flex-col gap-3 py-8 text-sm text-ink-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {new Date().getUTCFullYear()} {appName}. You only pay on revenue.
        </p>
        <ul className="flex gap-4">
          <li>
            <Link href="/faq" className="hover:text-ink">
              FAQ
            </Link>
          </li>
          <li>
            <Link href="/legal/terms" className="hover:text-ink">
              Terms
            </Link>
          </li>
          <li>
            <Link href="/legal/privacy" className="hover:text-ink">
              Privacy
            </Link>
          </li>
        </ul>
      </div>
    </footer>
  );
}
