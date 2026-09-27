import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { formatMinor } from "@/lib/money";
import { requireOperator } from "@/server/guards";
import { listClientOrgs } from "@/server/operator";

export const metadata = { title: "Clients" };

export default async function OperatorHome() {
  await requireOperator();
  const rows = await listClientOrgs();
  return (
    <>
      <PageHeader
        title="Clients"
        description="Internal view — spend, ROAS and pacing are never shown to clients. Month-to-date figures, UTC."
      />
      <div className="card overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-2">No clients yet.</p>
        ) : (
          <table className="table" data-testid="clients-table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Status</th>
                <th scope="col">Onboarding</th>
                <th scope="col" className="text-right">
                  Revenue MTD
                </th>
                <th scope="col" className="text-right">
                  Spend MTD
                </th>
                <th scope="col" className="text-right">
                  ROAS
                </th>
                <th scope="col" className="text-right">
                  Cap used
                </th>
                <th scope="col" className="text-right">
                  Live campaigns
                </th>
                <th scope="col" className="text-right">
                  Open alerts
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.org.id}>
                  <td>
                    <Link href={`/operator/orgs/${r.org.id}`} className="link">
                      {r.org.name}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge
                      status={r.org.dunningPausedAt ? "payment_failed" : r.org.status}
                      label={r.org.dunningPausedAt ? "dunning" : undefined}
                    />
                  </td>
                  <td className="text-ink-2">
                    {r.onboarding.complete ? "Complete" : `Next: ${r.onboarding.next?.label}`}
                  </td>
                  <td className="text-right tabular">
                    {formatMinor(r.revenueMtdMinor, r.org.currency)}
                  </td>
                  <td className="text-right tabular">
                    {formatMinor(r.spendMtdMinor, r.org.currency)}
                  </td>
                  <td className="text-right tabular">
                    {r.roas === null ? "—" : `${r.roas.toFixed(2)}×`}
                  </td>
                  <td className="text-right tabular">
                    {r.pacing ? (
                      <span
                        className={
                          r.budgetState === "reached"
                            ? "font-semibold text-red-800"
                            : r.budgetState === "near"
                              ? "text-amber-900"
                              : ""
                        }
                      >
                        {(r.pacing.capUsedBps / 100).toFixed(0)}%
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="text-right tabular">{r.activeCampaigns}</td>
                  <td className="text-right tabular">{r.openAlerts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
