# Order-To-Cash — shared multi-stage build for every NestJS service
# (gateway, orders, fulfillment, billing, notifications, projector). Phase 23
# (docker-compose.apps.yml). One Dockerfile, parameterised by the `SERVICE`
# build ARG (the apps/<service> directory name, which is also the package
# name suffix: apps/orders == @otc/orders) — the six services build
# identically, so six near-duplicate Dockerfiles would just be six places to
# forget to fix the same bug in.
#
# Every service's REAL build is `tsc -p tsconfig.build.json` (never
# tsx/esbuild) — see CLAUDE.md's DI-tokens rule: `tsc` emits
# `design:paramtypes` (emitDecoratorMetadata), esbuild-based tooling silently
# drops it, and a bare-typed Nest constructor parameter then resolves to
# `undefined` at first use instead of failing to build. This Dockerfile runs
# the exact same `pnpm run build` (tsc) the root `pnpm build` script runs,
# then `node dist/main.js` — never `tsx`.
#
# Workspace-build mechanism (investigated, not assumed): `packages/contracts`
# and `packages/shared-kernel` are consumed via PRE-BUILT `dist/` output
# (their package.json `main`/`types` point at `dist/index.js`/`dist/index.d.ts`
# — see progress/impl_infra_compose_apps.md), never live TS source through a
# path mapping (tsconfig.base.json declares none). Every app's package.json
# depends on them as `workspace:*`. `context: .` (repo root) is required —
# pnpm needs the full lockfile + workspace manifest set to install, and the
# two packages must be built BEFORE the app that imports their `dist/`.
# `pnpm --filter "@otc/<service>..." run build` (trailing `...` = the package
# PLUS its workspace dependencies) builds shared-kernel, contracts and the
# target app in one topologically-ordered command — no manual ordering here.
#
# Two final stages: `runtime` (the long-running server, `node dist/main.js`)
# and `migrate` (the one-shot Drizzle migration CLI already committed as
# each service's `db:migrate` script) — orders/fulfillment/billing/
# notifications only; gateway/projector own no MySQL database and never
# `target: migrate`.

ARG NODE_VERSION=24.19.0

# ── deps — full workspace install, WITH devDependencies (needed to compile
#    with tsc) ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN corepack enable && corepack install -g pnpm@11.22.0
WORKDIR /app
# Every workspace member's package.json + the lockfile — pnpm validates
# --frozen-lockfile against the WHOLE workspace manifest set, not just the
# packages being filtered, so all of them must be present even though only
# one service + its two package deps get built.
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
ARG SERVICE
RUN pnpm install --frozen-lockfile --filter "@otc/${SERVICE}..."

# ── build — compile the target service + its two workspace deps with tsc ──
FROM deps AS build
ARG SERVICE
COPY tsconfig.base.json ./
COPY packages/shared-kernel packages/shared-kernel
COPY packages/contracts packages/contracts
COPY apps/${SERVICE} apps/${SERVICE}
RUN pnpm --filter "@otc/${SERVICE}..." run build

# ── prod-deps — the same filtered install, --prod only (no devDependencies:
#    no tsc, no tsx, no drizzle-kit, no test tooling in the runtime image) ──
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
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
ARG SERVICE
RUN pnpm install --frozen-lockfile --prod --filter "@otc/${SERVICE}..."

# ── runtime — slim: plain Node, no pnpm, no source, no devDependencies ────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG SERVICE
ARG PORT_ENV_VAR
ARG DEFAULT_PORT
ENV NODE_ENV=production
ENV APP_DIR=apps/${SERVICE}
ENV PORT_ENV_VAR=${PORT_ENV_VAR}
ENV DEFAULT_PORT=${DEFAULT_PORT}
WORKDIR /app

# pnpm's node-linker resolves workspace deps (@otc/contracts, @otc/shared-kernel)
# as symlinks from apps/<service>/node_modules into packages/*/ (relative,
# by directory depth) and every registry dep as a symlink into the root
# node_modules/.pnpm store — both trees must be copied to preserve them.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/packages/shared-kernel/package.json ./packages/shared-kernel/package.json
COPY --from=prod-deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=prod-deps /app/${APP_DIR}/package.json ./${APP_DIR}/package.json
COPY --from=prod-deps /app/${APP_DIR}/node_modules ./${APP_DIR}/node_modules

# Compiled output only — never the TS source, never a devDependency.
COPY --from=build /app/packages/shared-kernel/dist ./packages/shared-kernel/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/${APP_DIR}/dist ./${APP_DIR}/dist

# apps/gateway's setup-docs.ts reads specs/shared/openapi.yaml at RUNTIME
# (`path.resolve(__dirname, '../../../../specs/shared/openapi.yaml')`,
# resolving to /app/specs/shared/openapi.yaml from compiled dist — found by
# actually booting this image against the running infra stack; the gateway
# container came up unhealthy with `ENOENT .../specs/shared/openapi.yaml`
# until this line was added, see progress/impl_infra_compose_apps.md). No
# other service reads from specs/ at runtime (checked), but the file is
# small (68 KB) and this Dockerfile is shared across all six services, so
# copying it unconditionally is simpler than a service-specific branch.
COPY specs/shared/openapi.yaml ./specs/shared/openapi.yaml

# No wget/curl in this image on purpose (keeps the runtime slim) — the
# healthcheck uses Node's own http client instead, against this service's
# `GET /health/ready` (see apps/*/src/presentation/health.controller.ts),
# the same endpoint every service already exposes for feature 14's
# readiness contract. PORT_ENV_VAR/DEFAULT_PORT let one shared HEALTHCHECK
# work across all six services despite each reading a differently-named
# port env var (ORDERS_PORT, GATEWAY_PORT, ...).
HEALTHCHECK --interval=5s --timeout=5s --retries=20 --start-period=20s \
  CMD node -e "const p=process.env[process.env.PORT_ENV_VAR]||process.env.DEFAULT_PORT;require('http').get('http://localhost:'+p+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD node ${APP_DIR}/dist/main.js

# ── migrate — one-shot Drizzle migration CLI (orders/fulfillment/billing/
#    notifications only), reusing the SAME compiled dist + prod deps as the
#    runtime stage above — never tsx, same "real build is tsc" discipline. ──
FROM node:${NODE_VERSION}-bookworm-slim AS migrate
ARG SERVICE
ENV APP_DIR=apps/${SERVICE}
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/packages/shared-kernel/package.json ./packages/shared-kernel/package.json
COPY --from=prod-deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=prod-deps /app/${APP_DIR}/package.json ./${APP_DIR}/package.json
COPY --from=prod-deps /app/${APP_DIR}/node_modules ./${APP_DIR}/node_modules
COPY --from=build /app/packages/shared-kernel/dist ./packages/shared-kernel/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/${APP_DIR}/dist ./${APP_DIR}/dist
# The committed SQL migrations (drizzle-kit generate output) — static files,
# copied straight from the build context, never compiled.
COPY apps/${SERVICE}/drizzle ./${APP_DIR}/drizzle
CMD node ${APP_DIR}/dist/infrastructure/persistence/migrate-cli.js
