import Link from "next/link";
import { RevenueColumnChart } from "@/components/charts";
import { StatusBadge } from "@/components/status-badge";
import { formatBps, formatMinor } from "@/lib/money";
import { requireMembership } from "@/server/guards";
import { activeAgreement, onboardingFor } from "@/server/orgs";
import { attributedOrders, clientSummary, listBillingPeriods } from "@/server/reports";
import { InvoiceTable } from "../invoice-table";
import { OrdersTable } from "../orders-table";

export const metadata = { title: "Revenue" };

/** Revenue only, by design: no spend, impressions, clicks, CTR, CPC or ROAS. */
export default async function DashboardPage() {
  const m = await requireMembership();
  const agreement = await activeAgreement(m.org.id);
  const [summary, orders, invoices, progress] = await Promise.all([
    clientSummary(m.org, new Date(), agreement?.feeRateBps ?? null),
    attributedOrders(m.org.id, { limit: 10 }),
    listBillingPeriods(m.org.id),
    onboardingFor(m.org),
  ]);
  const money = (n: number) => formatMinor(n, summary.currency);

  return (
    <div className="space-y-6">
      {!progress.complete && progress.next ? (
        <div
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <strong>One more step before campaigns go live:</strong>{" "}
          {progress.next.label.toLowerCase()}.{" "}
          <Link href={progress.next.href} className="link">
            Finish setup
          </Link>
        </div>
      ) : null}

      <section className="card" aria-labelledby="hero-label">
        <p id="hero-label" className="text-sm text-ink-2">
          Attributed revenue · {summary.monthKey} (UTC)
        </p>
        <p
          className="mt-1 text-5xl font-semibold tracking-tight text-ink sm:text-6xl"
          data-testid="revenue-this-month"
        >
          {money(summary.revenueThisMonthMinor)}
        </p>
        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-ink-2">Attributed orders this month</dt>
            <dd className="text-2xl font-semibold" data-testid="orders-this-month">
              {summary.attributedOrdersThisMonth.toLocaleString("en-US")}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-2">
              Fee accrued this month
              {summary.feeRateBps ? ` (${formatBps(summary.feeRateBps)})` : ""}
            </dt>
            <dd className="text-2xl font-semibold" data-testid="fee-accrued">
              {money(summary.feeAccruedThisMonthMinor)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-2">Refund credit available</dt>
            <dd className="text-2xl font-semibold">{money(summary.creditBalanceMinor)}</dd>
          </div>
        </dl>
      </section>

      <section className="card" aria-labelledby="trend-h">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="trend-h" className="text-lg font-semibold">
            Last 30 days
          </h2>
          <p className="text-sm text-ink-2">
            {money(summary.last30DaysTotalMinor)} attributed revenue
          </p>
        </div>
        <RevenueColumnChart
          data={summary.last30Days}
          currency={summary.currency}
          title="Daily attributed revenue, last 30 days"
        />
      </section>

      <section className="card" aria-labelledby="orders-h">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="orders-h" className="text-lg font-semibold">
            Latest attributed orders
          </h2>
          <Link href="/dashboard/orders" className="link text-sm">
            All orders
          </Link>
        </div>
        <OrdersTable rows={orders.rows} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card" aria-labelledby="inv-h">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="inv-h" className="text-lg font-semibold">
              Invoices
            </h2>
            <Link href="/dashboard/invoices" className="link text-sm">
              All invoices
            </Link>
          </div>
          <InvoiceTable rows={invoices.slice(0, 3)} />
        </section>
        <section className="card space-y-3" aria-labelledby="setup-h">
          <h2 id="setup-h" className="text-lg font-semibold">
            Tracking & agreement
          </h2>
          <p className="text-sm">
            Tracking:{" "}
            {m.org.trackingLastSeenAt ? (
              <StatusBadge status="connected" label="installed" />
            ) : (
              <StatusBadge status="pending" label="not seen yet" />
            )}{" "}
            <Link href="/dashboard/settings#tracking" className="link">
              Snippet & sources
            </Link>
          </p>
          {agreement ? (
            <p className="text-sm text-ink-2">
              {formatBps(agreement.feeRateBps)} of attributed revenue ·{" "}
              {agreement.attributionWindowDays}-day click window · accepted{" "}
              {agreement.acceptedAt.toISOString().slice(0, 10)}.{" "}
              <Link href="/dashboard/agreement" className="link">
                View agreement
              </Link>
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
