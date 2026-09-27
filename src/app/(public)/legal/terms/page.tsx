import type { Metadata } from "next";
import { AGREEMENT_VERSION, renderAgreement } from "@/lib/agreement";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Outcome Ads";
  const sample = renderAgreement({
    appName,
    orgName: "[Your company]",
    feeRateBps: 1000,
    attributionWindowDays: 7,
    currency: "USD",
    dunningGraceDays: 14,
  });
  return (
    <div className="container-page max-w-3xl py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Performance agreement (template)</h1>
      <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Draft template, version {AGREEMENT_VERSION}. It has not yet been reviewed by counsel and is
        shown for transparency. Your actual agreement — with your fee rate and attribution window —
        is presented during onboarding.
      </p>
      <pre className="card mt-6 font-sans text-sm whitespace-pre-wrap text-ink-2">{sample}</pre>
    </div>
  );
}
