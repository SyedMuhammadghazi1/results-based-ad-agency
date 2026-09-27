import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { requireOperator } from "@/server/guards";
import { listAlerts } from "@/server/operator";
import { resolveAlertAction } from "../actions";

export const metadata = { title: "Alerts" };

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  await requireOperator();
  const all = (await searchParams).all === "1";
  const rows = await listAlerts({ open: !all });
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Budget caps, payment failures, dunning pauses, connector errors and manual actions."
        actions={
          <Link className="link text-sm" href={all ? "/operator/alerts" : "/operator/alerts?all=1"}>
            {all ? "Show open only" : "Show resolved too"}
          </Link>
        }
      />
      <div className="card overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing needs attention.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When (UTC)</th>
                <th scope="col">Severity</th>
                <th scope="col">Client</th>
                <th scope="col">Message</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ alert, orgName }) => (
                <tr key={alert.id}>
                  <td className="whitespace-nowrap">
                    {alert.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td>
                    <StatusBadge status={alert.severity} />
                  </td>
                  <td>
                    {alert.orgId ? (
                      <Link className="link" href={`/operator/orgs/${alert.orgId}`}>
                        {orgName}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{alert.message}</td>
                  <td>
                    {alert.resolvedAt ? (
                      <span className="text-xs text-muted">resolved</span>
                    ) : (
                      <ActionForm
                        action={resolveAlertAction.bind(null, alert.id)}
                        submitLabel="Resolve"
                        buttonClassName="btn btn-secondary btn-sm"
                        className=""
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
