import type { Metadata } from "next";

export const metadata: Metadata = { title: "FAQ" };

const faqs: Array<{ q: string; a: string }> = [
  {
    q: "What exactly do I pay?",
    a: "A percentage (10% by default) of attributed revenue — revenue from orders whose buyer clicked one of our ads shortly before buying. Billed monthly in arrears, charged automatically. No retainer, no setup fee, no minimum.",
  },
  {
    q: "Who pays for the ads?",
    a: "You do, directly to Meta, Google or TikTok, on ad accounts you own. We never mark up media. You set a hard monthly spend cap during onboarding and we pause campaigns automatically when month-to-date spend reaches it.",
  },
  {
    q: "How is revenue attributed?",
    a: "Our first-party script records clicks that carry our campaign identifier. When an order arrives from your store, payment processor or server, we credit it to the most recent click on one of our ads within the attribution window (7 days by default). If there is no such click, the order is not attributed and you pay nothing on it.",
  },
  {
    q: "Why can't I see impressions, CTR or ROAS?",
    a: "On purpose. Those numbers are our problem, not yours. Your dashboard shows revenue our ads generated and every order behind it, so you can audit each dollar you're billed on.",
  },
  {
    q: "What happens with refunds?",
    a: "Refunds reduce attributed revenue. If the original order was already billed, the fee on the refunded amount becomes a credit on your next invoice. We never send negative invoices.",
  },
  {
    q: "Are there strategy meetings?",
    a: "No. Tell us about your offer once during onboarding and update your details any time. We'll only reach out when we need something (new creatives, a store change) — never for a status call.",
  },
  {
    q: "Which stores and payment processors work?",
    a: "Shopify (webhooks), Stripe (webhooks from your own Stripe account) and anything else through our server-to-server conversions API.",
  },
  {
    q: "Can I leave?",
    a: "Any time. Fees remain due only for attributed revenue from ad clicks that happened before you left, within the attribution window.",
  },
];

export default function FaqPage() {
  return (
    <div className="container-page max-w-3xl py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Frequently asked questions</h1>
      <div className="mt-8 space-y-3">
        {faqs.map((f) => (
          <details key={f.q} className="card group">
            <summary className="cursor-pointer text-base font-semibold text-ink">{f.q}</summary>
            <p className="mt-3 text-ink-2">{f.a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
