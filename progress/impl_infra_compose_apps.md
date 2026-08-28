# impl_infra_compose_apps

**Feature:** Full Docker Compose (phase 23, README.md's own progress table)
**Scope:** application containers on top of the already-proven, infra-only
`docker-compose.infra.yml` — which explicitly defers app containers to this
phase (its own header comment: "NO application containers here — those
arrive in phase 23").

## What this is

Twelve new Docker images (six NestJS services, the Nuxt 4 web app, four
one-shot Drizzle migration jobs, and the one-shot seed CLI) plus a new
`docker-compose.apps.yml` that wires them onto the existing `otc-net`
network, joined to the infra file via a two-`-f` invocation. Not built from
assumption — every claim below was checked against the real source, and the
compose file was actually built and booted against the live infra stack
(not just `config`-rendered).

## Files created / changed

- `infra/docker/service/Dockerfile` — new. Shared multi-stage Dockerfile for
  all six NestJS services (`gateway`, `orders`, `fulfillment`, `billing`,
  `notifications`, `projector`), parameterised by a `SERVICE` build ARG.
  Stages: `deps` (full workspace install incl. devDependencies, filtered to
  the target service + its workspace deps) → `build` (`tsc -p
  tsconfig.build.json`, never `tsx`) → `prod-deps` (same filtered install,
  `--prod` only) → `runtime` (slim, no pnpm, no source) and `migrate` (the
  same compiled `dist/` reused for the service's `db:migrate` CLI).
- `infra/docker/web/Dockerfile` — new. Different shape: Nitro's `node-server`
  preset produces a self-contained `.output/` (confirmed against a real
  local build: it bundles its own `node_modules`, ~9 MB), so the runtime
  stage is just `COPY --from=build /app/apps/web/.output ./.output` — no
  monorepo `node_modules`/symlink tree needed at all.
- `infra/docker/seed/Dockerfile` — new. Thin, per CLAUDE.md's own carve-out
  for `apps/seed` (plain script, no DI container) — runs via `tsx
  src/index.ts` exactly as the committed `seed` script does, never `tsc`.
  **Also copies and installs `apps/orders`, `apps/fulfillment` and
  `apps/billing`** — see "Finding 2" below for why this was necessary and
  not optional.
- `docker-compose.apps.yml` — new, repo root. Six app services + four
  `<service>-migrate` one-shot jobs + `web` + `seed` (behind the `seed`
  profile). `otc-net` declared `external: true` — starting this file alone
  fails loudly instead of silently creating a second network.
- `package.json` — added `dc:up:apps`, `dc:down:apps`, `dc:ps:apps`,
  `dc:clean:apps`, `dc:logs:apps`, `dc:build:apps`, `dc:seed` — same naming
  pattern as the existing `dc:*:infra` scripts, always passing both compose
  files.
- `README.md` — phase 23 row flipped to ✅ with a one-line summary; new
  "Running the full stack in Docker" section (URL table, migration-job
  ordering, seed-profile invocation, image-build discipline).

No changes anywhere under `apps/` or `packages/` — confirmed by `git status`
after this session (see "State left running" below).

## Workspace-build mechanism — investigated, not assumed

Read (in this order): root `package.json`'s `build` script, `tsconfig.base.json`,
`packages/shared-kernel/package.json`, `packages/contracts/package.json`,
`apps/seed/package.json`, every other app's `package.json`, `pnpm-workspace.yaml`.

- **`packages/shared-kernel`** and **`packages/contracts`** are consumed via
  **pre-built `dist/` output** — both `package.json`s declare `"main":
  "dist/index.js"`, `"types": "dist/index.d.ts"`, no `exports` map pointing
  at `src/`. `tsconfig.base.json` declares **no path mapping** for `@otc/*`
  — confirming there is no live-TS-source-via-paths alternative. Every app
  depends on both as `workspace:*` (verified in `apps/seed/package.json`,
  `apps/orders/package.json`, etc.) — pnpm resolves this to a symlink into
  the sibling `packages/*` directory, so **the two packages must be built
  before the app that imports them**, and the app's own `tsc` compile
  needs their `.d.ts` files already on disk.
- **Every NestJS service's real build is `tsc -p tsconfig.build.json`**
  (`apps/*/package.json` `"build"` script) — confirmed for all six.
  `tsconfig.base.json` sets `emitDecoratorMetadata: true`; this Dockerfile
  never substitutes `tsx`/esbuild for the actual build step, only for
  `apps/seed`'s own already-`tsx`-based script (CLAUDE.md's explicit
  carve-out for that one app).
- **`context: .` (repo root) is required**, not `apps/<service>` — pnpm
  needs the full lockfile + every workspace member's `package.json` to
  validate `--frozen-lockfile`, confirmed empirically: the first `deps`
  stage attempt with only the target app's `package.json` present failed
  lockfile validation. Fixed by copying **every** workspace member's
  `package.json` (all 8) into every `deps`/`prod-deps` stage regardless of
  which single service is being built — cheap (KB-sized files, well cached)
  and the only way `--frozen-lockfile` passes.
- `pnpm --filter "@otc/<service>..." run build` (trailing `...` = the
  package **and its workspace dependencies**) builds `shared-kernel`,
  `contracts` and the target app in one topologically-ordered command — no
  manually-ordered build steps anywhere in these Dockerfiles.
- Node/pnpm pinned exactly per `.nvmrc` (`24.19.0`) and root `package.json`'s
  `"packageManager": "pnpm@11.22.0"` — `corepack enable && corepack install
  -g pnpm@11.22.0` in every stage that runs pnpm.
- No native-compilation toolchain (`python3`/`make`/`g++`) installed in any
  stage. Checked `pnpm-lock.yaml` for `node-gyp`/native-module patterns
  first (`bcrypt`, `argon2`, `sharp`, `canvas` — none present; the only
  `node-gyp` hits are `cpu-features`/`ssh2`, optional transitive deps of
  `dockerode` via Testcontainers, dev-only and never reached at runtime).
  This was **verified, not assumed**: the `deps` stage install genuinely
  logs `cpu-features`/`ssh2` failing their optional native builds
  ("Unable to detect compiler type" / "Could not find any Python
  installation") and continues anyway — `pnpm install` treats these as
  non-fatal optional-dependency failures, and every real build below
  succeeded regardless.

## Two things the "plausible YAML" pass would have missed — found by actually booting

### Finding 1 — `apps/gateway`'s Swagger setup reads a spec file at runtime

`apps/gateway/src/presentation/setup-docs.ts` does
`path.resolve(__dirname, '../../../../specs/shared/openapi.yaml')` and
`readFileSync`s it **at boot**, not build time. From compiled
`apps/gateway/dist/presentation/setup-docs.js`, that resolves to
`/app/specs/shared/openapi.yaml`. `config`-only verification would never
have caught this — the container built fine and only failed at runtime, in
a retry loop, until the healthcheck's `start_period` ran out:

```
Error: ENOENT: no such file or directory, open '/app/specs/shared/openapi.yaml'
    at readFileSync (node:fs:484:20)
    at setupDocs (/app/apps/gateway/dist/presentation/setup-docs.js:19:79)
```

Grepped every other app's `src/` for the same `__dirname`-relative-into-`specs/`
pattern — no other service does this. Fixed by adding one line to
`infra/docker/service/Dockerfile`'s `runtime` stage:
`COPY specs/shared/openapi.yaml ./specs/shared/openapi.yaml` (68 KB,
applied unconditionally across all six services rather than branching the
shared Dockerfile for one).

### Finding 2 — `apps/seed` imports directly from three sibling apps' own `src/`

`apps/seed/src/writers/{orders,fulfillment,billing}-db.writer.ts` import
`../../../<app>/src/infrastructure/persistence/{migrator,schema}` — running
the exact same committed Drizzle migrator + schema each service's own
`db:migrate` uses (not through `packages/*`, a direct cross-app source
import — a pre-existing repo shape, not something introduced here). The
first `seed` image (which only copied `apps/seed`) failed:

```
Error: Cannot find module '../../../orders/src/infrastructure/persistence/client'
```

Fixed by extending `infra/docker/seed/Dockerfile` to also `COPY` and
`pnpm install --filter` in `apps/orders`, `apps/fulfillment`,
`apps/billing` (so each gets its own correctly-resolved `node_modules` for
`drizzle-orm`/`mysql2`, not just raw source with no way to resolve their
imports).

## Verification — actually run, real output

Docker available: `docker version` → Docker Desktop 4.74.0, Engine 29.4.3.
`docker compose version` → v5.1.4.

**1. `docker compose ... config`** — clean, no warnings, all 6 app services +
4 migrate jobs render (seed correctly absent without `--profile seed`).
Spot-checked rendered env vars for `orders` (`KAFKA_BROKERS: kafka:29092`,
`NATS_URL: nats://nats:4222`, `ORDERS_DB_HOST: mysql`,
`OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317`), `orders-migrate`
(`ORDERS_DB_HOST: mysql`, no Kafka/NATS vars needed), `web`
(`NUXT_GATEWAY_BASE_URL: http://gateway:3001`, `NUXT_SESSION_PASSWORD`
correctly falls back to the app's own dev default — see caveat below), and
`notifications` (correctly has no NATS override — its `main.ts` opens no
NATS transport).

**2. Built every one of the 12 images**, against the repo's real source —
not a dry run:

```
$ docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml build orders
 Image otc-orders:local Built    (54s)
$ docker compose ... build orders-migrate
 Image otc-orders-migrate:local Built    (cached deps, 0.1s incremental)
$ docker compose ... build fulfillment billing notifications projector gateway
 Image otc-fulfillment:local Built
 Image otc-billing:local Built
 Image otc-notifications:local Built
 Image otc-projector:local Built
 Image otc-gateway:local Built    (119s combined)
$ docker compose ... build fulfillment-migrate billing-migrate notifications-migrate web
 Image otc-fulfillment-migrate:local Built
 Image otc-billing-migrate:local Built
 Image otc-notifications-migrate:local Built
 Image otc-web:local Built    (67s combined — includes a full `nuxt build`,
                                6.01 MB Nitro output, "✨ Build complete!")
$ docker compose ... --profile seed build seed
 Image otc-seed:local Built
```

Sizes: ~291–304 MB per NestJS runtime image, 236 MB for `web`, 786 MB for
`seed` (full dev install, not slimmed — a one-off CLI, size not optimised).

**3. Ran the four migration jobs against the real, already-running MySQL**
(the same `otc-mysql` container `docker-compose.infra.yml` had already
proven healthy):

```
$ docker compose ... up orders-migrate
otc-orders-migrate | [orders] migrations applied against mysql:3306/otc_orders
otc-orders-migrate exited with code 0
```
All four (`orders-migrate`, `fulfillment-migrate`, `billing-migrate`,
`notifications-migrate`) exited `0` with their respective
"migrations applied against mysql:3306/otc_<db>" line.

**4. Booted `orders` alone first** (the most demanding dependency set —
MySQL + Kafka + NATS — exactly as instructed) and polled its container
health directly:

```
$ docker inspect --format='{{.State.Health.Status}}' otc-orders
healthy    (within ~4s of container start)
$ curl -s -o /dev/null -w "http=%{http_code}\n" http://localhost:3002/health/ready
http=200
$ curl -s http://localhost:3002/health/ready
{"status":"up","checks":{"writeModel":{"status":"up"},"factStream":{"status":"up"},"rpcTransport":{"status":"up"}}}
```

**5. Brought up the FULL app stack** (`docker compose ... up -d`) against the
live infra. First attempt surfaced Finding 1 (gateway `ENOENT`) — fixed,
rebuilt, re-ran. Final state, all healthy:

```
$ docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml ps --format '{{.Name}}\t{{.Status}}'
otc-billing          Up (healthy)
otc-fulfillment      Up (healthy)
otc-gateway          Up (healthy)
otc-notifications    Up (healthy)
otc-orders           Up (healthy)
otc-projector        Up (healthy)
otc-web              Up (healthy)
... (plus all 11 infra containers, unchanged, still healthy)
```

Real `/health/ready` responses from every backend service, all HTTP 200,
all checks `"up"`:

```
gateway (:3001)        {"status":"up","checks":{"readModel":"up","rpcTransport":"up"}}
orders (:3002)         {"status":"up","checks":{"writeModel":"up","factStream":"up","rpcTransport":"up"}}
fulfillment (:3003)    {"status":"up","checks":{"writeModel":"up","rpcTransport":"up"}}
billing (:3004)        {"status":"up","checks":{"writeModel":"up","rpcTransport":"up"}}
notifications (:3005)  {"status":"up","checks":{"writeModel":"up","factStream":"up"}}
projector (:3006)      {"status":"up","checks":{"readModel":"up","factStream":"up"}}
web (:3010*)           HTTP 302 (redirect — unauthenticated, expected; process alive and serving)
```
\* see the port-3000 caveat below for why `web` was verified on 3010, not 3000.

**6. Ran the seed job for real** (`--profile seed run --rm seed`), first
attempt surfaced Finding 2 (`MODULE_NOT_FOUND`) — fixed, rebuilt, re-ran to
completion:

```
[seed] applying migrations (orders, fulfillment, billing)…
[seed] writing master data (currencies, products, retailers, companies, stock, credits)…
[seed] writing sample saga history (5 completed + 1 cancelled)…
[seed] verifying…
[seed] OK — self-verification summary: { "orders": {...}, "fulfillment": {...}, "billing": {...}, "mongoOrderTimelines": 61 }
[seed] done.
```
(Row counts are higher than a fresh install's 6 sample orders because this
MySQL volume already carried data from earlier manual saga-verification
sessions — the seed's own self-verification still passed, which is what
matters here; `--rm` cleaned up the ephemeral run container afterward,
confirmed via `docker ps -a` showing no leftover `otc-seed-run-*`.)

## What I could not fully verify / follow-ups

- **Host port 3000 was occupied by an unrelated local process** (a
  `MainThread` on this machine, pid unrelated to this project) during
  verification, so `web` was actually booted with `WEB_PORT=3010` for this
  session's health check rather than the compose file's own default 3000.
  This is **not a defect in `docker-compose.apps.yml`** — `docker compose
  ... config` confirms the file correctly uses `${WEB_PORT:-3000}`
  end-to-end, and the container's own internal healthcheck (which runs
  inside the container's network namespace, independent of the host
  mapping) passed regardless. Re-verify on a host where port 3000 is free,
  or stop whatever else is bound to it, to see `web` on its documented
  default port.
- **The local `.env` was stale relative to `.env.example`** — missing
  `NUXT_SESSION_PASSWORD`, `GATEWAY_BASE_URL`, `KAFKA_BROKERS`, every
  `SAGA_*`/`OUTBOX_*` tuning var, and a few others (all added in later
  phases, e.g. `web_app`, `order_saga_orchestrator`). None of these break
  anything — every one has a safe code-level default — but
  `docker-compose.apps.yml`'s `NUXT_SESSION_PASSWORD` line was written with
  a compose-level `${VAR:-default}` fallback specifically so a stale `.env`
  degrades to the app's own documented dev default instead of silently
  becoming an empty string. Did not edit `.env` itself (a git-ignored local
  file, out of this task's stated scope) — worth a note for whoever next
  touches it, since `.env.example` is presumably meant to be the template
  to re-diff against periodically.
- **No load/soak testing, no Playwright run against the containerized
  stack** — out of scope for this phase; phases 17–19 own that, against
  whichever runtime (CLI or compose) is in front at the time.
- **`seed`'s runtime image is not slimmed** (786 MB, full dev install) —
  deliberate given it is a one-off CLI never left running, but worth
  flagging if image size ever becomes a constraint.
- Did not attempt a `docker compose down -v && up -d` full cold-start cycle
  (timeboxed) — every piece was verified against the already-running,
  already-proven infra stack instead. The migration jobs' own
  `depends_on: mysql: condition: service_healthy` plus each app's
  `depends_on: <service>-migrate: condition: service_completed_successfully`
  is what a cold start relies on, and both halves of that chain were
  exercised directly (mysql was healthy before migrate ran; migrate exited
  0 before the app started) — just not in one single unbroken `down`→`up`.

## State left running

The full stack — 11 infra containers + 6 app services + `web` (on 3010, see
caveat) — is up and healthy. All 12 app images (`otc-*:local`) are built
and present locally. No stray containers (`docker ps -a` confirms the
`seed` run container was cleaned up by `--rm`). No changes under `apps/` or
`packages/`. No commit, no push.
