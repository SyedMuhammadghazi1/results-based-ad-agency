import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
