import { PageHeader } from "@/components/app-shell";
import { requireMembership } from "@/server/guards";
import { listBillingPeriods } from "@/server/reports";
import { InvoiceTable } from "../../invoice-table";

export const metadata = { title: "Invoices" };

export default async function InvoicesPage() {
  const m = await requireMembership();
  return (
    <>
      <PageHeader
        title="Invoices"
        description="One statement per calendar month (UTC). Months with no fee due produce no invoice."
      />
      <div className="card">
        <InvoiceTable rows={await listBillingPeriods(m.org.id)} />
      </div>
    </>
  );
}
