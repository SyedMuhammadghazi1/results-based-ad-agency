# Security policy

## Reporting a vulnerability

Email **security@example.com** (replace before launch) with details and steps to reproduce. Please
do not open public issues for vulnerabilities. We aim to acknowledge within 2 business days.

## Security design

- **Authentication**: Better Auth email + password (min. 10 chars, scrypt hashing), database
  sessions, httpOnly cookies (`Secure` on https). Roles (`client`, `operator`, `admin`) are a
  server-only field — users cannot set them.
- **Authorization**: guards on every page, server action and route handler; client data is scoped
  by the session's organization; object lookups include the org id; operator APIs require staff
  roles. Covered by integration tests (IDOR, role separation).
- **Rate limiting**: Postgres-backed fixed windows on sign-in/up/password reset (per IP and per
  account email), the tracking endpoint (per IP and per org), the S2S API, webhooks, the apply
  form, invitations and API-key rotation. Better Auth's own limiter is disabled.
- **Client IP**: resolved only by `src/lib/client-ip.ts` from `CLIENT_IP_HEADER` (a single
  platform header clients cannot spoof) or the entry `TRUSTED_PROXY_HOPS` from the right of
  `X-Forwarded-For` — never the client-controlled leftmost entry. The same value feeds rate limits,
  the audit log, agreement acceptance and Better Auth sessions. IPv6 is limited per /64. An
  unresolvable IP never puts all clients in one bucket on account/key-limited endpoints.
- **Webhooks**: Stripe signatures (`constructEvent` on the raw body), Shopify HMAC-SHA256 with
  constant-time comparison, per-org secrets; processed delivery ids stored for idempotency.
- **Secrets at rest**: integration secrets and OAuth tokens encrypted with AES-256-GCM, key id in
  the envelope and bound as AAD, rotation supported (`DATA_ENCRYPTION_PREVIOUS_KEYS`,
  `rotate-secrets`). API keys and invitation tokens are stored as SHA-256 hashes only.
- **OAuth**: signed, expiring `state` bound to the operator and a nonce cookie.
- **Headers**: CSP, HSTS, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, nosniff,
  Referrer-Policy, Permissions-Policy, COOP.
- **Privacy**: the tracker stores no IP addresses and no query strings beyond ad parameters;
  orders carry no buyer PII; logs redact secrets, cookies, tokens and emails.
- **Audit log**: organization, agreement, key, integration, campaign, billing and role changes.
- **Errors**: generic error pages and JSON errors; stack traces only in server logs.

## Known limitations / hardening backlog

- CSP allows `'unsafe-inline'` scripts (Next.js inline bootstrap). Move to a nonce-based policy via
  `proxy.ts` when all pages can be dynamic.
- Email verification and MFA are not enabled.
- Rate limiting adds database writes per request; for very high tracking volume consider a
  dedicated store.
- The client IP is only as trustworthy as the `CLIENT_IP_HEADER` / `TRUSTED_PROXY_HOPS` setting
  (docs/DEPLOYMENT.md): if the app is reachable without going through the configured proxy, the
  header can be forged. Restrict the origin to the proxy/CDN.
