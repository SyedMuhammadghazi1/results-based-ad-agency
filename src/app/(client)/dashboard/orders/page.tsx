import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { requireMembership } from "@/server/guards";
import { attributedOrders } from "@/server/reports";
import { OrdersTable } from "../../orders-table";

export const metadata = { title: "Attributed orders" };
const PAGE_SIZE = 50;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const m = await requireMembership();
  const page = Math.max(1, Math.min(Number((await searchParams).page) || 1, 10_000));
  const { rows, hasMore } = await attributedOrders(m.org.id, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  return (
    <>
      <PageHeader
        title="Attributed orders"
        description="Every order we attribute to our ads — the exact list your fee is calculated from. Amounts are net of refunds, excluding tax."
      />
      <div className="card">
        <OrdersTable rows={rows} />
        <nav className="mt-4 flex justify-between text-sm" aria-label="Pagination">
          {page > 1 ? (
            <Link className="link" href={`/dashboard/orders?page=${page - 1}`}>
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          {hasMore ? (
            <Link className="link" href={`/dashboard/orders?page=${page + 1}`}>
              Older →
            </Link>
          ) : null}
        </nav>
      </div>
    </>
  );
}
