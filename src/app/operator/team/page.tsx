import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { Field, Select } from "@/components/field";
import { requireAdmin } from "@/server/guards";
import { listStaff } from "@/server/operator";
import { setRoleAction } from "../actions";

export const metadata = { title: "Team" };

export default async function TeamPage() {
  await requireAdmin();
  const staff = await listStaff();
  return (
    <>
      <PageHeader
        title="Team"
        description="Agency staff. New staff sign up normally, then an admin grants the operator role here."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <ul className="divide-y divide-hairline text-sm">
            {staff.map((s) => (
              <li key={s.id} className="flex justify-between py-2">
                <span>
                  {s.name} <span className="text-ink-2">({s.email})</span>
                </span>
                <span className="badge bg-zinc-100 text-zinc-800">{s.role}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <ActionForm action={setRoleAction} submitLabel="Change role">
            <Field label="User email" name="email" type="email" required />
            <Select
              label="Role"
              name="role"
              options={[
                { value: "operator", label: "Operator" },
                { value: "admin", label: "Admin" },
                { value: "client", label: "Client (remove staff access)" },
              ]}
            />
          </ActionForm>
        </section>
      </div>
    </>
  );
}
