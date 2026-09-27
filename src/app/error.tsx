"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="container-page py-24 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-ink-2">
        We&apos;ve been notified. Please try again.
        {error.digest ? (
          <span className="mt-1 block text-xs text-muted">Reference: {error.digest}</span>
        ) : null}
      </p>
      <button type="button" onClick={reset} className="btn btn-primary mt-6">
        Try again
      </button>
    </main>
  );
}
