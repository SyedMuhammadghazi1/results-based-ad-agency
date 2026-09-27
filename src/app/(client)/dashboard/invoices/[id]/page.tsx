import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { formatBps, formatMinor } from "@/lib/money";
import { requireMembership } from "@/server/guards";
import { getBillingPeriodForOrg } from "@/server/reports";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const m = await requireMembership();
  const { id } = await params;
  // Scoped to the member's org: another org's invoice id is simply "not found".
  const p = await getBillingPeriodForOrg(m.org.id, id);
  if (!p) notFound();
  const money = (n: number) => formatMinor(n, p.currency);
  const rows: Array<[string, string]> = [
    ["Attributed revenue (gross)", money(p.grossRevenueMinor)],
    ["Attributed revenue (net of same-period refunds)", money(p.netRevenueMinor)],
    ...p.feeLines.map((l): [string, string] => [
      `Fee at ${formatBps(l.feeRateBps)} of ${money(l.netRevenueMinor)}`,
      money(l.feeMinor),
    ]),
    ["Refund credit from earlier months", `− ${money(p.creditGeneratedMinor)}`],
    ["Credit carried in", `− ${money(p.creditCarriedInMinor)}`],
    ["Credit applied", `− ${money(p.creditAppliedMinor)}`],
    ["Credit carried forward", money(p.creditCarriedOutMinor)],
  ];
  return (
    <>
      <PageHeader
        title={`Statement ${p.periodStart.slice(0, 7)}`}
        description={`${p.periodStart} to ${p.periodEnd} (UTC)`}
      />
      <div className="card max-w-2xl space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-3xl font-semibold">{money(p.amountDueMinor)}</p>
          <StatusBadge status={p.status} />
        </div>
        <table className="table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th
                  scope="row"
                  className="!text-sm !font-normal !normal-case !tracking-normal text-ink-2"
                >
                  {k}
                </th>
                <td className="text-right tabular">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {p.hostedInvoiceUrl ? (
          <a
            className="btn btn-primary"
            href={p.hostedInvoiceUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            View / pay on Stripe
          </a>
        ) : null}
      </div>
    </>
  );
}
