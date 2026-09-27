import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <div className="container-page max-w-3xl space-y-4 py-12 text-ink-2">
      <h1 className="text-3xl font-semibold tracking-tight text-ink">Privacy</h1>
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        Placeholder summary pending legal review — see docs/LAUNCH_CHECKLIST.md.
      </p>
      <p>
        <strong className="text-ink">Tracking script.</strong> Our script sets one first-party
        cookie (<code>oa_vid</code>, a random visitor id) on our clients&apos; websites and records
        ad-click parameters (utm_*, gclid, fbclid, ttclid, oa_cid) with the landing page path. We do
        not store IP addresses, full URLs or query strings beyond those parameters.
      </p>
      <p>
        <strong className="text-ink">Orders.</strong> From our clients&apos; stores we receive order
        ids, amounts, timestamps and the visitor id. We do not receive or store buyer names, emails,
        addresses or payment details.
      </p>
      <p>
        <strong className="text-ink">Consent.</strong> Clients are responsible for obtaining any
        consent required in their jurisdiction (e.g. under ePrivacy/GDPR) before loading the script.
      </p>
    </div>
  );
}
