# Order-To-Cash — apps/seed (one-shot demo-data CLI). Phase 23
# (docker-compose.apps.yml, `seed` profile — never started by default; run
# with `docker compose --profile seed run --rm seed`).
#
# Thin, deliberately: apps/seed is a plain script with no DI container, so
# CLAUDE.md's own carve-out applies — "apps/web (Nuxt/Vite) and apps/seed (a
# plain script, no DI container) are unaffected and keep their own dev
# tooling." Its committed `seed` script already runs via `tsx src/index.ts`
# (apps/seed/package.json), not `tsc` + `node dist`, so this Dockerfile
# mirrors that exactly instead of introducing a build step the source
# package itself doesn't have. `context: .` (repo root) — same workspace
# reason as the other two Dockerfiles.
#
# apps/seed depends on @otc/contracts and @otc/shared-kernel (workspace:*,
# pre-built dist/ output) — both are built here before `tsx` runs, same as
# every other app.
#
# apps/seed ALSO reaches directly into three sibling apps' own TS SOURCE by
# relative import — apps/seed/src/writers/{orders,fulfillment,billing}-db.writer.ts
# import `../../../<app>/src/infrastructure/persistence/{migrator,schema}`
# (running the exact same committed Drizzle migrator + schema each service's
# own db:migrate uses, so seeded data and migrated shape can never drift
# apart). Found by actually running this image against the live stack: it
# failed `MODULE_NOT_FOUND` until apps/orders, apps/fulfillment and
# apps/billing were copied in and installed alongside apps/seed (see
# progress/impl_infra_compose_apps.md). This is the one place in the
# monorepo where an app's source is a build-time dependency of ANOTHER
# app's source, not just of packages/* — a pre-existing repo shape, not
# something introduced here.

ARG NODE_VERSION=24.19.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
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
# orders/fulfillment/billing are installed too (not just filtered-in via
# seed's own deps) so each gets its OWN node_modules with correctly-resolved
# symlinks (drizzle-orm, mysql2, ...) for the schema/migrator files tsx
# loads directly from their src/ below.
RUN pnpm install --frozen-lockfile --filter "@otc/seed..." --filter "@otc/orders" --filter "@otc/fulfillment" --filter "@otc/billing"
COPY tsconfig.base.json ./
COPY packages/shared-kernel packages/shared-kernel
COPY packages/contracts packages/contracts
COPY apps/seed apps/seed
COPY apps/orders apps/orders
COPY apps/fulfillment apps/fulfillment
COPY apps/billing apps/billing
RUN pnpm --filter "@otc/shared-kernel" run build && pnpm --filter "@otc/contracts" run build

WORKDIR /app/apps/seed

# ── non-root ──────────────────────────────────────────────────────────────
# Single-stage image, so unlike the other two Dockerfiles there is no
# `COPY --chown` to hang ownership off: pnpm installs and builds as root
# above, and this stage keeps that (corepack's global pnpm install needs
# root, and a `RUN chown -R /app` would duplicate this image's ~786 MB tree
# into a second layer). `USER node` last is enough because uid 1000 only
# ever READS /app here — everything root wrote is mode 644/755 (default
# umask 022), so it is world-readable, and:
#   * this CLI writes exclusively to MySQL and MongoDB over the network —
#     grepped apps/seed/src for writeFileSync/mkdirSync/createWriteStream,
#     zero hits, it produces no local artefact;
#   * `tsx` (esbuild) keeps its transform cache under os.tmpdir(), i.e.
#     /tmp (mode 1777), never under /app;
#   * it binds no port at all, so the >1024 question does not arise.
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]
