import type { ReactNode } from "react";
import { Logo } from "@/components/site-chrome";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-12">
      <Logo />
      <main id="main" className="mt-8 w-full max-w-md">
        {children}
      </main>
    </div>
  );
}
