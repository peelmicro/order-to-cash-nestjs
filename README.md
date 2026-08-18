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

```bash
git clone https://github.com/peelmicro/order-to-cash-nestjs.git
cd order-to-cash-nestjs
nvm use          # -> Now using node v24.19.0
node -v && pnpm -v
```

There is nothing to install or run yet — the monorepo is scaffolded in Phase 5.
What you *can* run is the harness state check:

```bash
./init.sh          # environment + backlog + spec coherence; exits 0 when healthy
```

## How this is being built

The development **process is a deliverable here**, not just the software. This
repository carries a spec-driven agent harness, built before any application code:

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

Small features skip the spec ceremony but still traverse the state machine.
Every agent definition declares which model it runs on. `progress/history.md`
records per-feature effort — this repository is the **baseline** the two sibling
assessments are measured against.

## Build progress

| Phase | What | Status |
|-------|------|--------|
| 1 | Environment & repository | ✅ |
| 2 | Harness layer (`AGENTS.md`, `feature_list.json`, `init.sh`, `progress/`, agents) | ✅ |
| 3 | Shared spec — EARS requirements, AsyncAPI, OpenAPI, test matrix | ⬜ |
| 4 | Infrastructure compose + Kafka topics & NATS subjects | ⬜ |
| 5 | pnpm monorepo scaffold, shared-kernel, contracts | ⬜ |
| 6 | Database entities (orders, fulfillment, billing) | ⬜ |
| 7 | Deterministic seed job | ⬜ |
| 8 | Orders service + saga orchestrator | ⬜ |
| 9 | Fulfillment service | ⬜ |
| 10 | Billing service | ⬜ |
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
