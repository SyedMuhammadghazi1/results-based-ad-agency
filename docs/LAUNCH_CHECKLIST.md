# Launch checklist (non-code work before real customers)

Things the codebase cannot do for you. Items marked **(blocker)** must be done before the first
paying client.

## Legal & compliance

- [ ] **(blocker)** Have counsel review and finalise the performance agreement
      (`src/lib/agreement.ts`, bump `AGREEMENT_VERSION`), Terms of Service and Privacy Policy
      (`/legal/*` pages are placeholders). Cover: definition of Attributed Revenue, attribution
      window, dispute window, refunds/credits, termination tail, liability caps, ad-account
      ownership/access, governing law.
- [ ] **(blocker)** Privacy/consent: the tracking script sets a first-party cookie and processes
      ad-click ids. Decide the lawful basis per market (GDPR/ePrivacy, UK PECR, CCPA/CPRA, …),
      require clients to load it behind their consent banner where needed, sign DPAs with clients
      (we are a processor for their visitors' data) and list sub-processors (hosting, DB, Stripe,
      email, Meta, Google).
- [ ] **(blocker)** Tax: decide whether performance fees carry sales tax/VAT per client location;
      enable Stripe Tax or equivalent and collect billing addresses / VAT ids. Invoices currently
      carry no tax.
- [ ] Company registration, business bank account, accounting for revenue recognition.
- [ ] Ad-platform policies: agency/partner terms with Meta, Google and TikTok; confirm clients own
      their ad accounts and grant partner access.

## Third-party approvals

- [ ] **Stripe**: activate the account, verify the business, set statement descriptor, enable
      Smart Retries, configure the production webhook (see DEPLOYMENT §5), run a live €1/$1 test.
- [ ] **Meta**: Business Verification + App Review for `ads_management`, `ads_read`,
      `business_management`. Until approved, keep `AD_CONNECTOR_FALLBACK=manual`.
- [ ] **Google Ads**: developer token with Basic/Standard access, OAuth consent screen
      verification for the `adwords` scope, MCC linked to client accounts.
- [ ] **TikTok**: no API connector yet — operators manage TikTok manually.
- [ ] Validate the Meta and Google connectors end-to-end against test accounts (create, pause,
      budget change, spend sync); they are only unit-tested with mocked HTTP today.

## Domain, DNS & email

- [ ] Production domain + TLS; set `APP_URL`/`BETTER_AUTH_URL` to it (tracking snippet and webhook
      URLs embed it — changing it later means clients re-install).
- [ ] Transactional email domain with SPF, DKIM and DMARC; configure `SMTP_*` and `EMAIL_FROM`;
      verify deliverability of invitation, password-reset, payment-failed and weekly-report emails.
- [ ] Update `public/.well-known/security.txt` and `SECURITY.md` contact addresses.

## Operations

- [ ] Uptime monitoring on `/api/health` and `/api/ready`; alert routing for operator alerts
      (`OPERATOR_ALERT_EMAIL`, ideally a shared inbox or pager).
- [ ] Log aggregation + error tracking (e.g. ship pino JSON to your log platform; add Sentry if
      desired) and dashboards for 5xx rate, job failures, webhook signature failures.
- [ ] Scheduler configured and verified for every job (DEPLOYMENT §6); check the Jobs page after
      the first day, the first Monday and the first 1st-of-month.
- [ ] Database backups + PITR enabled and a restore rehearsed (RUNBOOK); `DATA_ENCRYPTION_KEY`
      stored in a secret manager with break-glass access.
- [ ] Set `AD_CONNECTOR_FALLBACK=manual` in production and make sure no client campaign uses the
      `sandbox` connector.
- [ ] Create real admin/operator accounts; delete or never run the demo seed in production.
- [ ] Load-test the tracking endpoint for the expected traffic of your largest client (each touch
      costs a few Postgres writes including rate limiting).
- [ ] Penetration test / security review before scale; consider a nonce-based CSP (SECURITY.md).

## Product & process

- [ ] Attribution method disclosure to clients (last paid click, window, what doesn't count) and
      a dispute process (the dashboard lists every billed order).
- [ ] Known approximations accepted by the business: tax portions of partial refunds (Shopify /
      Stripe) are estimated; only the first payment of Stripe subscriptions is tracked; ad
      blockers / browser privacy features reduce tracked clicks (under-attribution, never
      over-billing); `fbclid`-only clicks are not attributed.
- [ ] Email verification for sign-ups (Better Auth supports it; not enabled yet) if you open
      self-serve sign-up to the public.
- [ ] Support channel and response-time commitment (no strategy meetings — but clients still need
      a way to reach you).
