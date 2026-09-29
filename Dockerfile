# syntax=docker/dockerfile:1.7
# Multi-stage build: deps → build (Next.js standalone + bundled CLIs) → minimal non-root runtime.

FROM node:26-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ---- dependencies ------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
# Optional build secret `extra_ca`: a CA bundle for networks that re-terminate TLS (corporate
# proxies). It is only mounted for this step and never written into any image layer:
#   docker build --secret id=extra_ca,src=/path/to/ca-bundle.crt .
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; \
    fi; \
    npm ci --no-audit --no-fund

# ---- build -------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined at build time.
ARG NEXT_PUBLIC_APP_NAME="Outcome Ads"
ENV NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME} \
    SKIP_ENV_VALIDATION=1
RUN npm run build

# ---- runtime -----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Migrations + bundled CLIs:  node migrate.mjs | node job.mjs <job-name> | node rotate-secrets.mjs
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/dist/migrate.mjs ./migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/job.mjs ./job.mjs
COPY --from=builder --chown=nextjs:nodejs /app/dist/rotate-secrets.mjs ./rotate-secrets.mjs

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
