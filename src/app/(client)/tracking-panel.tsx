import { ActionForm } from "@/components/action-form";
import { CopyField } from "@/components/copy-field";
import { Field, TextArea } from "@/components/field";
import { StatusBadge } from "@/components/status-badge";
import type { Organization } from "@/db/schema";
import { env } from "@/env";
import { installSnippet } from "@/lib/tracking";
import { listIntegrations, webhookUrl } from "@/server/integrations";
import {
  prepareIntegrationAction,
  rotateApiKeyAction,
  saveShopifyAction,
  saveStripeAction,
  setOriginsAction,
} from "./actions";

function when(d: Date | null) {
  return d ? d.toUTCString() : null;
}

export async function TrackingPanel({ org, isOwner }: { org: Organization; isOwner: boolean }) {
  const integrations = await listIntegrations(org.id);
  const shopify = integrations.find((i) => i.kind === "shopify");
  const stripe = integrations.find((i) => i.kind === "stripe");
  const appUrl = env.APP_URL.replace(/\/$/, "");
  const curl = `curl -X POST ${appUrl}/api/v1/conversions \\
  -H "Authorization: Bearer $OUTCOME_ADS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"conversion","order_id":"1001","amount_minor":12900,"currency":"${org.currency}","occurred_at":"2026-09-01T12:00:00Z","visitor_id":"<oa_vid cookie value>"}'`;

  return (
    <div className="space-y-6">
      <section className="card space-y-3" aria-labelledby="install-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="install-h" className="text-lg font-semibold">
            1. Install the tracking script
          </h2>
          {org.trackingLastSeenAt ? (
            <StatusBadge
              status="connected"
              label={`Receiving data · last seen ${when(org.trackingLastSeenAt)}`}
            />
          ) : (
            <StatusBadge status="pending" label="Waiting for the first visit" />
          )}
        </div>
        <p className="text-sm text-ink-2">
          Paste this into the <code>&lt;head&gt;</code> of every page (Shopify: Online Store →
          Themes → Edit code → <code>theme.liquid</code>). It is ~2 KB, sets one first-party cookie
          (<code>oa_vid</code>) and only records ad-click parameters.
        </p>
        <CopyField
          value={installSnippet(appUrl, org.publicKey)}
          label="Tracking snippet"
          multiline
        />
        <ActionForm
          action={setOriginsAction}
          submitLabel="Save websites"
          buttonClassName={isOwner ? "btn btn-secondary btn-sm" : "hidden"}
        >
          <TextArea
            label="Websites allowed to send tracking data"
            name="origins"
            rows={2}
            defaultValue={org.allowedOrigins.join("\n")}
            disabled={!isOwner}
            hint="One origin per line, e.g. https://shop.example.com. Requests from other sites are rejected."
          />
        </ActionForm>
      </section>

      <section className="card space-y-4" aria-labelledby="revenue-h">
        <h2 id="revenue-h" className="text-lg font-semibold">
          2. Connect a revenue source
        </h2>
        <p className="text-sm text-ink-2">
          Pick whichever fits. Revenue is always measured excluding sales tax / VAT.
        </p>

        <details className="rounded-lg border border-hairline p-4" open={!!shopify}>
          <summary className="cursor-pointer font-semibold">
            Shopify {shopify ? <StatusBadge status={shopify.status} /> : null}
          </summary>
          <div className="mt-3 space-y-3 text-sm">
            {!shopify ? (
              isOwner ? (
                <ActionForm
                  action={prepareIntegrationAction}
                  submitLabel="Set up Shopify"
                  buttonClassName="btn btn-secondary btn-sm"
                >
                  <input type="hidden" name="kind" value="shopify" />
                </ActionForm>
              ) : (
                <p>Not connected.</p>
              )
            ) : (
              <>
                <p>
                  In Shopify admin → Settings → Notifications → Webhooks, create two JSON webhooks —{" "}
                  <strong>Order payment</strong> (<code>orders/paid</code>) and{" "}
                  <strong>Refund create</strong> (<code>refunds/create</code>) — pointing to:
                </p>
                <CopyField value={webhookUrl(shopify)} label="Shopify webhook URL" />
                <p>
                  Then paste the signing secret shown under the webhook list. The tracking script
                  links orders to ad clicks automatically on Shopify storefronts (it stores the
                  visitor id as a cart attribute).
                </p>
                {shopify.lastEventAt ? <p>Last webhook: {when(shopify.lastEventAt)}</p> : null}
                {isOwner ? (
                  <ActionForm
                    action={saveShopifyAction}
                    submitLabel="Save Shopify settings"
                    buttonClassName="btn btn-secondary btn-sm"
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Store domain"
                        name="shopDomain"
                        required
                        placeholder="your-store.myshopify.com"
                        defaultValue={shopify.config.shopDomain}
                      />
                      <Field
                        label="Webhook signing secret"
                        name="webhookSecret"
                        type="password"
                        required
                        autoComplete="off"
                      />
                    </div>
                  </ActionForm>
                ) : null}
              </>
            )}
          </div>
        </details>

        <details className="rounded-lg border border-hairline p-4" open={!!stripe}>
          <summary className="cursor-pointer font-semibold">
            Stripe {stripe ? <StatusBadge status={stripe.status} /> : null}
          </summary>
          <div className="mt-3 space-y-3 text-sm">
            {!stripe ? (
              isOwner ? (
                <ActionForm
                  action={prepareIntegrationAction}
                  submitLabel="Set up Stripe"
                  buttonClassName="btn btn-secondary btn-sm"
                >
                  <input type="hidden" name="kind" value="stripe" />
                </ActionForm>
              ) : (
                <p>Not connected.</p>
              )
            ) : (
              <>
                <p>
                  In your Stripe Dashboard → Developers → Webhooks, add an endpoint for{" "}
                  <code>checkout.session.completed</code>,{" "}
                  <code>checkout.session.async_payment_succeeded</code> and{" "}
                  <code>charge.refunded</code>:
                </p>
                <CopyField value={webhookUrl(stripe)} label="Stripe webhook URL" />
                <p>
                  When you create Checkout Sessions, pass the visitor id:{" "}
                  <code>metadata: {"{ oa_vid: <cookie value> }"}</code> (or{" "}
                  <code>client_reference_id</code>).
                </p>
                {isOwner ? (
                  <ActionForm
                    action={saveStripeAction}
                    submitLabel="Save signing secret"
                    buttonClassName="btn btn-secondary btn-sm"
                  >
                    <Field
                      label="Signing secret (whsec_…)"
                      name="signingSecret"
                      type="password"
                      required
                      autoComplete="off"
                    />
                  </ActionForm>
                ) : null}
              </>
            )}
          </div>
        </details>

        <details className="rounded-lg border border-hairline p-4" open={!!org.apiKeyPrefix}>
          <summary className="cursor-pointer font-semibold">
            Server-to-server API{" "}
            {org.apiKeyPrefix ? (
              <StatusBadge status="connected" label={`key ${org.apiKeyPrefix}…`} />
            ) : null}
          </summary>
          <div className="mt-3 space-y-3 text-sm">
            <p>
              Send each paid order (and refund) from your backend. Read the visitor id from the{" "}
              <code>oa_vid</code> cookie, or in the browser via{" "}
              <code>window.OutcomeAds.visitorId()</code>.
            </p>
            <CopyField value={curl} label="Example request" multiline />
            {isOwner ? (
              <ActionForm
                action={rotateApiKeyAction}
                submitLabel={org.apiKeyPrefix ? "Rotate API key" : "Create API key"}
                buttonClassName="btn btn-secondary btn-sm"
              />
            ) : null}
          </div>
        </details>
      </section>
    </div>
  );
}
