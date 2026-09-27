# Contributing

## Workflow

1. Branch from `main` (`feat/…`, `fix/…`); keep PRs small and focused.
2. `npm ci`, `cp .env.example .env`, `docker compose up -d db mailpit`, `npm run db:migrate`.
3. Before pushing: `npm run lint && npm run format:check && npm run typecheck && npm test`;
   for UI/flow changes also `npm run build && npm run test:e2e`.
4. Open a PR using the template; CI must be green.

## Conventions

- Business rules live in `src/lib` as **pure functions** with unit tests (edge cases first). I/O
  lives in `src/server`; routes stay thin.
- Money is integer minor units + currency; rates are basis points; periods are UTC.
- Validate every input with Zod (forms, route handlers, webhooks, env).
- Every route handler / server action starts with an authorization guard; scope queries by the
  session's org; add an authorization test for new object access.
- Schema changes: edit `src/db/schema.ts`, run `npm run db:generate`, commit the SQL in `drizzle/`.
  Keep migrations backwards compatible with the previous release.
- New env vars: add to `src/env.ts` and document in `.env.example` and the README table.
- Never expose spend, impressions, clicks, CTR, CPC or ROAS to client users.
- Commits: imperative, conventional prefix (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
