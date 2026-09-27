import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "../auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function Page() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
