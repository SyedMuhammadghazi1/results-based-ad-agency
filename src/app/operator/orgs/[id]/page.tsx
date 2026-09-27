import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/app-shell";
import { DualLineChart } from "@/components/charts";
import { Field } from "@/components/field";
import { StatusBadge } from "@/components/status-badge";
import { formatBps, formatMinor } from "@/lib/money";
import { launchBlocker, listCampaigns, monthToDateSpend } from "@/server/campaigns";
import { googleAppConfigured, metaAppConfigured } from "@/server/connectors";
import { requireOperator } from "@/server/guards";
import { getIntegration } from "@/server/integrations";
import { listAlerts, orgPerformance } from "@/server/operator";
import { activeAgreement, getIntake, getOrg, onboardingFor } from "@/server/orgs";
import { listBillingPeriods } from "@/server/reports";
import { setAdAccountAction, setOfferAction } from "../../actions";

export const metadata = { title: "Client" };

export default async function OrgDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireOperator();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const org = await getOrg(id);
  if (!org) notFound();
  const [
    progress,
    intake,
    agreement,
    campaigns,
    perf,
    periods,
    alerts,
    blocker,
    mtdSpend,
    meta,
    google,
  ] = await Promise.all([
    onboardingFor(org),
    getIntake(id),
    activeAgreement(id),
    listCampaigns(id),
    orgPerformance(id),
    listBillingPeriods(id),
    listAlerts({ orgId: id, open: true }),
    launchBlocker(id),
    monthToDateSpend(id),
    getIntegration(id, "meta_ads"),
    getIntegration(id, "google_ads"),
  ]);
  const money = (n: number) => formatMinor(n, org.currency);

  return (
    <div className="space-y-6">
      <PageHeader
        title={org.name}
        description={`${org.currency} · created ${org.createdAt.toISOString().slice(0, 10)} · public key ${org.publicKey}`}
        actions={
          <Link href={`/operator/orgs/${id}/campaigns/new`} className="btn btn-primary">
            New campaign
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card lg:col-span-2" aria-labelledby="perf-h">
          <h2 id="perf-h" className="mb-1 text-lg font-semibold">
            Spend vs attributed revenue · last 30 days
          </h2>
          <p className="mb-3 text-sm text-ink-2">
            Revenue {money(perf.totalRevenueMinor)} · spend {money(perf.totalSpendMinor)} · ROAS{" "}
            {perf.roas === null ? "—" : `${perf.roas.toFixed(2)}×`}
          </p>
          <DualLineChart
            currency={org.currency}
            title="Daily attributed revenue and ad spend, last 30 days"
            series={[
              {
                name: "Attributed revenue",
                label: "Revenue",
                color: "var(--color-series-1)",
                points: perf.revenue,
              },
              {
                name: "Ad spend",
                label: "Spend",
                color: "var(--color-series-2)",
                points: perf.spend,
              },
            ]}
          />
        </section>
        <section className="card space-y-3" aria-labelledby="status-h">
          <h2 id="status-h" className="text-lg font-semibold">
            Status
          </h2>
          <ul className="space-y-1 text-sm">
            {progress.steps.map((s) => (
              <li key={s.id} className="flex items-center justify-between">
                {s.label}{" "}
                <StatusBadge
                  status={s.done ? "active" : "pending"}
                  label={s.done ? "done" : "to do"}
                />
              </li>
            ))}
          </ul>
          <p className="text-sm">
            Spend cap:{" "}
            {intake
              ? `${money(mtdSpend)} of ${money(intake.monthlySpendCapMinor)} this month`
              : "—"}
          </p>
          {org.dunningPausedAt ? (
            <StatusBadge status="payment_failed" label="Paused for unpaid invoices" />
          ) : null}
          {blocker ? (
            <p className="text-sm text-amber-900">Launch blocked: {blocker}</p>
          ) : (
            <p className="text-sm text-green-900">Ready to launch campaigns.</p>
          )}
        </section>
      </div>

      <section className="card overflow-x-auto" aria-labelledby="camp-h">
        <h2 id="camp-h" className="mb-3 text-lg font-semibold">
          Campaigns
        </h2>
        {campaigns.length === 0 ? (
          <p className="text-sm text-ink-2">No campaigns yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Platform</th>
                <th scope="col">Connector</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">
                  Daily budget
                </th>
                <th scope="col">oa_cid</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link className="link" href={`/operator/campaigns/${c.id}`}>
                      {c.name}
                    </Link>
                  </td>
                  <td>{c.platform}</td>
                  <td>{c.connector}</td>
                  <td>
                    <StatusBadge
                      status={c.status}
                      label={
                        c.pausedReason && c.status === "paused"
                          ? `paused (${c.pausedReason.replace("_", " ")})`
                          : undefined
                      }
                    />
                  </td>
                  <td className="text-right tabular">{money(c.dailyBudgetMinor)}</td>
                  <td className="font-mono text-xs">{c.trackingCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-3" aria-labelledby="intake-h">
          <h2 id="intake-h" className="text-lg font-semibold">
            Intake
          </h2>
          {intake ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-2">Website</dt>
              <dd className="break-all">{intake.website}</dd>
              <dt className="text-ink-2">Offer</dt>
              <dd className="whitespace-pre-wrap">{intake.productOffer}</dd>
              <dt className="text-ink-2">AOV</dt>
              <dd>{money(intake.averageOrderValueMinor)}</dd>
              <dt className="text-ink-2">Gross margin</dt>
              <dd>{formatBps(intake.grossMarginBps)}</dd>
              <dt className="text-ink-2">Geos</dt>
              <dd>{intake.targetGeos.join(", ")}</dd>
              <dt className="text-ink-2">Monthly cap</dt>
              <dd>{money(intake.monthlySpendCapMinor)}</dd>
              <dt className="text-ink-2">Creatives</dt>
              <dd className="space-y-1">
                {intake.creativeAssetLinks.length === 0
                  ? "—"
                  : intake.creativeAssetLinks.map((l) => (
                      <a
                        key={l}
                        href={l}
                        className="link block break-all"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {l}
                      </a>
                    ))}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-ink-2">Not submitted yet.</p>
          )}
        </section>

        <section className="card space-y-3" aria-labelledby="agr-h">
          <h2 id="agr-h" className="text-lg font-semibold">
            Agreement & offer
          </h2>
          <p className="text-sm">
            {agreement
              ? `In force: ${formatBps(agreement.feeRateBps)}, ${agreement.attributionWindowDays}-day window, v${agreement.version}, accepted ${agreement.acceptedAt.toISOString().slice(0, 10)} from ${agreement.acceptedIp ?? "unknown IP"}.`
              : "No agreement accepted yet."}
          </p>
          <ActionForm
            action={setOfferAction.bind(null, id)}
            submitLabel="Update offer"
            buttonClassName="btn btn-secondary btn-sm"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Fee rate (%)"
                name="feeRatePct"
                type="number"
                step="0.01"
                min="0.01"
                max="100"
                defaultValue={String(org.offeredFeeRateBps / 100)}
              />
              <Field
                label="Attribution window (days)"
                name="attributionWindowDays"
                type="number"
                min="1"
                max="90"
                defaultValue={String(org.offeredAttributionWindowDays)}
              />
            </div>
          </ActionForm>
        </section>
      </div>

      <section className="card space-y-4" aria-labelledby="ads-h">
        <h2 id="ads-h" className="text-lg font-semibold">
          Ad platform connections
        </h2>
        <div className="grid gap-6 md:grid-cols-2">
          {(
            [
              {
                kind: "meta_ads",
                label: "Meta",
                integration: meta,
                configured: metaAppConfigured(),
                provider: "meta",
                idLabel: "Ad account id (act_…)",
              },
              {
                kind: "google_ads",
                label: "Google Ads",
                integration: google,
                configured: googleAppConfigured(),
                provider: "google",
                idLabel: "Customer id (123-456-7890)",
              },
            ] as const
          ).map((p) => (
            <div key={p.kind} className="space-y-3 rounded-lg border border-hairline p-4 text-sm">
              <p className="flex items-center justify-between font-semibold">
                {p.label}{" "}
                <StatusBadge
                  status={p.integration?.status ?? "pending"}
                  label={p.integration?.status ?? "not connected"}
                />
              </p>
              {p.configured ? (
                <a
                  className="btn btn-secondary btn-sm"
                  href={`/api/oauth/${p.provider}/start?orgId=${id}`}
                >
                  {p.integration?.encryptedSecret ? "Reconnect" : "Connect"} with OAuth
                </a>
              ) : (
                <p className="text-ink-2">
                  API credentials are not configured on this server; campaigns use the sandbox or
                  manual connector. See docs/DEPLOYMENT.md.
                </p>
              )}
              <ActionForm
                action={setAdAccountAction.bind(null, id, p.kind)}
                submitLabel="Save account"
                buttonClassName="btn btn-secondary btn-sm"
              >
                <Field
                  label={p.idLabel}
                  name="accountId"
                  defaultValue={p.integration?.config.accountId}
                  required
                />
                {p.kind === "google_ads" ? (
                  <Field
                    label="Manager (login) customer id — optional"
                    name="loginCustomerId"
                    defaultValue={p.integration?.config.loginCustomerId}
                  />
                ) : null}
              </ActionForm>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-x-auto" aria-labelledby="bill-h">
          <h2 id="bill-h" className="mb-3 text-lg font-semibold">
            Billing
          </h2>
          {periods.length === 0 ? (
            <p className="text-sm text-ink-2">No statements yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col" className="text-right">
                    Revenue
                  </th>
                  <th scope="col" className="text-right">
                    Due
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id}>
                    <td>{p.periodStart.slice(0, 7)}</td>
                    <td className="text-right tabular">{money(p.netRevenueMinor)}</td>
                    <td className="text-right tabular">{money(p.amountDueMinor)}</td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card" aria-labelledby="alerts-h">
          <h2 id="alerts-h" className="mb-3 text-lg font-semibold">
            Open alerts
          </h2>
          {alerts.length === 0 ? (
            <p className="text-sm text-ink-2">None.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {alerts.map(({ alert }) => (
                <li key={alert.id} className="flex items-start gap-2">
                  <StatusBadge status={alert.severity} />
                  <span>{alert.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
