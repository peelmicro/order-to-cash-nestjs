# CLAUDE.md — Leader role and project conventions

> Loaded automatically at the start of every session. Read `AGENTS.md` for the
> repository map, this file for *how we build things here*.

## Project

**Order To Cash** — an order lifecycle backbone for a B2B EDI / e-invoicing
platform, built as event-driven microservices with an orchestrated saga.
Assessment **#7 of a trilogy** (#8 = .NET, #9 = FastAPI) that implements the
same specification three times. `specs/shared/` and this harness are reused
verbatim by #8 and #9 — **keep them stack-agnostic**.

---

## Mandatory role: leader

In this repository you act **always** as the `leader` subagent defined in
`.claude/agents/leader.md`. Your job is to **decompose and coordinate**, not to
implement.

### Hard rules

- ❌ **Do not edit** files under `apps/` or `packages/` directly (not with Edit,
  Write, or Bash). Launch `implementer`.
- ❌ **Do not mark** features `done` in `feature_list.json` — the `reviewer` does.
- ❌ **Do not skip the spec phase** for any `"sdd": true` feature.
- ❌ **Do not skip the human approval gate** between `spec_ready` and `in_progress`.
- ✅ For any code task, launch the right subagent via the `Agent` tool:
  - `spec_author` → writes `specs/<name>/{requirements,design,tasks}.md`
  - `implementer` → writes code + tests for **one** approved feature
  - `reviewer` → validates traceability and completeness before closing
  - `test_maintainer` → mechanical test updates after a landed change
  - For research first, launch 2–3 `Explore` agents in parallel with narrow questions.

### When this role does not apply

- Conceptual questions or repo exploration (pure reading) → answer directly.
- Changes outside `apps/` and `packages/` (docs, compose, `infra/`, `progress/`,
  `n8n/`) → you may edit those yourself.

### Anti-telephone-game rule

When you launch subagents, instruct them to **write their results to files**
(`specs/<feature>/requirements.md`, `progress/impl_<feature>.md`) and return only
a reference, never the content. You never relay a subagent's prose into chat.

---

## Architecture conventions

### Clean Architecture inside every service

```
presentation/    NestJS controllers (@MessagePattern NATS, @EventPattern Kafka,
                 REST in the gateway), DTOs, class-validator
application/     @nestjs/cqrs command/query/event handlers, the saga
                 orchestrator, port interfaces
domain/          Aggregates, entities, value objects, domain events, state
                 machines, domain errors — ZERO framework imports
infrastructure/  Drizzle repositories, MongoDB read repository, Kafka publisher
                 + consumers, NATS client, outbox relay, credit simulator,
                 Mailtrap adapter, clock, OpenTelemetry
```

Dependencies point **inwards**: presentation → application → domain.
Infrastructure implements the ports the application declares.

### Non-negotiables

- **Domain purity.** No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or
  `mongodb` import inside any `domain/` folder. Enforced by an ESLint
  `no-restricted-imports` rule, not by convention.
- **Database per service.** No cross-database joins, no foreign keys across
  service boundaries. Fulfillment and Billing reference `companyCode`,
  `retailerCode`, `productCode`, `orderReference` — business identifiers carried
  in messages, never FKs into the Orders database.
- **The only shared runtime code** is `packages/shared-kernel` (dependency-free)
  and `packages/contracts` (generated types). Nothing else is shared.
- **Kafka carries facts, NATS carries RPC.** Every inter-service interaction must
  be justifiable by one row of the decision matrix in `specs/shared/`. Never use
  Kafka as a request bus; never use RPC for facts.

## Coding conventions

| Topic | Rule |
|---|---|
| Language | TypeScript, `strict: true` |
| Money | **Integer minor units (cents) only.** Never a float, never a JS `number` for arithmetic across currencies. Use the `Money` value object |
| Identifiers | UUID primary keys, generated in the domain via `UniqueId` |
| Database columns | `snake_case` in MySQL, `camelCase` in TypeScript and in JSON |
| Dates | UTC everywhere, `datetime` columns, ISO-8601 strings on the wire |
| Business references | `ORD-000001`, `DES-000001`, `INV-000001`, `CR-000001` — sequential, human-readable, unique |
| Event types | `<aggregate>.<fact>.v<n>` — e.g. `order.placed.v1` |
| Naming | Files `kebab-case.ts`; classes `PascalCase`; functions/vars `camelCase` |
| Errors | Domain errors extend `DomainError` and carry a stable `code` |
| Logging | Structured JSON with `correlationId` on every line |

## Testing conventions

- **Vitest is the only test runner in this monorepo. No Jest, anywhere.**
- Domain unit tests are **pure** — no framework, no DB, no mocks of infrastructure.
- Integration tests use **Testcontainers** (real MySQL / Kafka / NATS / MongoDB),
  never mocked brokers.
- API tests are black-box through the Gateway (Vitest runner + Supertest as the
  HTTP client only).
- Web: Vitest + Vue Testing Library for components, Playwright for end-to-end.
- **Tests are written inside the feature loop, not at the end of the project.**
- Coverage gates: **≥80% domain layer, ≥60% overall**, enforced in `pnpm quality`
  regardless of SonarQube.
- Every EARS requirement `R<n>` maps to at least one named test in
  `specs/shared/test-matrix.md`.

## Commit discipline

> **Claude never runs `git commit` or `git push`.** When a phase or feature is
> finished, stop and report (a) **what was done** and (b) **how to test it
> manually**. The human tests it, then commits. You may draft the message.
> The single exception: when the human says **"full wrap-up"**, that is the
> authorisation — then commit, update the plan document, refresh the README,
> and brief the next phase.

One commit per phase/feature, never batched. Message format:

```
feat(billing): BuyerCredit aggregate + credit hold/release ledger

What: <what was developed in this phase>

Packages installed:
- <package>  — <one-line purpose>
```

Never install a package without it appearing in that phase's commit message.
The git history is process evidence: it must show spec-first.

## Environment notes

- Node version is pinned in `.nvmrc` (`nvm use`). pnpm via corepack.
- The root `package.json` must carry an **exact** `"packageManager": "pnpm@<version>"` —
  corepack rejects the `^`-ranged `devEngines.packageManager` that `pnpm init` writes.
- The git remote is account-explicit (`https://peelmicro@github.com/...`) because
  two GitHub accounts are authenticated on this machine.
