## What & why

<!-- What does this change and why? Link the issue. -->

## How was it tested?

- [ ] `npm run lint && npm run format:check && npm run typecheck`
- [ ] `npm test` (unit + integration against the `_test` database)
- [ ] `npm run build && npm run test:e2e` (if UI or flows changed)

## Checklist

- [ ] Money stays in integer minor units; no floats in billing/attribution paths
- [ ] Every new route/action calls an authorization guard; object access is org-scoped (tests added)
- [ ] New env vars documented in `.env.example` and `src/env.ts`
- [ ] Migrations generated with `npm run db:generate` and committed
- [ ] Nothing client-facing exposes spend, impressions, CTR, CPC or ROAS
- [ ] Docs updated (README / docs/) where behaviour changed
