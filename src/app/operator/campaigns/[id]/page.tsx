import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { CopyField } from "@/components/copy-field";
import { StatusBadge } from "@/components/status-badge";
import { db } from "@/db";
import { adSpendDaily } from "@/db/schema";
import { formatMinor } from "@/lib/money";
import { buildTrackedLandingUrl, trackingUrlTemplate } from "@/lib/tracking";
import { getCampaign, launchBlocker } from "@/server/campaigns";
import { requireOperator } from "@/server/guards";
import { getOrg } from "@/server/orgs";
import { campaignStatusAction, syncSpendAction, updateCampaignAction } from "../../actions";
import { CampaignFields } from "../../campaign-form";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOperator();
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) notFound();
  const org = (await getOrg(campaign.orgId))!;
  const tmpl = trackingUrlTemplate(campaign.platform, campaign.trackingCode, campaign.landingUrl);
  const blocker = campaign.status !== "active" ? await launchBlocker(org.id) : null;
  const spend = await db
    .select()
    .from(adSpendDaily)
    .where(and(eq(adSpendDaily.campaignId, id)))
    .orderBy(desc(adSpendDaily.date))
    .limit(14);

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={
          <>
            <Link href={`/operator/orgs/${org.id}`} className="link">
              {org.name}
            </Link>{" "}
            · {campaign.platform} · {campaign.objective} · connector: {campaign.connector}
            {campaign.externalId ? ` · platform id ${campaign.externalId}` : ""}
          </>
        }
        actions={
          <StatusBadge
            status={campaign.status}
            label={
              campaign.pausedReason && campaign.status === "paused"
                ? `paused (${campaign.pausedReason})`
                : undefined
            }
          />
        }
      />

      <section className="card space-y-3" aria-labelledby="actions-h">
        <h2 id="actions-h" className="text-lg font-semibold">
          Actions
        </h2>
        {blocker ? <p className="text-sm text-amber-900">Launch blocked: {blocker}</p> : null}
        <div className="flex flex-wrap gap-3">
          {campaign.status !== "active" && campaign.status !== "archived" ? (
            <ActionForm
              action={campaignStatusAction.bind(null, id, "active")}
              submitLabel={campaign.status === "draft" ? "Launch" : "Resume"}
              className=""
            />
          ) : null}
          {campaign.status === "active" ? (
            <ActionForm
              action={campaignStatusAction.bind(null, id, "paused")}
              submitLabel="Pause"
              buttonClassName="btn btn-secondary"
              className=""
            />
          ) : null}
          {campaign.status !== "archived" ? (
            <ActionForm
              action={campaignStatusAction.bind(null, id, "archived")}
              submitLabel="Archive"
              buttonClassName="btn btn-secondary"
              className=""
            />
          ) : null}
          <ActionForm
            action={syncSpendAction.bind(null, id)}
            submitLabel="Sync spend (7 days)"
            buttonClassName="btn btn-secondary"
            className=""
          />
        </div>
      </section>

      <section className="card space-y-3" aria-labelledby="tracking-h">
        <h2 id="tracking-h" className="text-lg font-semibold">
          Tracking
        </h2>
        <p className="text-sm text-ink-2">
          Every click must carry <code>oa_cid={campaign.trackingCode}</code> — otherwise the revenue
          is not attributable (and not billable). {tmpl.notes}
        </p>
        <CopyField value={tmpl.template} label="URL parameters / tracking template" />
        <CopyField
          value={buildTrackedLandingUrl(campaign.landingUrl, campaign.trackingCode)}
          label="Tagged landing URL"
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card lg:col-span-2" aria-labelledby="edit-h">
          <h2 id="edit-h" className="mb-3 text-lg font-semibold">
            Edit
          </h2>
          <ActionForm action={updateCampaignAction.bind(null, id)} submitLabel="Save changes">
            <CampaignFields campaign={campaign} currency={campaign.currency} />
          </ActionForm>
        </section>
        <section className="card" aria-labelledby="spend-h">
          <h2 id="spend-h" className="mb-3 text-lg font-semibold">
            Recent spend (internal)
          </h2>
          {spend.length === 0 ? (
            <p className="text-sm text-ink-2">No spend synced yet.</p>
          ) : (
            <table className="table">
              <tbody>
                {spend.map((s) => (
                  <tr key={s.id}>
                    <td>{s.date}</td>
                    <td className="text-right tabular">{formatMinor(s.spendMinor, s.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
