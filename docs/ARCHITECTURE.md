# Architecture

## Overview

One Next.js 16 (App Router) application, deployed as a standalone Node container, backed by
PostgreSQL 16. Background work runs as idempotent jobs triggered over HTTP (`/api/cron/<job>`) or
from a CLI bundle (`node job.mjs <job>`). There is no queue or Redis: Postgres provides uniqueness,
advisory locks and the fixed-window rate limiter.

```
src/
  app/                 routes (pages, server actions, route handlers)
    (public)/          landing, FAQ, apply, legal
    (auth)/            sign-in, sign-up, password reset (Better Auth client)
    (client)/          onboarding/* and dashboard/* (client role, org-scoped)
    operator/          operator console (operator/admin roles)
    api/               health, ready, auth, track, v1/conversions, webhooks, cron, oauth, JSON APIs
    t.js/route.ts      first-party tracking script
  lib/                 PURE domain logic — no I/O, fully unit tested
    attribution.ts     touch classification, last-paid-touch attribution, refund planning
    billing.ts         monthly statement / fee / credit computation
    money.ts           minor units, currency exponents, round-half-up, micros
    revenue-sources.ts normalisation of S2S, Shopify and Stripe payloads
    connectors/        AdConnector interface + Sandbox, Manual, Meta, Google implementations
    crypto.ts          AES-256-GCM envelopes, API keys, HMAC, signed OAuth state
    tracking.ts, agreement.ts, budget.ts, dunning.ts, reporting.ts, onboarding.ts, dates.ts
  server/              I/O services (DB, Stripe, email) used by routes and jobs
  jobs/                sync-spend, budget-guard, monthly-billing, dunning, weekly-revenue-report, cleanup
  db/                  Drizzle schema, pooled client, migration runner
drizzle/               committed SQL migrations
scripts/               migrate, seed, run-job, rotate-secrets, CLI bundler
```

## Roles & authorization

| Role       | Where                                        | Can                                                                                                                           |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `client`   | `/onboarding`, `/dashboard`, `/api/client/*` | See their own org's revenue, orders, invoices; owners change settings, invite members, accept agreements, add payment methods |
| `operator` | `/operator`, `/api/operator/*`, OAuth        | Everything internal: all clients, campaigns, spend, alerts, billing, audit                                                    |
| `admin`    | operator console + `/operator/team`          | Operator rights + change user roles                                                                                           |

- Roles live on the Better Auth `user.role` field (`additionalFields`, `input: false` — users cannot
  set it). New sign-ups are always `client`.
- A client user belongs to exactly one organization (`org_members.user_id` is unique) as `owner`
  or `member`.
- Every page, server action and route handler calls a guard (`requireUser`, `requireRole`,
  `requireMembership`, `requireOrgOwner`, `apiRequire*`). Client data is always scoped by the
  **session's** org id, never by an id from the request; direct object lookups
  (`getBillingPeriodForOrg`) include the org id in the `WHERE` clause, so a foreign id is a 404.
  Integration tests cover this (org A vs org B, client vs operator routes).

## Data model (main tables)

| Table                                                                                             | Purpose                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification`                                                      | Better Auth (DB sessions)                                                                                                                            |
| `organizations`                                                                                   | Client org: currency, public tracking key, allowed origins, API-key hash, offer (fee bps / window), Stripe customer, tracking/payment/dunning status |
| `org_members`, `org_invitations`                                                                  | Membership (owner/member) and hashed invitation tokens                                                                                               |
| `org_intakes`                                                                                     | Onboarding questionnaire incl. `monthly_spend_cap_minor`                                                                                             |
| `agreements`                                                                                      | Accepted agreements: version, fee bps, window, billing terms, rendered text + SHA-256, accepted by / at / IP / UA; one non-superseded row per org    |
| `integrations`                                                                                    | Shopify / client Stripe / Meta / Google — encrypted secret (`enc:v1:<keyId>:…`) + config                                                             |
| `campaigns`                                                                                       | Platform, objective, connector, status, pause reason, daily budget, `tracking_code` (= `oa_cid`), creatives                                          |
| `ad_spend_daily`                                                                                  | Internal spend per campaign per day (unique campaign+date, upserted)                                                                                 |
| `touches`                                                                                         | Tracked ad clicks: visitor id, landing host/path, referrer host, utm/click ids, `oa_cid` — no IP, no query string                                    |
| `conversions`                                                                                     | Orders: unique (org, source, external order id), amount, refunded total, attribution result, snapshotted agreement + fee bps, billing period         |
| `conversion_adjustments`                                                                          | Refunds (negative), unique (org, source, external refund id), linked to the conversion                                                               |
| `billing_periods`                                                                                 | Monthly statements: unique (org, period_start), fee lines, credits in/generated/applied/out, amount due, Stripe invoice                              |
| `alerts`, `audit_log`, `webhook_events`, `rate_limits`, `job_runs`, `email_sends`, `applications` | Operations                                                                                                                                           |

Money is `bigint` minor units + ISO currency everywhere. Rates are basis points.

## Tracking & attribution

1. `t.js` reads `utm_*`, `gclid`, `fbclid`, `ttclid`, `oa_cid` from the landing URL, sets/reads the
   `oa_vid` cookie (random 128-bit id, 180 days, `SameSite=Lax`) and posts a touch as `text/plain`
   (no CORS preflight) with `keepalive`. Without parameters it sends one "ping" per session so the
   install shows as live. On Shopify it writes `oa_vid` into the cart attributes.
2. `POST /api/track/touch` validates with Zod, rate limits per IP and per org, checks the `Origin`
   against the org's allow-list and stores only touches that carry tracked parameters.
3. Orders arrive from the S2S API, Shopify or the client's Stripe and are normalised by
   `lib/revenue-sources.ts` (revenue excludes tax).
4. `attributeConversion` (pure) looks at the visitor's touches in
   `[order time − window, order time]` (both inclusive) and credits the **last paid touch**:
   - `oa_cid` that matches one of the org's campaigns → that campaign;
   - otherwise `gclid` / `ttclid` when we run a (non-draft) campaign on that platform for the org;
   - never: `fbclid` alone (Facebook adds it to organic links), UTMs alone, unknown `oa_cid`.
5. The agreement **in force at the order time** supplies the window and the fee rate, which is
   snapshotted on the conversion. Orders placed before any agreement are never attributed.
6. Refunds become negative `conversion_adjustments`, capped so a conversion's refunds never exceed
   its amount. Stripe reports cumulative, tax-inclusive refunds; the service pro-rates them to the
   ex-tax revenue share (revenue ÷ charged amount) and converts them to deltas.

## Billing

`monthly-billing` runs on the 1st (UTC) for the previous calendar month
`[YYYY-MM-01T00:00Z, next month 01T00:00Z)`. Per org, inside a transaction holding
`pg_advisory_xact_lock(hashtext('billing:<org>'))`:

1. If a statement for (org, period) exists → skip (or resume a Stripe invoice that failed to issue).
2. Load every **unbilled** attributed conversion and refund dated before the period end (late
   arrivals from earlier months are picked up too).
3. `computeStatement` (pure): per fee rate, `fee = round-half-up(net revenue × bps / 10 000)`;
   refunds of conversions on this statement reduce net revenue; refunds of conversions billed on an
   earlier statement generate a credit (`round-half-up(refund × bps / 10 000)`); credit carried in
   from the previous statement + generated credit is applied up to the gross fee; the rest carries
   forward. Mixed currencies are rejected.
4. Insert the `billing_periods` row (`no_charge` when nothing is due) and mark the conversions and
   adjustments as billed.
5. Outside the transaction, create the Stripe invoice (`charge_automatically`, `auto_advance`) with
   idempotency keys per step; the invoice id is persisted right after creation so a crashed run
   resumes instead of duplicating.

`invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `invoice.voided`,
`invoice.marked_uncollectible` update status; `dunning` pauses all campaigns of an org whose
invoice is still open/failed more than `DUNNING_GRACE_DAYS` after issue, and payment clears the flag
(operators resume campaigns deliberately).

The client dashboard's "fee accrued this month" runs the same `computeStatement` on the current
month's unbilled items.

## Spend & budget guard

`sync-spend` (daily) re-fetches the last 3 days of spend for active campaigns (platforms restate
recent days) and upserts `ad_spend_daily`. `budget-guard` (hourly) refreshes today's spend, then for
each org compares month-to-date spend with the intake cap: ≥ 90% → warning alert; ≥ 100% → pause
every live campaign through its connector and raise a critical alert (deduplicated per org per
month). Campaigns paused by the cap in an earlier month are resumed at the start of a new month if
nothing else blocks them (payment method, dunning, cap).

Spend, ROAS and pacing are **internal**: they only appear in operator pages and operator APIs.

## Connectors

`AdConnector = { createCampaign, setStatus, setDailyBudget, fetchDailySpend }`.

| Connector                | When                                                                 | Notes                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxConnector`       | dev / test / demo                                                    | Deterministic spend: 55–100% of daily budget from a hash of (campaign, date)                                                                                  |
| `ManualConnector`        | platforms without API access (TikTok today) or before approvals      | No network; the app raises "act by hand" alerts                                                                                                               |
| `MetaMarketingConnector` | `META_APP_ID/SECRET` set and the org connected + ad account id saved | Graph API: create campaign (paused, CBO daily budget), update status/budget, insights spend (`time_increment=1`), `appsecret_proof`                           |
| `GoogleAdsConnector`     | `GOOGLE_ADS_*` set and the org connected + customer id saved         | REST: `campaignBudgets:mutate` + `campaigns:mutate` (paused, oa_cid tracking template), `googleAds:searchStream` for `metrics.cost_micros` by `segments.date` |

Request construction and response parsing for the real connectors are unit tested with a mocked
`fetch`; they have **not** been exercised against live accounts (see LAUNCH_CHECKLIST).

## Security notes

See [SECURITY.md](../SECURITY.md). Highlights: CSP and security headers in `next.config.ts`,
Postgres-backed rate limits on auth and every public write endpoint, HMAC/Stripe signature checks on
raw bodies, AES-256-GCM secrets with key ids, API keys stored as SHA-256, signed + nonce-bound OAuth
state, audit log for sensitive actions, pino log redaction, generic error pages.
