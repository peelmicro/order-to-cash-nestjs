# Order To Cash

> 🚧 **Under construction.** This repository is being built phase by phase. The table below is the honest state of play — anything not marked ✅ does not exist yet. The full documentation (architecture diagrams, saga walkthrough, trade-offs, demo GIF) lands in Phase 24.

An **order-to-cash lifecycle backbone** for a B2B EDI / e-invoicing platform, built as event-driven microservices. It models the classic EDI exchange as a distributed workflow:

**Order (ORDERS) → Stock reservation → Credit check → Order confirmation (ORDRSP) → Despatch advice (DESADV) → Invoice (INVOIC) → Payment (remittance)**

— with an orchestrated **saga** coordinating the flow across services and **compensating** when a step fails. Deliberately B2B in shape: the retailer never pays at order time; a credit check gates despatch, and payment arrives at the end of the cycle, within payment terms.

## Why this project exists

This is **assessment #7 of a three-part series** that implements the *same specification* on three different stacks, to produce an empirical comparison of how much a mature spec plus an agent harness accelerates a full re-implementation:

| # | Backend | Frontend | Write DB | Repository |
|---|---------|----------|----------|------------|
| **7** | **NestJS 11** | **Nuxt 4 + shadcn-vue** | **MySQL 8** | **this one** |
| 8 | .NET 10 | Next.js + shadcn/ui | MS-SQL Server | pending |
| 9 | Python (FastAPI) | Angular + spartan/ui | PostgreSQL | pending |

Two things built here are meant to be reused verbatim by #8 and #9: the stack-agnostic specification in `specs/shared/` and the agent harness (`AGENTS.md`, `feature_list.json`, `progress/`, `.claude/agents/`). The development **process is a deliverable**, not just the software.

## What it looks like

Every image below except the two n8n ones is regenerated from a live, seeded stack by **`pnpm media:capture`** (and **`pnpm media:demo`** for the GIF), so they are reproducible evidence rather than hand-cropped one-offs that rot silently as the UI changes. n8n 2.x authenticates with an owner account whose credentials are deliberately not in `.env`, so those two are captured by hand.

### The `.99` compensation, end to end

![Placing a .99 order and watching the saga compensate live](docs/screenshots/demo-compensation.gif)

A total ending in `.99` makes the credit simulator reject the hold. The saga then releases the stock it had already reserved and cancels the order, and both compensation steps stay separately visible in the timeline rather than collapsing into one "failed" entry.

### The order timeline

The happy path to `completed`, and the same view for a compensated order — each entry naming the fact that caused it:

![Order detail with the full timeline for a completed order](docs/screenshots/web-order-timeline-completed.png)

![Order detail for a cancelled order, showing stock released then the order cancelled](docs/screenshots/web-order-timeline-compensated.png)

### One order, one trace, six services

![A single Jaeger trace spanning gateway, orders, fulfillment, billing, projector and notifications](docs/screenshots/jaeger-single-order-trace.png)

22 spans, depth 11, across all six services — HTTP into the Gateway, NATS RPC, MySQL, the outbox relay, Kafka, and every consumer that reacted. The `traceparent` is carried on the message envelope, which is what joins the producer's span to the consumer's.

### Grafana

![The Order To Cash overview dashboard](docs/screenshots/grafana-overview.png)

Saga duration (p50/p95, split by `completed` vs `cancelled`), per-service latency, Kafka consumer lag read from the broker's own offsets, outbox lag and DLQ depth. Note that **Saga duration is legitimately empty until an order reaches a terminal state in the current process** — OTel records that histogram only on completion or cancellation, so a freshly restarted stack shows "No data" until the first saga finishes.

### Notifications, and the external world

Mailpit receives every notification the system sends — no account, no quota, and no SMTP password anywhere in the repo:

![The Mailpit inbox holding the order lifecycle emails](docs/screenshots/mailpit-inbox.png)

The four n8n workflows that drive the system unattended, and their executions firing on their own schedules:

![The four n8n workflows, all published](docs/screenshots/n8n-workflows.png)

![n8n executions succeeding on schedule](docs/screenshots/n8n-executions.png)

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 LTS + TypeScript |
| Backend | NestJS 11, `@nestjs/cqrs`, `@nestjs/microservices` |
| Write databases | MySQL 8 — database per service (orders, fulfillment, billing) |
| ORM | Drizzle ORM (MySQL dialect) |
| Read model | MongoDB 7 — `order_timeline` collection |
| Domain facts | Apache Kafka (KRaft single node) + Redpanda Console |
| RPC | NATS 2 core request-reply (no JetStream) |
| Observability | OpenTelemetry → OTel Collector → Jaeger + Prometheus + Grafana |
| Frontend | Nuxt 4, shadcn-vue, Tailwind CSS v4, TanStack Query |
| Testing | Vitest (the only runner), Testcontainers, Supertest, Vue Testing Library, Playwright |
| Demo workflows | n8n — 4 pre-loaded workflows, Gateway REST API only |
| Monorepo | pnpm workspaces |
| Infrastructure | Docker Compose (~19 containers) |

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24.19.0 | `nvm use` — the version is pinned in [`.nvmrc`](.nvmrc) |
| pnpm | 11.x | via corepack: `corepack enable && corepack install -g pnpm@latest` |
| Docker + Compose | latest | required from Phase 4 onwards |

> **If you run more than one Docker daemon** (e.g. Docker Desktop *and* the system Engine), be aware that `docker` follows your active **context** while Testcontainers does not — it reads `DOCKER_HOST`, then falls back to `/var/run/docker.sock`. The integration tests can therefore run against a different daemon than your compose stack, and their disposable containers will be invisible to a plain `docker ps`. Everything still works; to watch them, point the CLI at the same socket: `DOCKER_HOST=unix:///var/run/docker.sock docker ps`.
>
> **On Linux, prefer the native Docker Engine over Docker Desktop** — and if you have both, `docker context use default` removes the split above entirely by pointing the CLI at the same socket Testcontainers already uses. Docker Desktop on Linux runs every container inside a VM: measured on this project's own dev machine, `qemu-system-x86` held **20.2 GB** of host RAM to run a stack whose containers actually used 5.1 GB, and it did not hand that memory back when the containers stopped — only stopping Docker Desktop itself did (`systemctl --user stop docker-desktop.service`). The native Engine also writes through `overlay2` straight to the host filesystem rather than through a VM disk image, which matters for a stack running four databases plus SonarQube's embedded Elasticsearch. After switching, rebuild once (`pnpm dc:build:apps`) — images and volumes do not migrate between daemons, but every store here is reproducible from `pnpm dc:seed`.

```bash
git clone https://github.com/peelmicro/order-to-cash-nestjs.git
cd order-to-cash-nestjs
nvm use            # -> Now using node v24.19.0
cp .env.example .env
```

## Working with the monorepo

```bash
pnpm install       # all 10 workspaces
pnpm quality       # lint + typecheck + test:coverage, everywhere — the gate every feature keeps green
pnpm -r build      # build all workspaces
pnpm dev:orders    # any service: dev:gateway|orders|fulfillment|billing|notifications|projector (ports 3001–3006)
pnpm dev:web       # Nuxt 4 on http://localhost:3000
pnpm contracts:generate   # regenerate types from specs/shared/*.yaml
pnpm contracts:check      # fail if committed types drift from the specs
```

Two packages carry everything shared — and nothing else is shared between services:

- [`packages/shared-kernel`](packages/shared-kernel) — `Money` (integer minor units), `Quantity`, `GLN` (GS1 mod-10), `UniqueId`, `Entity`/`AggregateRoot`, `DomainError`. **Zero runtime dependencies**, 68 tests, 100% coverage.
- [`packages/contracts`](packages/contracts) — TypeScript types **generated** from `specs/shared/asyncapi.yaml` + `openapi.yaml` (95 schemas). Hand-writing an API type anywhere else is a review defect; editing generated output is caught by `pnpm contracts:check`.

Domain purity is enforced, not requested: an ESLint `no-restricted-imports` rule fails the build on any framework or infrastructure import inside a `domain/` folder.

> **TypeScript version:** 5.9.3. TypeScript 7 was evaluated per plan — NestJS 11 (runtime DI with `emitDecoratorMetadata`) and Vitest both passed under 7.0.2, but `vue-tsc` cannot load TS7's package layout (`ERR_PACKAGE_PATH_NOT_EXPORTED`, reproduced independently), which blocks Nuxt type-checking. Revisit when vue-tsc ships TS7 support.

### Coverage gates

`pnpm quality`'s third step is `pnpm run test:coverage` (`pnpm -r --if-present --no-bail run test:coverage`), not the plain `test` script — every workspace's own `vitest.config.mts` `coverage.thresholds` is what actually fails the gate, and it is enforced whether or not SonarQube is running. Two tiers, not one global number:

- **The six NestJS services** (`apps/{orders,billing,fulfillment,gateway,notifications,projector}`) hold `src/domain/**` to **80%** (statements/branches/functions/lines) via a per-glob threshold, and everything else in the service to **60%** — a well-covered `infrastructure/`/`presentation/` layer can never mask a thin `domain/`. (`apps/notifications/src/domain/` is currently an empty placeholder — `.gitkeep` only, no files — so its 80% tier is vacuously satisfied; see `progress/impl_sonarqube_quality_gates.md` for that observation.)
- **`packages/shared-kernel`** (pure domain, nothing else) is 80% globally; **`packages/contracts`** excludes generated code and holds the hand-written generator/barrel to 80%; **`apps/web`** and **`apps/seed`** have no `domain/` layer, so only the 60% floor applies.
- **`apps/seed`**'s three MySQL-writing files (`src/writers/{orders,fulfillment,billing}-db.writer.ts`) and `src/verify.ts`'s DB-querying half are excluded from ITS number (`coverage.exclude`, with the reasoning written into the config itself) — they are genuinely exercised, just by `seed.integration.spec.ts`'s Testcontainers run (`pnpm test:integration`), which a Docker-independent `pnpm quality` cannot reach.

`pnpm -r --no-bail` runs every workspace to completion and reports every violation together (`Summary: N fails, M passes`) rather than aborting — and tearing down — the rest of the recursive run at the first failure.

### SonarQube (optional, additional — never the enforced gate)

SonarQube (`pnpm dc:up:sonar`, ~1.5–2.3 GB RAM, `sonar` compose profile) is a genuinely optional, additional code-quality view on top of the coverage gate above, never a substitute for it — `pnpm quality` enforces coverage with SonarQube stopped. `sonar-project.properties` at the repo root configures a scan across all ten workspaces, feeding every workspace's own `coverage/lcov.info` (regenerated first, so every report file is fresh) to the JS/TS analyser and excluding `node_modules`/`dist`/build output/`packages/contracts/src/generated/**`.

```bash
pnpm dc:up:sonar                    # http://localhost:9000 once healthy (admin/admin on first login)
export SONAR_TOKEN=squ_xxxxxxxx     # a SonarQube user token, "Administration > Security > Users > Tokens"
pnpm run sonar:scan                 # regenerates every coverage/lcov.info, then runs the scanner
```

`sonar:scan` (root `package.json`) fails fast with a clear message, rather than a confusing auth error, if `SONAR_TOKEN` is unset — it reads the token from the environment on purpose, never hardcoded. It is exactly `pnpm run test:coverage` (stale LCOV would silently report the wrong numbers otherwise) followed by:

```bash
docker run --rm --network otc-net -v "$PWD:/usr/src" -e SONAR_TOKEN \
  sonarsource/sonar-scanner-cli \
  -Dsonar.host.url=http://otc-sonarqube:9000
```

— the same `--network otc-net` / `-Dsonar.host.url=http://otc-sonarqube:9000` shape documented above, verified end to end (exit 0, gate `OK`) as `pnpm run sonar:scan` itself, not just as a standalone `docker run`.

**A real trap on this machine, not a fresh-clone problem.** `pnpm dc:up:sonar` currently fails here with `network otc-net was found but has incorrect label com.docker.compose.network set to ""` — `otc-net` was created by hand (`docker network create`) earlier in this environment's life rather than by `docker compose`, so it lacks compose's own network label and every `docker compose ... up` against it refuses to proceed. A fresh clone, where compose creates `otc-net` itself on first `pnpm dc:up:infra`, would never hit this. **Do not recreate the network to fix it** — 18 other containers are attached to it, and recreating means downtime for all of them for a label mismatch that only exists on this one machine. The working alternative, when this trap fires, is to start the SonarQube container directly rather than through compose, mirroring `docker-compose.infra.yml`'s `sonarqube` service definition field-for-field (image, env, named volumes, network, port):

```bash
docker run -d --name otc-sonarqube --network otc-net \
  -p "${SONARQUBE_HOST_PORT:-9000}:9000" \
  -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true -e TZ=Europe/Madrid \
  -v sonarqube_data:/opt/sonarqube/data \
  -v sonarqube_logs:/opt/sonarqube/logs \
  -v sonarqube_extensions:/opt/sonarqube/extensions \
  sonarqube:26.8.0.126808-community
```

This is how the currently-running `otc-sonarqube` container on this machine was actually started — cross-checked field-for-field against its own `docker inspect` output (image, env, mounts, network, port all match) rather than re-run from cold, since the container is already up, healthy, and answering the live API used throughout this section; re-running it here would mean stopping a healthy container for no informational gain. **A second, related trap, verified live rather than assumed:** `pnpm dc:down:sonar` (`docker compose ... stop sonarqube`) silently does nothing against a container started this way — it exits `0` but the container stays `Up`, because `docker compose stop` matches containers by compose's own `com.docker.compose.service` label, which a plain `docker run` never sets; `docker inspect otc-sonarqube --format '{{json .Config.Labels}}'` on this machine's container carries only the image's own OCI labels, none of compose's. To stop/remove a container started via the `docker run` above, use plain `docker stop otc-sonarqube && docker rm otc-sonarqube` (data survives in the three named volumes either way), not `dc:down:sonar`.

**First scan (phase 21 follow-up).** Once disk headroom allowed SonarQube to come up healthy, a real scan ran clean: 27,814 LOC analysed. It found 29 "bugs" and 12.3% duplication — see the two subsections below for what each number means and what was done about it. `progress/impl_sonarqube_quality_gates.md`'s "SonarQube first-scan findings" section has the full before/after and the gate results that verified the fixes.

**Quality gate: `OK`.** The default SonarQube quality gate ("Sonar way") only evaluates *new* code (`new_violations`, `new_coverage`, `new_duplicated_lines_density`, measured against the previous version). Two `typescript:S5906` findings in `apps/web/app/pages/{billing,stock}/index.spec.ts` (a generic `.length` assertion where `toHaveLength(n)` reports better on failure) were genuinely trivial and fixed directly; the three `Web:InputWithoutLabelCheck` dismissals above are the rest of the five `new_violations` the gate was failing on. `pnpm run sonar:scan` now reports `new_violations: 0`, `new_coverage: 97.0` (≥80 required), `new_duplicated_lines_density: 0.0` (≤3 required) — `curl -u "$SONAR_TOKEN:" "http://localhost:9000/api/qualitygates/project_status?projectKey=order-to-cash-nestjs"` returns `"status":"OK"`.

#### The 29 first-scan "bugs" — 29 → 13 → 10, and the remaining 10 are analyser limitations, not unfixed defects

29 findings on the first scan: 20 genuine WCAG accessibility defects in `apps/web`, and 9 `typescript:S7739` misfiring on MongoDB `$switch` syntax (see below). A follow-up pass closed the 9 `S7739` findings (suppressed at the config level, see below) and 7 of 15 form-control findings — `<Input>` fields with no `id` associated to a visible `<Label for="…">`, fixed and confirmed closed in the tool — leaving 13. Of those 13, the 3 that were `Web:InputWithoutLabelCheck` hits on `apps/web/app/pages/orders/place.vue`'s Retailer/Company/Product `<Select>` opening tags (lines 282, 301, 349) were formally dismissed as false positives via the SonarQube API (`resolution=FALSE-POSITIVE`, with the reasoning below recorded as an issue comment on each), so the tool now reports **10**, not 13 — the honest arithmetic is 29 → 13 → 10 (dismissed), never 29 → 0.

The remaining 8 `<Select>` and 5 table findings are real, current, and — verified against the live accessibility tree, not just by inspection (`progress/impl_sonarqube_quality_gates.md`'s follow-up pass) — are analyser limitations, not unfixed defects: 8 `<Select>` findings had a plain `<span>` next to them with no `for`/`id` at all; that is now a proper `<Label for="…">`/`id` pair, and the live accessibility tree confirms every one resolves to a correctly-named `combobox` — but the rule wants the `id` on `<Select>` itself, which has no DOM node of its own (the ARIA `combobox` lives on the child `SelectTrigger`), so it stays flagged (3 of these 8 are now formally dismissed as false positives, per the paragraph above; the other 5 are on `billing/index.vue` and `orders/index.vue`, not yet dismissed). The 5 table findings (the shared `ui/table/Table.vue` primitive plus its 4 callers) were never real defects: SonarQube's HTML/`Web` analyser scans each `.vue` file's raw template in isolation and cannot resolve Vue SFC component composition, so a `<TableHead>` component compiling to a real `<th scope="col">` in a different file is invisible to it — the rendered DOM carries the `<th>` and its `scope` at runtime regardless.

The other 9 were `typescript:S7739` ("Do not add `then` to an object"), all 9 in one file, `apps/projector/src/infrastructure/persistence/legacy-document-backfill.ts:36-44` — a MongoDB `$switch` aggregation expression, where `then` is MongoDB's own required branch syntax (`{ case: {...}, then: 1 }`), never a Promise/thenable. Suppressed at the config level, scoped to the whole file and rule (not the nine individual lines, so a future branch in the same `$switch` stays covered) — `sonar-project.properties`'s `sonar.issue.ignore.multicriteria`, with the full reasoning written there and cross-referenced by a short comment at the flagged code itself. Checked the rest of the repo (including `delta-to-pipeline.ts`, which builds similar aggregation expressions in the same directory) for the same `$switch`/`then` shape — nowhere else today.

#### 12.3% duplication — a recorded architectural decision, not neglect

SonarQube reports 12.3% duplication, concentrated in every service's `infrastructure/outbox` and `test-support` directories (67–89% duplication there specifically). This is `CLAUDE.md`'s own rule, not an oversight: "The only shared runtime code is `packages/shared-kernel` (dependency-free) and `packages/contracts` (generated types). Nothing else is shared" — so each of the six NestJS services carries its **own copy** of the transactional-outbox and idempotent-consumer pattern rather than importing a shared package. The guard that keeps the copies from silently diverging is the **parity spec** — but it is not distributed one-per-service: three specs, all centralised in `apps/orders` and `apps/seed` (`apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts`, `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts`, `apps/seed/src/outbox-parity.spec.ts`), read every other app's copy off disk and assert banner-stripped byte identity. If `apps/billing`'s outbox copy drifts from its siblings, it is **`apps/orders`'** suite that fails, not billing's own. This number is deliberately **not** excluded from the scan (no `sonar.cpd.exclusions` entry for it) — an assessor should see 12.3% and read it as a recorded, load-bearing constraint (database-per-service boundary, no cross-service runtime coupling) rather than as unmanaged copy-paste debt.

## Running the infrastructure

The application services arrive in later phases; the infrastructure stack runs now:

```bash
pnpm dc:up:infra   # 12 containers + a one-shot kafka-init job
./init.sh          # environment + backlog + spec coherence; exits 0 when healthy
```

Poke at the running stack by hand with the [`http/`](http/) files and the REST Client VS Code extension — service liveness, the NATS subjects currently answered, the domain facts on each Kafka topic, and the Prometheus/Jaeger/Grafana APIs. Business operations travel over NATS rather than HTTP until the Gateway lands, so use `pnpm order:place` / `pnpm order:over-limit` / `pnpm saga:watch` to drive and watch the saga in the meantime. An order now runs the **whole cycle** unattended — placed → stock reserved → credit approved → confirmed → despatched → invoiced → paid → completed. `pnpm order:place` for the happy path, `--qty 1` for a total ending in `.99` (the simulator rejects it and the saga compensates), `pnpm order:over-limit` for a genuine credit rejection, and `--discount 300` to see the invoice total follow the order's net total rather than its gross. Then `pnpm invoice:list` and `pnpm invoice:pay --invoice INV-000006 --ref PAY-1 --correlation <order id>` to register the remittance that closes it.

| UI | URL |
|---|---|
| Redpanda Console (Kafka topics + DLQs) | http://localhost:8080 |
| Jaeger (traces) | http://localhost:16686 |
| Grafana | http://localhost:3030 |
| Prometheus | http://localhost:9090 |
| n8n | http://localhost:5678 |
| Mailpit (notification emails) | http://localhost:8025 |
| SonarQube (optional) | http://localhost:9000 — `pnpm dc:up:sonar` |

Every image is **pinned to an exact version** (MySQL 8.4.11 LTS, MongoDB 8.3.8, Kafka 4.3.1 KRaft, NATS 2.14.5 **core-only — no JetStream**, Jaeger v2 2.20.0, Prometheus v3.14.0, Grafana 13.2.0, n8n 2.36.2, Mailpit v1.27.5, `danielqsj/kafka-exporter` v1.9.0) so the sibling assessments reproduce the same stack. The `kafka-init` one-shot container **derives the six topics (3 fact topics + 3 `.dlq`) from [`specs/shared/asyncapi.yaml`](specs/shared/asyncapi.yaml)** — the spec is the source of truth, and topic drift fails loudly instead of passing silently. Re-run it any time with `pnpm kafka:topics`.

**Notifications' SMTP adapter is provider-neutral.** `apps/notifications` sends outbound email via plain nodemailer-over-SMTP (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM_EMAIL` — `.env.example` § SMTP) — nothing in the adapter is vendor-specific. The default stack points it at **Mailpit**, self-hosted above with no account, no quota and no secret to leak. `SMTP_*` can equally point at Mailtrap, or any other real SMTP provider, by supplying real host/credentials — Mailtrap is documented here as one option among many, not a dependency this repo requires anyone to sign up for.

Grafana auto-provisions one dashboard, **"Order To Cash — Overview"** ([`infra/grafana/dashboards/order-to-cash-overview.json`](infra/grafana/dashboards/order-to-cash-overview.json)) — saga duration, per-service latency, Kafka consumer lag, outbox lag and DLQ depth, all against live PromQL (`infra/grafana/provisioning/dashboards/`). Consumer lag is the one metric no service under `apps/` computes itself: `kafka-exporter` (a new container, `docker-compose.infra.yml`) queries the broker's own real consumer-group offsets, scraped by Prometheus as `kafka_consumergroup_lag` (`infra/prometheus/prometheus.yml`). Measured resource cost: **7.4 MiB RSS, 0.00% CPU** — negligible against Grafana's 256 MiB and Prometheus' 33 MiB — see `progress/impl_observability_dashboards.md` for the full decision and every panel's verified query.

With the infrastructure up, `pnpm seed` loads the demo data: master data (3 currencies, 12 products, 7 retailers and 22 suppliers with valid GS1 GLNs, credit limits, stock) plus six sample orders — five completed sagas and one cancelled by the `.99` credit rule — consistent across the three MySQL databases and the MongoDB `order_timeline`. Deterministic and idempotent: run it twice, nothing changes.

> **Deviation from the task document:** MongoDB is 8.3.8 rather than the mandated 7.x — version 7 was current when the task was written; nothing in the specification depends on 7-only behaviour, and the deviation is deliberate.

## Running the full stack in Docker

Everything above runs the application services from the CLI (`pnpm dev:*`) against a compose stack that provides only infrastructure. Phase 23 adds application containers on top of the same infrastructure file — build once, then every service (including the Nuxt 4 web app) runs as a container reachable on the same ports as the CLI path:

```bash
pnpm dc:up:apps    # docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml up -d
                    # brings up infra (if not already up) + 4 one-shot Drizzle
                    # migration jobs + 6 NestJS services + the web app
```

Always pass **both** compose files together (`dc:up:apps` already does) — `docker-compose.apps.yml`'s own network is declared `external: true`, so starting it alone fails loudly ("network otc-net not found") instead of silently creating a second, disconnected network. `docker compose ... down` tears down both layers together the same way.

| App | URL | Depends on (startup order) |
|---|---|---|
| Gateway (REST + Swagger) | http://localhost:3001/docs | MongoDB, NATS |
| Orders | http://localhost:3002/health/ready | its own `orders-migrate` job, Kafka topics, NATS |
| Fulfillment | http://localhost:3003/health/ready | its own `fulfillment-migrate` job, Kafka topics, NATS |
| Billing | http://localhost:3004/health/ready | its own `billing-migrate` job, Kafka topics, NATS |
| Notifications | http://localhost:3005/health/ready | its own `notifications-migrate` job, Kafka topics, Mailpit (SMTP) |
| Projector | http://localhost:3006/health/ready | MongoDB, Kafka topics, NATS |
| Web (Nuxt 4) | http://localhost:3000 | Gateway |

Each of the four MySQL-backed services (orders/fulfillment/billing/notifications) gets its own one-shot `<service>-migrate` job — `restart: "no"`, `depends_on: mysql: condition: service_healthy`, and the app container itself only starts once its migration job has exited `0` (`depends_on: <service>-migrate: condition: service_completed_successfully`). Projector needs no such job — it bootstraps its own MongoDB indexes/backfill on every boot, in `main.ts` (same as the CLI path).

`apps/seed` is a one-off CLI, not a server — it stays behind the `seed` compose profile so `up -d` never starts it:

```bash
pnpm dc:seed       # docker compose -f docker-compose.infra.yml -f docker-compose.apps.yml --profile seed run --rm seed
```

Other `dc:*:apps` scripts mirror the `dc:*:infra` ones already in use: `dc:down:apps`, `dc:ps:apps`, `dc:logs:apps`, `dc:clean:apps` (adds `-v`), `dc:build:apps`.

Every app image is built **locally** (`pull_policy: build`, same discipline as `docker-compose.infra.yml`'s `otel-collector`/`kafka-init`) — none of these are published anywhere. Build context is always the **repo root** (`context: .`, never `apps/<service>`): pnpm workspaces need the full lockfile plus every `packages/*/package.json` to install correctly. Every NestJS service's Dockerfile ([`infra/docker/service/Dockerfile`](infra/docker/service/Dockerfile), shared across all six via a `SERVICE` build ARG) runs the real build — `tsc -p tsconfig.build.json`, never `tsx`/esbuild — for exactly the reason CLAUDE.md's DI-tokens rule exists: `emitDecoratorMetadata` only survives a real `tsc` compile, and this is the one place a wrong choice here would silently break every constructor-injected provider. `apps/web` ([`infra/docker/web/Dockerfile`](infra/docker/web/Dockerfile)) is a different shape — Nitro's `node-server` preset produces a self-contained `.output/` needing no monorepo `node_modules` at runtime — and `apps/seed` ([`infra/docker/seed/Dockerfile`](infra/docker/seed/Dockerfile)) keeps its own `tsx`-based script unchanged, per CLAUDE.md's explicit carve-out for that one app.

## n8n demo workflows

Four workflows, committed as JSON under [`n8n/workflows/`](n8n/workflows/), talk **only to the Gateway REST API** — never a database, a broker, or a service's internal port (see [`specs/shared/n8n-workflows.md`](specs/shared/n8n-workflows.md), the spec both #8 and #9 reuse verbatim). They are demo automation: no requirement `R1`–`R60` is satisfied by them, and no service knows they exist.

| # | Workflow | Trigger | Default schedule |
|---|---|---|---|
| 1 | Order generator | Schedule | every 45s — places one order, ~15% engineered to a `.99` total (credit-refused, R42) |
| 2 | Payment robot ("the bank") | Schedule | every 2 min — pays every invoice `issued` ≥2 min ago, deterministic `paymentReference` (R48) |
| 3 | Stock replenishment | Schedule | every 5 min — tops up every product below its low-stock threshold |
| 4 | Burst | Manual webhook (`POST /webhook/otc-burst`) | fires `BURST_ORDER_COUNT` (default 20) orders at `BURST_CONCURRENCY` in parallel, on demand |

```bash
pnpm n8n:import    # ./scripts/import-n8n-workflows.sh — imports the 4 committed workflows (always INACTIVE)
pnpm n8n:export    # ./scripts/export-n8n-workflows.sh — writes n8n's own current copy back into n8n/workflows/
```

**Auto-import on startup.** The `n8n-init` one-shot container (same `restart: "no"` / `depends_on: service_healthy` shape as `kafka-init`) imports the four workflows on every `docker compose up`, gated by `N8N_WORKFLOWS_ENABLED` (`.env` — `false` skips it). Imports are always **inactive** regardless of that flag: activate a workflow from http://localhost:5678/workflows when you want its schedule/webhook to actually run — a live UI toggle takes effect immediately and survives restarts. **Scheduled** workflows (order generator, payment robot, stock replenishment) additionally need a full server restart before a *CLI-level* `publish:workflow --active=true` starts ticking — verified live: publishing `otcOrderGenerator` via the CLI produced zero executions against its own interval until `n8n` was restarted. The **webhook** workflow (burst) does not have this restriction — verified live: `publish:workflow --id=otcBurst` followed immediately by `POST /webhook/otc-burst`, no restart, returned `200` and executed. Either way, the UI toggle is the simplest path and needs no restart for either trigger type.

**Removing n8n entirely.** The `n8n` and `n8n-init` services sit behind the `n8n` compose profile — `pnpm dc:up:infra`/`dc:up:apps` pass `--profile n8n` by default (today's behaviour, unchanged); `pnpm dc:up:infra:no-n8n` / `pnpm dc:up:apps:no-n8n` omit it, so neither container starts. Every other service comes up healthy and an order placed by hand (`pnpm order:place`, or the web UI) still runs the full saga to `completed` — n8n is a client of the Gateway, exactly like the web app, and nothing waits for it.

Every tunable (`ORDER_GENERATOR_*`, `PAYMENT_ROBOT_*`, `STOCK_REPLENISH_*`, `BURST_*`, `OTC_GATEWAY_URL`) is an environment variable, documented with its default in `.env.example` — never hardcoded in the workflow JSON, including the three schedule periods and the burst webhook path, which the trigger nodes read via n8n expressions against `$env` (e.g. `secondsInterval: ={{ Number($env.ORDER_GENERATOR_INTERVAL_SECONDS) || 45 }}`). Changing one of these in `.env` takes effect after the workflow is republished and `n8n` is restarted (`docker compose restart n8n`) — same restart requirement as any other activation change on this n8n version, see above.

## End-to-end tests

Playwright drives the real, already-running web UI (never `pnpm dev:web` — see the caveat below) through both saga scenarios end to end: the happy path to `completed` with a payment that flips the invoice to `paid`, and the `.99` credit-rejection path that compensates back to `cancelled`.

```bash
# One-time: install Playwright's chromium browser binary.
pnpm --filter @otc/web exec playwright install chromium
# `--with-deps` additionally installs this browser's OS-level dependencies
# and needs sudo; plain `install chromium` is enough on a machine that
# already has a Chrome/Chromium-capable environment (true of most dev
# machines and CI images), which is why it is the documented default here.

# Run against a running stack, either the containers or a local build,
# pointed at with E2E_BASE_URL:
cd apps/web
E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e

# Or via the root aggregator (same env var, same effect):
E2E_BASE_URL=http://localhost:3010 pnpm run test:e2e
```

`test:e2e` loads `GATEWAY_OPERATOR_USERNAME`/`GATEWAY_OPERATOR_PASSWORD` from the root `.env` automatically (`dotenv -e ../../.env`), for the real login `global.setup.ts` performs before either spec runs.

To *watch* the browser drive the app, or to pass any other Playwright flag, export the root `.env` into your shell and invoke Playwright directly:

```bash
set -a; source .env; set +a          # exports GATEWAY_OPERATOR_PASSWORD et al.
E2E_BASE_URL=http://localhost:3010 pnpm --filter @otc/web exec playwright test --headed
```

Do **not** use `pnpm run test:e2e -- --headed`. `pnpm` appends `-- --headed`, but the script's `dotenv -e ../../.env --` has already consumed a `--`, so Playwright receives `--` and `--headed` as **test-name filters** rather than as an option — the run silently proceeds headless and still reports `3 passed`. Conversely `pnpm exec playwright` alone skips the `dotenv` wrapper and fails fast with `GATEWAY_OPERATOR_PASSWORD is not set`; exporting the env first is what reconciles the two.

**Each full run places two real orders and consumes two real units of `PRD-0006` stock for `ALBIONFOODS`** — this is a real system, not a fixture: nothing is cleaned up afterwards (deliberately — see `progress/review_e2e_playwright.md` §8 for why a cleanup path across four service databases is worse than the noise it would remove). Reset the stack before recording a demo (`docker compose down -v` + `pnpm seed`), not after running this suite.

The suite targets a running, built stack and **cannot run against `pnpm dev:web`** — against a Nuxt dev server the login form's click lands pre-hydration on the cold dev bundle and the subsequent navigation never completes. Point it at the containerised stack (`WEB_PORT`) or at a local production build (`pnpm build && node apps/web/.output/server/index.mjs`) instead.

## How this is being built

> **The full process guide lives at [`docs/PROCESS.md`](docs/PROCESS.md)** — the harness and SDD concepts in detail, the agent cast, the feature loop, EARS, the artifact registry, and the current status. What follows is the short version.

The development **process is a deliverable here**, not just the software. This repository carries a spec-driven agent harness, built before any application code:

| Artifact | Role |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Entry map — what to read, when, and the hard rules |
| [`CLAUDE.md`](CLAUDE.md) | Leader role + project conventions |
| [`feature_list.json`](feature_list.json) | Backlog state machine — 38 features, max one `in_progress` |
| [`init.sh`](init.sh) | State coherence check, run at the start of every session |
| [`progress/`](progress/) | External memory: session state, and per-feature **effort records** |
| [`CHECKPOINTS.md`](CHECKPOINTS.md) | Objective session-close criteria (C1–C7) |
| [`.claude/agents/`](.claude/agents/) | leader, spec_author, implementer, reviewer, test_maintainer |

Large features go through the full loop with a **human approval gate**:

```
pending → [spec_author] → spec_ready → ⏸ HUMAN → in_progress
        → [implementer] → in_review → [reviewer] → done
```

Small features skip the spec ceremony but still traverse the state machine. Every agent definition declares which model it runs on. `progress/history.md` records per-feature effort — this repository is the **baseline** the two sibling assessments are measured against.

## The specification

[`specs/shared/`](specs/shared/) is written **before** the code and is the stack-agnostic contract that assessments #8 and #9 reuse verbatim:

| File | What it defines |
|---|---|
| [`domain-model.md`](specs/shared/domain-model.md) | Aggregates, value objects, invariants, both state machines, the 13-fact catalogue |
| [`saga.md`](specs/shared/saga.md) | Happy path and both compensation paths, with sequence diagrams |
| [`requirements.md`](specs/shared/requirements.md) | 61 requirements in EARS notation, `R1`–`R61` |
| [`asyncapi.yaml`](specs/shared/asyncapi.yaml) | AsyncAPI 3.0.0 — fact topics, DLQs, every RPC subject, all payload schemas |
| [`openapi.yaml`](specs/shared/openapi.yaml) | OpenAPI 3.1.0 — the Gateway REST contract |
| [`test-matrix.md`](specs/shared/test-matrix.md) | Every `R<n>` mapped to the test that proves it |
| [`n8n-workflows.md`](specs/shared/n8n-workflows.md) | Functional spec of the four demo workflows |

Both API documents are machine-validated (`@asyncapi/parser`: 0 errors, 0 warnings; `redocly lint`: valid). A feature is not `done` until its rows in the test matrix are green.

## Build progress

| Phase | What | Status |
|-------|------|--------|
| 1 | Environment & repository | ✅ |
| 2 | Harness layer (`AGENTS.md`, `feature_list.json`, `init.sh`, `progress/`, agents) | ✅ |
| 3 | Shared spec — EARS requirements, AsyncAPI, OpenAPI, test matrix | ✅ |
| 4 | Infrastructure compose + Kafka topics & NATS subjects | ✅ |
| 5 | pnpm monorepo scaffold, shared-kernel, contracts | ✅ |
| 6 | Database entities (orders, fulfillment, billing) | ✅ |
| 7 | Deterministic seed job | ✅ |
| 8 | Orders service + saga orchestrator | ✅ |
| 9 | Fulfillment service | ✅ |
| 10 | Billing service | ✅ buyer credit, `.99` simulator, invoicing, remittance intake |
| 11 | Notifications service | ✅ port + SMTP (Mailpit)/console adapters, seven facts, durable idempotency |
| 12 | Projector service + MongoDB read model | ✅ every fact → one order timeline, idempotent, NATS update signal |
| 13 | Gateway / BFF | ✅ 18 REST paths, JWT, NATS RPC, SSE stream (reconnect-safe heartbeat), Swagger at `/docs` |
| 14 | Health checks, OTel propagation, retry + DLQ | ✅ requestId dedup, dead-letter (3 services), tracing, log correlation, metrics, health checks |
| 15 | End-to-end saga verification | ✅ happy path, `.99`/`stock_rejected` compensation, redelivery, poison-to-DLQ, composed trace — all proven against real spawned services |
| 16 | Nuxt 4 web app | ✅ auth (JWT never reaches the browser), place-order, order list, order detail with a live SSE saga timeline, billing (invoices, credits, Register payment) and stock (on-hand/reserved, delta replenish) — plus an error sweep so every failure shows the server's real reason |
| 17 | Web component tests | ✅ 59 tests / 14 files, written inside each feature loop rather than as a separate phase; SSE covered against a real `EventSource` over real HTTP. Coverage 85.8% statements, 87.0% lines |
| 18 | API tests through the Gateway | ✅ black-box over real HTTP against a real spawned Gateway + fleet (supertest as client only) — happy path, `.99` compensation, payment idempotency, and a general causal-ordering invariant asserted on every order |
| 19 | Playwright end-to-end tests | ✅ 3 scenarios in a real browser against the running stack — happy path to `completed`, `.99` compensation with the rendered causal link, invoice → `paid`. Found a real stale-page defect no lower test layer could reach |
| 20 | n8n demo workflows | ✅ four workflows (order generator, payment robot, stock replenishment, burst), Gateway REST API only, committed JSON + auto-import; removing n8n entirely verified not to break the stack |
| 21 | SonarQube + coverage gates | ✅ two-tier coverage enforced in `pnpm quality` (≥80% domain / ≥60% overall), proven to fail when violated and independent of SonarQube; SonarQube configured, run, quality gate **Passed** |
| 22 | Prometheus, Grafana, Jaeger verification | ✅ auto-provisioned Grafana dashboard (5 panels, all reading live data), kafka-exporter for real consumer lag, and one trace genuinely spanning 6 services — the linkage was broken until this phase |
| 23 | Full Docker Compose | ✅ 12 app images (6 services + web + seed + 4 migration jobs), all running non-root as uid 1000, verified healthy from a cold cycle against the live infra stack |
| 24 | Documentation + demo recording | ⬜ |
| 25 | Final checkpoint | ⬜ |

## Licence

Not yet decided.
