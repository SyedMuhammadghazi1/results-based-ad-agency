import { PageHeader } from "@/components/app-shell";
import { requireOperator } from "@/server/guards";
import { auditEntries } from "@/server/operator";

export const metadata = { title: "Audit log" };

export default async function AuditPage() {
  await requireOperator();
  const rows = await auditEntries({ limit: 300 });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Sensitive actions by users, operators and background jobs (latest 300)."
      />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When (UTC)</th>
              <th scope="col">Actor</th>
              <th scope="col">Client</th>
              <th scope="col">Action</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, actorEmail, orgName }) => (
              <tr key={entry.id}>
                <td className="whitespace-nowrap">
                  {entry.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                </td>
                <td>{actorEmail ?? entry.actorRole ?? "system"}</td>
                <td>{orgName ?? "—"}</td>
                <td className="font-mono text-xs">{entry.action}</td>
                <td className="max-w-md font-mono text-xs break-all text-ink-2">
                  {Object.keys(entry.metadata).length ? JSON.stringify(entry.metadata) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
