# Order-To-Cash — apps/web (Nuxt 4) build. Phase 23 (docker-compose.apps.yml).
#
# Different shape from infra/docker/service/Dockerfile on purpose: Nuxt's
# Nitro build (`nuxt build`, default `node-server` preset — no preset is
# declared in apps/web/nuxt.config.ts, so this is the default) produces a
# SELF-CONTAINED `.output/` directory that bundles its own `node_modules`
# (verified against a real local build: `apps/web/.output/server/` already
# carries its own `node_modules`, ~9 MB total). The runtime stage therefore
# needs neither pnpm nor the monorepo's own node_modules/symlink tree the
# NestJS services' runtime stage requires — just `.output/` and plain Node.
#
# apps/web depends on `@otc/contracts` (workspace:*, pre-built dist/ output,
# same mechanism as every NestJS service) but NOT `@otc/shared-kernel` — see
# apps/web/package.json.
#
# `context: .` (repo root) — same reason as infra/docker/service/Dockerfile:
# pnpm workspaces need the full lockfile/manifest set to install.

ARG NODE_VERSION=24.19.0

# ── deps — full workspace install (nuxt build needs devDependencies: nuxt,
#    tailwind, vue-tsc, etc.) ───────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN corepack enable && corepack install -g pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared-kernel/package.json packages/shared-kernel/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/orders/package.json apps/orders/package.json
COPY apps/fulfillment/package.json apps/fulfillment/package.json
COPY apps/billing/package.json apps/billing/package.json
COPY apps/notifications/package.json apps/notifications/package.json
COPY apps/projector/package.json apps/projector/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/seed/package.json apps/seed/package.json
# `postinstall: nuxt prepare` (apps/web/package.json) runs automatically as
# part of this install for the web workspace member.
RUN pnpm install --frozen-lockfile --filter "@otc/web..."

# ── build — @otc/contracts (its one workspace dep) then `nuxt build` ──────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter "@otc/contracts" run build
# GATEWAY_BASE_URL/NUXT_SESSION_PASSWORD read by nuxt.config.ts at build time
# only set the BAKED-IN default — both are overridden at container start via
# Nitro's runtime-config env convention (NUXT_<KEY> — see
# docker-compose.apps.yml's `web` service `environment:` block and
# progress/impl_infra_compose_apps.md), so no secret needs to be a build arg.
RUN pnpm --filter "@otc/web" run build

# ── runtime — the self-contained Nitro output, nothing else ───────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.output ./.output

# No wget/curl in this slim image — Node's own http client drives the
# healthcheck instead. apps/web exposes no /health endpoint (confirmed: no
# match under apps/web/server for "health") — GET / is the best-effort proxy
# used here; a 401/302 (auth redirect) still proves the Nitro process is
# alive and serving, which is the only thing this check is for.
HEALTHCHECK --interval=5s --timeout=5s --retries=20 --start-period=20s \
  CMD node -e "const p=process.env.PORT||3000;require('http').get('http://localhost:'+p+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
