import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import type { ConnectorKind } from "@/db/schema";
import { availableConnectors } from "@/server/connectors";
import { requireOperator } from "@/server/guards";
import { getOrg } from "@/server/orgs";
import { createCampaignAction } from "../../../../actions";
import { CampaignFields } from "../../../../campaign-form";

export const metadata = { title: "New campaign" };

export default async function NewCampaign({ params }: { params: Promise<{ id: string }> }) {
  await requireOperator();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const org = await getOrg(id);
  if (!org) notFound();
  const kinds = new Set<ConnectorKind>();
  for (const p of ["meta", "google", "tiktok"] as const)
    for (const k of await availableConnectors(id, p)) kinds.add(k);
  return (
    <>
      <PageHeader
        title={`New campaign for ${org.name}`}
        description="The campaign is created paused on the platform. Launch it from the campaign page once reviewed."
      />
      <div className="card">
        <ActionForm action={createCampaignAction.bind(null, id)} submitLabel="Create campaign">
          <CampaignFields currency={org.currency} connectors={[...kinds]} />
        </ActionForm>
      </div>
    </>
  );
}
