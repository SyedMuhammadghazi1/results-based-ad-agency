import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="container-page py-24 text-center">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-ink-2">
        The page you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.
      </p>
      <Link href="/" className="btn btn-primary mt-6">
        Go home
      </Link>
    </main>
  );
}
