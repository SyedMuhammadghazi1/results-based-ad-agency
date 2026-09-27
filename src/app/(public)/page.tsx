import Link from "next/link";
import { FeeCalculator } from "@/components/fee-calculator";
import { env } from "@/env";

const steps = [
  {
    title: "Tell us about your offer",
    body: "Ten minutes of onboarding: your site, what you sell, average order value, margins, target markets and a hard monthly ad-spend cap.",
  },
  {
    title: "We build and run the campaigns",
    body: "Our operators create, launch and optimise your Meta, Google and TikTok campaigns on ad accounts you own. You pay the platforms directly — no markup.",
  },
  {
    title: "You see one number",
    body: "Revenue our ads generated, order by order. No decks, no impressions, no CTR. You pay a percentage of that number — and nothing when it's zero.",
  },
];

export default function LandingPage() {
  const rate = env.DEFAULT_FEE_RATE_BPS ?? 1000;
  return (
    <>
      <section className="bg-white">
        <div className="container-page grid gap-10 py-16 md:grid-cols-2 md:items-center">
          <div>
            <p className="badge bg-brand-50 text-brand-800">
              No retainer · No minimums · No strategy meetings
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
              Ads that pay for themselves — or cost you nothing.
            </h1>
            <p className="mt-4 text-lg text-ink-2">
              We build and run your paid campaigns. You get one report: the revenue our ads
              generated. You pay {rate / 100}% of it. That&apos;s the whole relationship.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/sign-up" className="btn btn-primary">
                Get started
              </Link>
              <Link href="/apply" className="btn btn-secondary">
                Talk to us first
              </Link>
            </div>
          </div>
          <div className="card">
            <p className="text-sm text-ink-2">Attributed revenue this month</p>
            <p className="mt-1 text-5xl font-semibold tracking-tight">$84,210</p>
            <p className="mt-2 text-sm text-ink-2">312 attributed orders · fee accrued $8,421</p>
            <p className="mt-6 text-xs text-muted">
              Illustrative dashboard. Your dashboard shows exactly this — and every order behind it.
            </p>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="container-page py-16">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <ol className="mt-8 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="card">
              <p className="text-sm font-semibold text-brand-700">Step {i + 1}</p>
              <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="bg-white">
        <div className="container-page grid gap-10 py-16 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Pay only on revenue</h2>
            <ul className="mt-6 space-y-4 text-ink-2">
              <li>
                <strong className="text-ink">Only ad-driven revenue counts.</strong> An order is
                attributed only when the buyer clicked one of our ads within the attribution window
                (7 days by default). Organic, direct and email sales are never billed.
              </li>
              <li>
                <strong className="text-ink">Refunds come back to you.</strong> Refunded orders
                reduce the bill; if we already billed them, you get a credit.
              </li>
              <li>
                <strong className="text-ink">Your spend, your accounts, your cap.</strong> You pay
                the ad platforms directly and set a hard monthly limit. We pause campaigns
                automatically when it&apos;s reached.
              </li>
              <li>
                <strong className="text-ink">Every order is auditable.</strong> Date, order id,
                amount and campaign — for every dollar you&apos;re billed on.
              </li>
            </ul>
          </div>
          <FeeCalculator defaultRateBps={rate} />
        </div>
      </section>

      <section className="container-page py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Ready when you are</h2>
        <p className="mx-auto mt-2 max-w-xl text-ink-2">
          Sign up, accept the performance agreement, install one script and connect your store. We
          take it from there.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/sign-up" className="btn btn-primary">
            Create your account
          </Link>
          <Link href="/faq" className="btn btn-secondary">
            Read the FAQ
          </Link>
        </div>
      </section>
    </>
  );
}
