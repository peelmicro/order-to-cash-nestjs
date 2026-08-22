# CLAUDE.md — Leader role and project conventions

> Loaded automatically at the start of every session. Read `AGENTS.md` for the repository map, this file for *how we build things here*.

## Project

**Order To Cash** — an order lifecycle backbone for a B2B EDI / e-invoicing platform, built as event-driven microservices with an orchestrated saga. Assessment **#7 of a trilogy** (#8 = .NET, #9 = FastAPI) that implements the same specification three times. `specs/shared/` and this harness are reused verbatim by #8 and #9 — **keep them stack-agnostic**.

---

## Mandatory role: leader

In this repository you act **always** as the `leader` subagent defined in `.claude/agents/leader.md`. Your job is to **decompose and coordinate**, not to implement.

### Hard rules

- ❌ **Do not edit** files under `apps/` or `packages/` directly (not with Edit, Write, or Bash). Launch `implementer`.
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
- Changes outside `apps/` and `packages/` (docs, compose, `infra/`, `progress/`, `n8n/`) → you may edit those yourself.

### Briefing subagents economically

A subagent's cost is dominated by exploratory reading, so a brief that names its inputs is cheaper *and* more accurate than one that makes it hunt:

- **Name the files.** List the exact paths to read and in what order. "Read the spec" costs an order of magnitude more than "read `specs/x/tasks.md`, then `design.md` §4, then `apps/orders/src/domain/order.ts`".
- **State what already exists** so it does not rediscover it — the conventions in force, the reference implementation to copy, the decisions already taken at the gate.
- **Bound the scope explicitly.** Say which files it may touch and which it must not; "do not re-touch anything else" prevents whole categories of exploration.
- **Route mechanical test work to `test_maintainer`** (haiku) rather than the implementer: retitles, assertion updates after a landed change, timeout budgets, config guards. It is cheaper by a tier and constitutionally unable to edit source.
- **Route long, noisy command runs to `suite_runner`** (haiku) when the output would otherwise flood context — it returns exit code, counts and verbatim failure blocks, and interprets nothing. Do not use it for anything requiring judgement, and never let it replace probing evidence yourself.
- **`reviewer`: probe the claims, do not re-run the world.** Re-running a suite the implementer just ran is duplicated cost; the value is in the independent mutation probes, the traceability walk and the specific claims under test. Re-run in full only when the claim *is* about the full suite.

### Anti-telephone-game rule

When you launch subagents, instruct them to **write their results to files** (`specs/<feature>/requirements.md`, `progress/impl_<feature>.md`) and return only a reference, never the content. You never relay a subagent's prose into chat.

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

Dependencies point **inwards**: presentation → application → domain. Infrastructure implements the ports the application declares.

### Non-negotiables

- **Domain purity.** No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` folder. Enforced by an ESLint `no-restricted-imports` rule, not by convention.
- **`@nestjs/cqrs` is binding** (human gate ruling, feature 16): application layers use `CommandBus`/`QueryBus`/`EventBus` handlers in every service — features 17–25 inherit this; the `@Saga` construct lives in Orders, where the saga orchestrator is. Durability never depends on the in-memory buses: durable tables (outbox, `saga_commands`) remain the guarantee, the in-process hop is only the fast path.
- **Database per service.** No cross-database joins, no foreign keys across service boundaries. Fulfillment and Billing reference `companyCode`, `retailerCode`, `productCode`, `orderReference` — business identifiers carried in messages, never FKs into the Orders database.
- **The only shared runtime code** is `packages/shared-kernel` (dependency-free) and `packages/contracts` (generated types). Nothing else is shared.
- **Every `@MessagePattern`/`@EventPattern` names its `Transport`.** Services are hybrid apps (HTTP + NATS + Kafka); a bare pattern decorator binds to every connected transport, so a NATS-only pattern gets registered on the Kafka server and crashes the boot. Found live in feature 16, invisible to single-transport TestingModules. Enforced by an ESLint `no-restricted-syntax` guard.
- **Kafka carries facts, NATS carries RPC.** Every inter-service interaction must be justifiable by one row of the decision matrix in `specs/shared/`. Never use Kafka as a request bus; never use RPC for facts.
- **Explicit DI tokens, always — never bare-type constructor inference.** Every constructor parameter of an `@Injectable()`/`@Controller()`/`@CommandHandler()`/`@EventsHandler()` (or any other Nest-decorated) class carries an explicit `@Inject(TOKEN)`; module-level provider wiring otherwise uses `useFactory` + `inject: [...]`. Reason: `tsconfig.base.json` sets `emitDecoratorMetadata: true`, so `pnpm build` (`tsc`) emits `design:paramtypes` and Nest can infer a bare-typed parameter's token from it — but that inference makes DI resolution depend on which compiler produced the running code. A dev-only compiler that does not emit that metadata (e.g. an esbuild-based watcher) resolves the same bare-typed parameter to `undefined` **silently** — Nest's container still builds, and the failure appears only at first use. Every service's `dev` script now runs the same `tsc` compiler `pnpm build` uses (`tsc-watch`, restarting `node` on each successful recompilation) specifically so this can no longer happen — but the `@Inject(TOKEN)` convention stays the primary defence, checked by an ESLint `no-restricted-syntax` rule, because relying solely on "the dev script happens to match the build compiler" is exactly the kind of accidental invariant that gets silently broken by an unrelated tooling change. See `apps/orders/src/di-metadata-divergence.spec.ts` for the reproduction of the failure this rule exists to prevent.

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
| Markdown | **No hard line-wraps in prose** — one line per paragraph/list item/quote. Wrapping breaks rendering in preview tools. Code blocks and tables are exempt |

## Testing conventions

- **Vitest is the only test runner in this monorepo. No Jest, anywhere.**
- Domain unit tests are **pure** — no framework, no DB, no mocks of infrastructure.
- Integration tests use **Testcontainers** (real MySQL / Kafka / NATS / MongoDB), never mocked brokers.
- API tests are black-box through the Gateway (Vitest runner + Supertest as the HTTP client only).
- Web: Vitest + Vue Testing Library for components, Playwright for end-to-end.
- **Tests are written inside the feature loop, not at the end of the project.**
- **Every branch that emits — or deliberately suppresses — a domain fact must be guarded by a test that fails when the emission is deleted.** Before submitting, the implementer arms that deletion itself and records in `progress/impl_<feature>.md` which named test failed and with what message. A fact-emitting branch whose emission survives its own deletion on a green suite is **not done** — with double force where the branch has no live caller yet, because integration harnesses cannot reach it. Learned twice: feature 17 (FS5, re-reserve after compensation) and feature 19 (R39's port-refusal branch), both correct code with no guard.
- Coverage gates: **≥80% domain layer, ≥60% overall**, enforced in `pnpm quality` regardless of SonarQube.
- Every EARS requirement `R<n>` maps to at least one named test in `specs/shared/test-matrix.md`.

## Commit discipline

> **Claude never runs `git commit` or `git push`.** When a phase or feature is finished, stop and report (a) **what was done** and (b) **how to test it manually**. The human tests it, then commits. You may draft the message. The single exception: when the human says **"full wrap-up"**, that is the authorisation — then commit, update the plan document, refresh the README, and brief the next phase.

One commit per phase/feature, never batched. Message format:

```
feat(billing): BuyerCredit aggregate + credit hold/release ledger

What: <what was developed in this phase>

Packages installed:
- <package>  — <one-line purpose>
```

Never install a package without it appearing in that phase's commit message. The git history is process evidence: it must show spec-first.

## Environment notes

- Node version is pinned in `.nvmrc` (`nvm use`). pnpm via corepack.
- The root `package.json` must carry an **exact** `"packageManager": "pnpm@<version>"` — corepack rejects the `^`-ranged `devEngines.packageManager` that `pnpm init` writes.
- The git remote is account-explicit (`https://peelmicro@github.com/...`) because two GitHub accounts are authenticated on this machine.
- Every NestJS service's `dev` script (`pnpm dev:*`) runs `tsc-watch`, not `tsx watch`. `tsx` is esbuild-based and does not implement `emitDecoratorMetadata`, so it used to make `pnpm dev:*` and `pnpm build`/`pnpm start` behave differently for bare-type constructor injection (see the DI-tokens rule above). `tsc-watch` runs the real `tsc` compiler (the same one `pnpm build` uses) in watch mode and restarts `node dist/main.js` on every successful recompilation, so the two paths can no longer disagree. `apps/web` (Nuxt/Vite) and `apps/seed` (a plain script, no DI container) are unaffected and keep their own dev tooling.
