"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

const MIN_PASSWORD = 10;

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );
}

function Input({
  id,
  label,
  type = "text",
  autoComplete,
  hint,
  minLength,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  hint?: ReactNode;
  minLength?: number;
}) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        required
        minLength={minLength}
        autoComplete={autoComplete}
        className="input"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function useSubmit(fn: (fd: FormData) => Promise<string | null>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const err = await fn(new FormData(e.currentTarget));
      if (err) setError(err);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }
  return { error, pending, onSubmit };
}

export function SignInForm() {
  const router = useRouter();
  const { error, pending, onSubmit } = useSubmit(async (fd) => {
    const res = await authClient.signIn.email({
      email: String(fd.get("email")),
      password: String(fd.get("password")),
    });
    if (res.error)
      return res.error.status === 429
        ? "Too many attempts. Wait a minute and retry."
        : "Incorrect email or password.";
    router.push("/app");
    router.refresh();
    return null;
  });
  return (
    <form onSubmit={onSubmit} className="card space-y-4">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <Input id="email" label="Email" type="email" autoComplete="email" />
      <Input id="password" label="Password" type="password" autoComplete="current-password" />
      <ErrorBox message={error} />
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="flex justify-between text-sm">
        <Link href="/forgot-password" className="link">
          Forgot password?
        </Link>
        <Link href="/sign-up" className="link">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const { error, pending, onSubmit } = useSubmit(async (fd) => {
    const password = String(fd.get("password"));
    if (password.length < MIN_PASSWORD)
      return `Use at least ${MIN_PASSWORD} characters for your password.`;
    const res = await authClient.signUp.email({
      name: String(fd.get("name")),
      email: String(fd.get("email")),
      password,
    });
    if (res.error) {
      if (res.error.status === 429) return "Too many attempts. Wait a minute and retry.";
      return res.error.message ?? "Could not create the account.";
    }
    router.push(next && next.startsWith("/invite/") ? next : "/onboarding/organization");
    router.refresh();
    return null;
  });
  return (
    <form onSubmit={onSubmit} className="card space-y-4">
      <h1 className="text-xl font-semibold">Create your account</h1>
      <Input id="name" label="Full name" autoComplete="name" />
      <Input id="email" label="Work email" type="email" autoComplete="email" />
      <Input
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD}
        hint={`At least ${MIN_PASSWORD} characters.`}
      />
      <ErrorBox message={error} />
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </button>
      <p className="text-sm text-ink-2">
        Already have an account?{" "}
        <Link href="/sign-in" className="link">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const { error, pending, onSubmit } = useSubmit(async (fd) => {
    await authClient.requestPasswordReset({
      email: String(fd.get("email")),
      redirectTo: "/reset-password",
    });
    // Always the same answer, so the form can't be used to discover accounts.
    setSent(true);
    return null;
  });
  if (sent) {
    return (
      <div className="card" role="status">
        <h1 className="text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-ink-2">
          If an account exists for that address, we sent a link to reset the password.
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="card space-y-4">
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <Input id="email" label="Email" type="email" autoComplete="email" />
      <ErrorBox message={error} />
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        Send reset link
      </button>
    </form>
  );
}

export function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const { error, pending, onSubmit } = useSubmit(async (fd) => {
    if (!token) return "This reset link is invalid.";
    const newPassword = String(fd.get("password"));
    if (newPassword.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
    const res = await authClient.resetPassword({ newPassword, token });
    if (res.error) return "This reset link is invalid or has expired.";
    router.push("/sign-in");
    return null;
  });
  return (
    <form onSubmit={onSubmit} className="card space-y-4">
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <Input
        id="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD}
      />
      <ErrorBox message={error} />
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        Save password
      </button>
    </form>
  );
}
