import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { Field } from "@/components/field";
import { StatusBadge } from "@/components/status-badge";
import { requireMembership } from "@/server/guards";
import { listInvitations, listMembers } from "@/server/orgs";
import { inviteMemberAction } from "../../actions";
import { IntakeForm } from "../../intake-form";
import { TrackingPanel } from "../../tracking-panel";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const m = await requireMembership();
  const isOwner = m.memberRole === "owner";
  const [members, invites] = await Promise.all([
    listMembers(m.org.id),
    isOwner ? listInvitations(m.org.id) : [],
  ]);
  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description={isOwner ? undefined : "Only the organization owner can change settings."}
      />

      <section className="card space-y-4" aria-labelledby="team-h">
        <h2 id="team-h" className="text-lg font-semibold">
          Team
        </h2>
        <ul className="divide-y divide-hairline text-sm">
          {members.map((mem) => (
            <li key={mem.id} className="flex items-center justify-between py-2">
              <span>
                {mem.name} <span className="text-ink-2">({mem.email})</span>
              </span>
              <StatusBadge status={mem.role === "owner" ? "active" : "draft"} label={mem.role} />
            </li>
          ))}
          {invites.map((i) => (
            <li key={i.id} className="flex items-center justify-between py-2">
              <span className="text-ink-2">{i.email}</span>
              <StatusBadge status="pending" label="invited" />
            </li>
          ))}
        </ul>
        {isOwner ? (
          <ActionForm
            action={inviteMemberAction}
            submitLabel="Send invitation"
            buttonClassName="btn btn-secondary btn-sm"
          >
            <Field label="Invite a teammate by email" name="email" type="email" required />
          </ActionForm>
        ) : null}
      </section>

      <section className="card space-y-4" aria-labelledby="payment-h">
        <h2 id="payment-h" className="text-lg font-semibold">
          Payment method
        </h2>
        {m.org.paymentMethodReadyAt ? (
          <StatusBadge status="connected" label="On file with Stripe" />
        ) : (
          <p className="text-sm">
            <StatusBadge status="pending" label="Missing" />{" "}
            <a href="/onboarding/payment" className="link">
              Add a payment method
            </a>
          </p>
        )}
      </section>

      <section id="tracking" aria-labelledby="tracking-h" className="space-y-4">
        <h2 id="tracking-h" className="text-lg font-semibold">
          Tracking & revenue sources
        </h2>
        <TrackingPanel org={m.org} isOwner={isOwner} />
      </section>

      <section className="card space-y-4" aria-labelledby="biz-h">
        <h2 id="biz-h" className="text-lg font-semibold">
          Business details
        </h2>
        <IntakeForm org={m.org} returnTo="settings" readOnly={!isOwner} />
      </section>
    </div>
  );
}
