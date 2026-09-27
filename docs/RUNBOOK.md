# Runbook (on-call)

## Health checks

| Check                         | Expectation                               | Meaning when failing                                                         |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/health`             | `200 {"status":"ok"}`                     | Process down / crash-looping → restart, check logs and env validation errors |
| `GET /api/ready`              | `200 {"status":"ready"}`                  | DB unreachable → check DB status, credentials, connection limits             |
| Operator console → **Jobs**   | recent `succeeded` runs for each schedule | Scheduler not firing or job failing                                          |
| Operator console → **Alerts** | no unresolved `critical` alerts           | Budget caps, failed pauses, payment failures, dunning                        |

`SELECT job, status, started_at, error FROM job_runs ORDER BY started_at DESC LIMIT 20;` shows the
same from SQL.

## Logs

- JSON logs (pino) on stdout: `level`, `time`, `msg`, `service`, plus context (`orgId`, `job`,
  `kind`). Secrets, cookies, tokens and emails are redacted by path; webhook bodies are never logged.
- Useful filters: `msg="unhandled route error"`, `msg="job failed"`, `msg="operator alert raised"`,
  `msg="stripe webhook signature failed"`, `msg="revenue event rejected"`.
- Error pages show only a digest; match it to the log line with the same `digest`.

## Common incidents

**Budget cap reached but ads still spending.** Check the alert: a `connector_error` or
`manual_action_required` alert means the platform did not accept the pause. Pause by hand in the ad
platform immediately, then fix credentials (Operator → client → Ad platform connections →
Reconnect). Re-run `budget-guard` from Operator → Jobs.

**Revenue not showing for a client.** 1) Settings → tracking status shows "last seen"; if never,
the script isn't installed or the site origin isn't in the allow-list (403s in logs:
`origin_not_allowed`). 2) Check the revenue source: Shopify/Stripe integration `last webhook` time;
S2S API responses (401 = wrong key; 422 = currency mismatch or future date). 3) Conversions exist but
`attributed=false`: look at `attribution_reason` (`unknown_visitor` → the order didn't carry
`oa_vid`; `no_paid_touch_in_window` → no click from our campaigns within the window;
`no_agreement` → order predates the agreement).

**Payment failed / dunning.** Stripe retries automatically. Our dunning job pauses campaigns after
`DUNNING_GRACE_DAYS`; when `invoice.paid` arrives the dunning flag clears and an info alert says
campaigns can be resumed — resume them from the campaign pages.

**Monthly billing failed for an org.** `job_runs.summary.failed > 0`. Logs show
`monthly-billing failed for org` (e.g. `CurrencyMismatchError`). Fix the data, then re-run:
`POST /api/cron/monthly-billing?period=YYYY-MM` — existing statements are skipped, statements stuck
in `pending_invoice` are re-issued to Stripe with the same idempotency keys.

## Rolling back

1. Redeploy the previous image tag (`ghcr.io/<repo>:<previous sha>`) — on Render/Fly/Railway pick the
   previous deploy; on Vercel "Promote" the previous deployment.
2. Migrations are additive; the previous version runs against the newer schema. If a migration
   itself is faulty, restore (below) rather than hand-editing — never delete rows from
   `drizzle.__drizzle_migrations` in production without a restore plan.

## Rotating secrets

| Secret                          | Procedure                                                                                                                                                                                                                                                                                                         | Impact                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`            | Replace and redeploy                                                                                                                                                                                                                                                                                              | All sessions invalidated (users sign in again); pending OAuth flows fail |
| `CRON_SECRET`                   | Update app env **and** scheduler (Vercel env / GitHub secret) together                                                                                                                                                                                                                                            | Cron calls 401 until both match                                          |
| `STRIPE_WEBHOOK_SECRET`         | Roll in Stripe Dashboard (Stripe keeps the old one valid for up to 24h), update env                                                                                                                                                                                                                               | None if done within the overlap                                          |
| `STRIPE_SECRET_KEY`             | Create new key, update env, revoke old                                                                                                                                                                                                                                                                            | None                                                                     |
| `DATA_ENCRYPTION_KEY`           | 1) Set new key + new `DATA_ENCRYPTION_KEY_ID`, move the old one to `DATA_ENCRYPTION_PREVIOUS_KEYS=oldId:oldKey`; deploy. 2) Run `node rotate-secrets.mjs` in a one-off container with the same env (or `npm run secrets:rotate` from a checkout); re-running reports `0` rotated when done. 3) Remove the old key | None; old envelopes stay readable during the overlap                     |
| Client API key                  | Client (owner) rotates in Settings; old key stops immediately                                                                                                                                                                                                                                                     | Their S2S integration must switch keys                                   |
| Shopify / client Stripe secrets | Client re-enters in Settings                                                                                                                                                                                                                                                                                      | Webhooks 401 until updated                                               |

## Restoring the database

1. Stop writes: scale the app to 0 (or enable maintenance at the proxy) and pause the scheduler.
2. Restore into a **new** database from the provider's PITR/backup (or
   `pg_restore --clean --no-owner -d "$NEW_URL" backup.dump`).
3. Run `node migrate.mjs` against it (no-op if already current).
4. Point `DATABASE_URL` at the restored database, start the app, check `/api/ready`.
5. Replay webhooks for the gap (below) and re-run `sync-spend` for the affected days. Revenue
   events are idempotent (unique order/refund ids), so replaying more than needed is safe.

## Replaying webhooks

- **Stripe (agency)**: Dashboard → Developers → Webhooks → endpoint → select events → _Resend_, or
  `stripe events resend evt_…`. Processed event ids are stored in `webhook_events`; to force
  reprocessing of one event delete its row first:
  `DELETE FROM webhook_events WHERE provider='stripe_platform' AND event_id='evt_…';`
- **Client Stripe**: the client resends from their dashboard (provider `stripe_client:<integration>`).
- **Shopify**: Shopify retries failed deliveries for 48h; past that, have the client export orders
  and send them through the S2S API (`order_id` = Shopify order id is NOT the same source — use
  the API only for orders Shopify never delivered).
- **S2S API**: clients can resend; duplicates return `{"status":"duplicate"}`.
