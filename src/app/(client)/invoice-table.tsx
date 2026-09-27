import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import type { BillingPeriod } from "@/db/schema";
import { formatMinor } from "@/lib/money";

export function InvoiceTable({ rows }: { rows: BillingPeriod[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        No statements yet. Your first one is issued on the 1st of next month.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-nowrap">
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col" className="text-right">
              Attributed revenue
            </th>
            <th scope="col" className="text-right">
              Amount due
            </th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.periodStart.slice(0, 7)}</td>
              <td className="text-right tabular">{formatMinor(p.netRevenueMinor, p.currency)}</td>
              <td className="text-right tabular">{formatMinor(p.amountDueMinor, p.currency)}</td>
              <td>
                <StatusBadge
                  status={p.status}
                  label={p.status === "no_charge" ? "no charge" : undefined}
                />
              </td>
              <td className="space-x-3 whitespace-nowrap">
                <Link href={`/dashboard/invoices/${p.id}`} className="link">
                  Details
                </Link>
                {p.hostedInvoiceUrl ? (
                  <a
                    href={p.hostedInvoiceUrl}
                    className="link"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Stripe invoice
                  </a>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
