import type { Metadata } from "next";
import { Suspense } from "react";
import { ForgotPasswordForm } from "../auth-forms";

export const metadata: Metadata = { title: "Forgot password" };

export default function Page() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
