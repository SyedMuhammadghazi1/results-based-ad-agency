# Handoff: project status (paused 2026-09-29)

Work on this repo is paused. This file records where things stand so the next session can resume
without re-discovering context. To resume: open a Claude Code session on this repo and ask it to
read `HANDOFF.md` and continue from "Next steps".

## What this is

Outcome Ads (working name, set via `NEXT_PUBLIC_APP_NAME`): a results-based ad agency platform.
Operators build and run clients' campaigns (Meta / Google / sandbox connectors); a first-party
tracking script plus Shopify, Stripe and server-to-server conversion feeds attribute revenue to
paid clicks; clients see only revenue; a monthly job bills a percentage of attributed revenue via
Stripe invoices (no retainer, no minimums). See `README.md` and `docs/ARCHITECTURE.md`.

## State at pause

- All work is pushed to `main` (`e27da4c`). Locally, every gate passed before the push: lint,
  format, typecheck, 232 unit + integration tests, production build and 2 Playwright e2e tests;
  the Docker image was verified earlier in the project.
- **Not yet confirmed:** the first GitHub Actions CI + Deploy run on `e27da4c` was still in
  progress when work paused. First thing next session: check the Actions tab and fix any failure.
- GitHub push protection flagged a fake test value in `tests/integration/webhooks.test.ts`
  (`SHOPIFY_SECRET`, a dummy that matches Shopify's secret format). It was allowed as "used in
  tests". It is not a real credential.
- Nothing is deployed to a live host yet. No real Stripe, Meta or Google credentials have been used.

## History of the work

1. Built from scratch (Next.js 16, Drizzle/Postgres, Better Auth, Stripe, Vitest, Playwright).
2. Independent review fixed 6 billing/revenue bugs:
   - invoices auto-finalizing as empty $0 "paid" (fees never collected);
   - late `payment_failed` events un-paying paid invoices;
   - voided invoices leaving clients permanently blocked;
   - restock-only Shopify refunds crashing the webhook;
   - client Stripe test-mode events billed as revenue;
   - tax-inclusive refunds over-reducing revenue.
3. Hardening pass:
   - spoof-resistant client IP (`CLIENT_IP_HEADER` / `TRUSTED_PROXY_HOPS`);
   - per-IP touch limit far below the per-key limit;
   - `SKIP_ENV_VALIDATION` ignored at production runtime;
   - deploys gated on CI;
   - refunds that arrive before their order kept in `pending_refunds` and applied when the order
     lands.
4. Deploy skips commits that are no longer the head of `main`; demo seed refuses to run in
   production.

## Known gaps (not built or not verified)

- Meta and Google connectors + OAuth flows are only tested against mocked HTTP; TikTok uses the
  manual connector. Stripe is only tested through an SDK mock.
- No email verification or MFA; CSP still allows inline scripts.
- Partial-refund tax is estimated for Shopify/Stripe; only the first payment of a Stripe
  subscription is tracked.
- A distributed tracking flood (50+ IPs) can still exhaust one client's per-minute touch budget
  (under-attribution, never over-billing); the fix is edge rate limiting.

## Before real customers (see `docs/LAUNCH_CHECKLIST.md`)

- Legal review of the performance agreement, terms, privacy policy and tracking consent; decide on
  sales tax / VAT for fee invoices.
- Stripe keys + webhook; Meta App Review + Business Verification; Google Ads developer token
  (Basic/Standard access) + OAuth verification; set `AD_CONNECTOR_FALLBACK=manual` in production.
- Production domain, SMTP with SPF/DKIM/DMARC, monitoring, backups, GitHub `production` secrets.

## Next steps

1. Confirm the first CI/Deploy run on GitHub is green (fix if not).
2. Pick a host (see `docs/DEPLOYMENT.md`), create managed Postgres, set secrets, deploy.
3. Run one real client end to end in Stripe test mode with the sandbox connector, then connect
   real Meta/Google accounts once app review is approved.
4. Review and merge Dependabot PRs.
