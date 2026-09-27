import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Outcome Ads";

export const metadata: Metadata = {
  title: { default: `${appName} — you only pay on revenue`, template: `%s · ${appName}` },
  description:
    "We build and run your paid ad campaigns. No retainer, no strategy meetings — you see one number, the revenue our ads generated, and pay a percentage of it.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#065f46",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
