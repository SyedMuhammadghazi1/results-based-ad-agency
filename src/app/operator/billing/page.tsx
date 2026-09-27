import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { formatMinor } from "@/lib/money";
import { requireOperator } from "@/server/guards";
import { billingOverview } from "@/server/operator";

export const metadata = { title: "Billing" };

export default async function BillingPage() {
  await requireOperator();
  const rows = await billingOverview();
  const overdue = rows.filter((r) => r.overdue);
  return (
    <>
      <PageHeader
        title="Billing"
        description={`${rows.length} statements · ${overdue.length} overdue. Statements are created by the monthly-billing job on the 1st (UTC).`}
      />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Client</th>
              <th scope="col" className="text-right">
                Net revenue
              </th>
              <th scope="col" className="text-right">
                Fee
              </th>
              <th scope="col" className="text-right">
                Credit applied
              </th>
              <th scope="col" className="text-right">
                Due
              </th>
              <th scope="col">Status</th>
              <th scope="col">Stripe</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ period: p, orgName, overdue: late }) => (
              <tr key={p.id}>
                <td>{p.periodStart.slice(0, 7)}</td>
                <td>
                  <Link className="link" href={`/operator/orgs/${p.orgId}`}>
                    {orgName}
                  </Link>
                </td>
                <td className="text-right tabular">{formatMinor(p.netRevenueMinor, p.currency)}</td>
                <td className="text-right tabular">{formatMinor(p.grossFeeMinor, p.currency)}</td>
                <td className="text-right tabular">
                  {formatMinor(p.creditAppliedMinor, p.currency)}
                </td>
                <td className="text-right tabular">{formatMinor(p.amountDueMinor, p.currency)}</td>
                <td className="space-x-1">
                  <StatusBadge status={p.status} />
                  {late ? <StatusBadge status="payment_failed" label="overdue" /> : null}
                  {p.lastPaymentError ? (
                    <span className="block text-xs text-red-800">{p.lastPaymentError}</span>
                  ) : null}
                </td>
                <td>
                  {p.hostedInvoiceUrl ? (
                    <a
                      className="link"
                      href={p.hostedInvoiceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Invoice
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
