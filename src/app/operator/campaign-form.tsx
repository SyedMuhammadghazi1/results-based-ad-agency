import { Field, Select, TextArea } from "@/components/field";
import type { Campaign, ConnectorKind } from "@/db/schema";
import { currencyExponent } from "@/lib/money";

export function CampaignFields({
  campaign,
  currency,
  connectors,
}: {
  campaign?: Campaign;
  currency: string;
  connectors?: ConnectorKind[];
}) {
  const exp = currencyExponent(currency);
  return (
    <div className="space-y-4">
      <Field label="Campaign name" name="name" required defaultValue={campaign?.name} />
      <div className="grid gap-4 sm:grid-cols-3">
        {campaign ? (
          <input type="hidden" name="platform" value={campaign.platform} />
        ) : (
          <Select
            label="Platform"
            name="platform"
            options={[
              { value: "meta", label: "Meta (Facebook & Instagram)" },
              { value: "google", label: "Google Ads" },
              { value: "tiktok", label: "TikTok" },
            ]}
          />
        )}
        <Select
          label="Objective"
          name="objective"
          defaultValue={campaign?.objective ?? "sales"}
          options={[
            { value: "sales", label: "Sales" },
            { value: "leads", label: "Leads" },
            { value: "traffic", label: "Traffic" },
            { value: "awareness", label: "Awareness" },
          ]}
        />
        <Field
          label={`Daily budget (${currency})`}
          name="dailyBudget"
          required
          inputMode="decimal"
          defaultValue={campaign ? (campaign.dailyBudgetMinor / 10 ** exp).toFixed(exp) : undefined}
        />
        {connectors ? (
          <Select
            label="Connector"
            name="connector"
            hint="Real API connectors appear once credentials and the client's ad account are connected."
            options={connectors.map((c) => ({ value: c, label: c }))}
          />
        ) : null}
      </div>
      <Field
        label="Landing page URL"
        name="landingUrl"
        type="url"
        required
        defaultValue={campaign?.landingUrl}
      />
      <TextArea
        label="Targeting notes"
        name="targetingNotes"
        rows={3}
        defaultValue={campaign?.targetingNotes}
      />
      <TextArea
        label="Creatives"
        name="creatives"
        rows={4}
        defaultValue={campaign?.creatives
          .map((c) => `${c.name} | ${c.url} | ${c.format}`)
          .join("\n")}
        hint="One per line: name | https://asset-url | image, video, carousel or text"
      />
    </div>
  );
}
