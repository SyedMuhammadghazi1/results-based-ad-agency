import { PageHeader } from "@/components/app-shell";
import { requireOperator } from "@/server/guards";
import { listApplications } from "@/server/operator";

export const metadata = { title: "Applications" };

export default async function ApplicationsPage() {
  await requireOperator();
  const rows = await listApplications();
  return (
    <>
      <PageHeader title="Applications" description="Leads from the public apply form." />
      <div className="card overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-ink-2">No applications yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Received</th>
                <th scope="col">Company</th>
                <th scope="col">Contact</th>
                <th scope="col">Revenue / spend</th>
                <th scope="col">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{a.createdAt.toISOString().slice(0, 10)}</td>
                  <td>
                    {a.company}
                    <span className="block text-xs break-all text-ink-2">{a.website}</span>
                  </td>
                  <td>
                    {a.name}
                    <a className="link block text-xs" href={`mailto:${a.email}`}>
                      {a.email}
                    </a>
                  </td>
                  <td className="text-xs">
                    {a.monthlyRevenueBand} / {a.monthlyAdSpendBand}
                  </td>
                  <td className="max-w-sm text-xs whitespace-pre-wrap">{a.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
