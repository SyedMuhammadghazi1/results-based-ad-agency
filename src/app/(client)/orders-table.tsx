import { formatMinor } from "@/lib/money";
import type { AttributedOrder } from "@/server/reports";

export function OrdersTable({ rows }: { rows: AttributedOrder[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        No attributed orders yet. They appear here as soon as an ad-driven order comes in.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-nowrap" data-testid="orders-table">
        <thead>
          <tr>
            <th scope="col">Date (UTC)</th>
            <th scope="col">Order id</th>
            <th scope="col" className="text-right">
              Amount
            </th>
            <th scope="col">Campaign</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="whitespace-nowrap tabular">
                {o.occurredAt.toISOString().slice(0, 16).replace("T", " ")}
              </td>
              <td className="font-mono text-xs">{o.externalOrderId}</td>
              <td className="text-right tabular">
                {formatMinor(o.amountMinor - o.refundedMinor, o.currency)}
                {o.refundedMinor > 0 ? (
                  <span className="block text-xs text-muted">
                    {formatMinor(o.amountMinor, o.currency)} −{" "}
                    {formatMinor(o.refundedMinor, o.currency)} refunded
                  </span>
                ) : null}
              </td>
              <td>{o.campaignName ?? (o.platform ? `${o.platform} ads` : "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
