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
| Infrastructure | Docker Compose (~18 containers) |

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24.19.0 | `nvm use` — the version is pinned in [`.nvmrc`](.nvmrc) |
| pnpm | 11.x | via corepack: `corepack enable && corepack install -g pnpm@latest` |
| Docker + Compose | latest | required from Phase 4 onwards |

> **If you run more than one Docker daemon** (e.g. Docker Desktop *and* the system Engine), be aware that `docker` follows your active **context** while Testcontainers does not — it reads `DOCKER_HOST`, then falls back to `/var/run/docker.sock`. The integration tests can therefore run against a different daemon than your compose stack, and their disposable containers will be invisible to a plain `docker ps`. Everything still works; to watch them, point the CLI at the same socket: `DOCKER_HOST=unix:///var/run/docker.sock docker ps`.

```bash
git clone https://github.com/peelmicro/order-to-cash-nestjs.git
cd order-to-cash-nestjs
nvm use            # -> Now using node v24.19.0
cp .env.example .env
```

## Working with the monorepo

```bash
pnpm install       # all 10 workspaces
pnpm quality       # lint + typecheck + test, everywhere — the gate every feature keeps green
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

## Running the infrastructure

The application services arrive in later phases; the infrastructure stack runs now:

```bash
pnpm dc:up:infra   # 10 containers + a one-shot kafka-init job
./init.sh          # environment + backlog + spec coherence; exits 0 when healthy
```

Poke at the running stack by hand with the [`http/`](http/) files and the REST Client VS Code extension — service liveness, the NATS subjects currently answered, the domain facts on each Kafka topic, and the Prometheus/Jaeger/Grafana APIs. Business operations travel over NATS rather than HTTP until the Gateway lands, so use `pnpm order:place` / `pnpm order:over-limit` / `pnpm saga:watch` to drive and watch the saga in the meantime.

| UI | URL |
|---|---|
| Redpanda Console (Kafka topics + DLQs) | http://localhost:8080 |
| Jaeger (traces) | http://localhost:16686 |
| Grafana | http://localhost:3030 |
| Prometheus | http://localhost:9090 |
| n8n | http://localhost:5678 |
| SonarQube (optional) | http://localhost:9000 — `pnpm dc:up:sonar` |

Every image is **pinned to an exact version** (MySQL 8.4.11 LTS, MongoDB 8.3.8, Kafka 4.3.1 KRaft, NATS 2.14.5 **core-only — no JetStream**, Jaeger v2 2.20.0, Prometheus v3.14.0, Grafana 13.2.0, n8n 2.36.2) so the sibling assessments reproduce the same stack. The `kafka-init` one-shot container **derives the six topics (3 fact topics + 3 `.dlq`) from [`specs/shared/asyncapi.yaml`](specs/shared/asyncapi.yaml)** — the spec is the source of truth, and topic drift fails loudly instead of passing silently. Re-run it any time with `pnpm kafka:topics`.

With the infrastructure up, `pnpm seed` loads the demo data: master data (3 currencies, 12 products, 7 retailers and 22 suppliers with valid GS1 GLNs, credit limits, stock) plus six sample orders — five completed sagas and one cancelled by the `.99` credit rule — consistent across the three MySQL databases and the MongoDB `order_timeline`. Deterministic and idempotent: run it twice, nothing changes.

> **Deviation from the task document:** MongoDB is 8.3.8 rather than the mandated 7.x — version 7 was current when the task was written; nothing in the specification depends on 7-only behaviour, and the deviation is deliberate.

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
| 10 | Billing service | 🚧 buyer credit done; simulator, invoicing, remittances pending |
| 11 | Notifications service | ⬜ |
| 12 | Projector service + MongoDB read model | ⬜ |
| 13 | Gateway / BFF | ⬜ |
| 14 | Health checks, OTel propagation, retry + DLQ | ⬜ |
| 15 | End-to-end saga verification | ⬜ |
| 16 | Nuxt 4 web app | ⬜ |
| 17 | Web component tests | ⬜ |
| 18 | API tests through the Gateway | ⬜ |
| 19 | Playwright end-to-end tests | ⬜ |
| 20 | n8n demo workflows | ⬜ |
| 21 | SonarQube + coverage gates | ⬜ |
| 22 | Prometheus, Grafana, Jaeger verification | ⬜ |
| 23 | Full Docker Compose | ⬜ |
| 24 | Documentation + demo recording | ⬜ |
| 25 | Final checkpoint | ⬜ |

## Licence

Not yet decided.
