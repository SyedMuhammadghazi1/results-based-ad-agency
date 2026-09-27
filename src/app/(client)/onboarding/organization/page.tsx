import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { Field, Select } from "@/components/field";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { findMembership, requireRole } from "@/server/guards";
import { createOrgAction } from "../../actions";

export const metadata = { title: "Organization" };

export default async function OrganizationStep() {
  const user = await requireRole(["client"]);
  const m = await findMembership(user.id);
  if (m) {
    return (
      <div className="card">
        <h1 className="text-xl font-semibold">{m.org.name}</h1>
        <p className="mt-2 text-sm text-ink-2">
          Your organization is set up. Currency: <strong>{m.org.currency}</strong>.
        </p>
        <Link href="/onboarding/intake" className="btn btn-primary mt-4">
          Continue
        </Link>
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title="Create your organization"
        description="Teammates you invite later will see the same revenue dashboard."
      />
      <div className="card max-w-xl">
        <ActionForm action={createOrgAction} submitLabel="Create organization">
          <Field label="Company name" name="name" required autoComplete="organization" />
          <Select
            label="Reporting & billing currency"
            name="currency"
            defaultValue="USD"
            hint="Revenue is tracked and billed in one currency. Orders in other currencies are rejected."
            options={SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }))}
          />
        </ActionForm>
      </div>
    </>
  );
}
