import { desc } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";
import { JOBS } from "@/jobs";
import { requireOperator } from "@/server/guards";
import { runJobAction } from "../actions";

export const metadata = { title: "Jobs" };

export default async function JobsPage() {
  await requireOperator();
  const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50);
  return (
    <>
      <PageHeader
        title="Background jobs"
        description="Scheduled via POST /api/cron/<job> with the CRON_SECRET bearer token. Monthly billing can only run from the scheduler or CLI."
      />
      <section className="card mb-6 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Schedule (UTC cron)</th>
              <th scope="col">
                <span className="sr-only">Run</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(JOBS).map(([name, j]) => (
              <tr key={name}>
                <td className="font-mono text-xs">{name}</td>
                <td className="font-mono text-xs">{j.schedule}</td>
                <td>
                  {name !== "monthly-billing" ? (
                    <ActionForm
                      action={runJobAction.bind(null, name)}
                      submitLabel="Run now"
                      buttonClassName="btn btn-secondary btn-sm"
                      className=""
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-lg font-semibold">Recent runs</h2>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Started (UTC)</th>
              <th scope="col">Job</th>
              <th scope="col">Status</th>
              <th scope="col">Summary</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  {r.startedAt.toISOString().slice(0, 19).replace("T", " ")}
                </td>
                <td className="font-mono text-xs">{r.job}</td>
                <td>
                  <StatusBadge
                    status={
                      r.status === "succeeded"
                        ? "active"
                        : r.status === "failed"
                          ? "error"
                          : "pending"
                    }
                    label={r.status}
                  />
                </td>
                <td className="max-w-md font-mono text-xs break-all">
                  {r.error ?? JSON.stringify(r.summary ?? {})}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
