import { ActionForm } from "@/components/action-form";
import { Field, TextArea } from "@/components/field";
import type { Organization } from "@/db/schema";
import { currencyExponent } from "@/lib/money";
import { getIntake } from "@/server/orgs";
import { saveIntakeAction } from "./actions";

function major(minor: number | undefined, currency: string) {
  if (minor === undefined) return undefined;
  const exp = currencyExponent(currency);
  return (minor / 10 ** exp).toFixed(exp);
}

export async function IntakeForm({
  org,
  returnTo,
  readOnly,
}: {
  org: Organization;
  returnTo?: "settings";
  readOnly?: boolean;
}) {
  const intake = await getIntake(org.id);
  return (
    <ActionForm
      action={saveIntakeAction}
      submitLabel={returnTo ? "Save details" : "Save and continue"}
      buttonClassName={readOnly ? "hidden" : "btn btn-primary"}
    >
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <fieldset disabled={readOnly} className="space-y-4">
        <Field
          label="Website"
          name="website"
          required
          defaultValue={intake?.website}
          placeholder="https://shop.example.com"
        />
        <TextArea
          label="Product / offer"
          name="productOffer"
          required
          rows={4}
          defaultValue={intake?.productOffer}
          hint="What you sell, who buys it, what makes it compelling, any current promotions."
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label={`Average order value (${org.currency})`}
            name="averageOrderValue"
            required
            inputMode="decimal"
            defaultValue={major(intake?.averageOrderValueMinor, org.currency)}
          />
          <Field
            label="Gross margin (%)"
            name="grossMarginPct"
            required
            type="number"
            min={0}
            max={100}
            step="0.1"
            defaultValue={intake ? String(intake.grossMarginBps / 100) : undefined}
          />
          <Field
            label={`Monthly ad spend cap (${org.currency})`}
            name="monthlySpendCap"
            required
            inputMode="decimal"
            defaultValue={major(intake?.monthlySpendCapMinor, org.currency)}
            hint="Hard limit. Campaigns pause when month-to-date spend reaches it."
          />
        </div>
        <Field
          label="Target countries / regions"
          name="targetGeos"
          required
          defaultValue={intake?.targetGeos.join(", ")}
          placeholder="US, CA, UK"
          hint="Comma separated."
        />
        <TextArea
          label="Creative asset links (optional)"
          name="creativeAssetLinks"
          rows={3}
          defaultValue={intake?.creativeAssetLinks.join("\n")}
          hint="One URL per line: product photos, videos, brand kit, shared drive folders."
        />
      </fieldset>
    </ActionForm>
  );
}
