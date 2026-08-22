# Current session

> Working memory for the **active** session. Written *while* working, not at the
> end. On session close, move the summary into `progress/history.md` (with the
> effort record) and reset this file to the template below.

**Feature:** — none active —
**Status:** idle — `fulfillment_stock` (17) done on the second review pass; next `fulfillment_despatch` (18)
**Session started:** —

## Goal

Phase 9 — Fulfillment, the first service that answers. `fulfillment_stock` (17, sdd:true): StockItem aggregate (reservedUnits ≤ units), reservation lifecycle, the NATS responders (`stock.check`, `stock.reserve` → StockReserved|StockRejected, `stock.release` compensation, `stock.list`, `stock.replenish`), outbox + idempotent consumer copy. Then `fulfillment_despatch` (18). When 17's responder boots against compose, the three orders parked in `saga_commands` since feature 16 resume unattended — the first cross-service saga execution.

## Decisions taken this session

- **DI-metadata divergence — leader-level, must land before feature 16.** `tsconfig.base.json` sets `emitDecoratorMetadata: true`, so `pnpm build` (tsc) emits `design:paramtypes` — but all six services' `dev` script is `tsx watch`, and esbuild does not implement it. The same source therefore behaves differently under `pnpm dev:*` and `pnpm start`, and Vitest catches neither (specs use `new` or `useValue`). Blast radius today is nil (only two decorator-injected classes exist, both already using `@Inject`), but feature 16 is the first `@nestjs/cqrs` graph where bare-type constructor injection is the idiom. Fixing at source (dev script) + convention + lint guard, folded into this feature's fix pass.

- **Gate on `specs/outbox_and_idempotency/`**: all 26 open points accepted as written. Two given conscious approval: row 5 (add `trace_parent` now rather than migrate three DBs twice) and **row 11, which reverses feature 13's ruling** — the Drizzle adapter lands in feature 14, not 15, because `save()` is then written once together with its transaction and outbox. Amendment: a parity guard (`OI12`) for the five per-service copies of the idempotent-consumer pattern, mirroring row 20's byte-identity test for the three outbox schemas — duplication guarded by a check, not by discipline.
- Both Phase-6 advisories resolved: `causation_id char(36) NOT NULL` in all three outbox tables (one coordinated migration), and `seq bigint AUTO_INCREMENT` as the sole poll ordering key (a timestamp is the wrong tool for a total order; `DATETIME(3)` narrows ties without closing them).
- Note: this feature **recreates the databases** (`down -v` → up → migrate → seed) — `ADD COLUMN NOT NULL` cannot apply over existing rows and seeded causation cannot be derived in SQL.

- **Human gate on `specs/orders_aggregate/`**: 16 open points reviewed, 14 accepted as written, 2 amended — (a) the `order_items.description` migration pulled INTO this feature rather than deferred to 15, so the schema stops contradicting the domain model; (b) the missing `@otc/*` workspace deps fixed in all three apps (orders, billing, fulfillment), not just orders, with a clean-clone proof task. Plus OA4 (reason↔status pairing) and OA1 (single-currency invariant) recorded as **promotion candidates** for `specs/shared/` at feature 38 — without promotion, #8/#9 would not enforce them.
- Root cause note: 2 of the 16 open points were genuine earlier-phase defects (the missing column traces to the plan document's table shape, implemented faithfully in phase 6; the missing workspace deps are a phase-5 scaffold defect the reviewer missed because they were latent). The rest are the normal stack-agnostic-spec → implementation gap.

- **`seed_job` implemented and moved to `in_review`.** `apps/seed` (plain
  Node/TS, not NestJS) reuses each of `@otc/orders`/`@otc/fulfillment`/
  `@otc/billing`'s own Drizzle client/db-config/migrator/schema modules via
  relative imports (never a shelled-out subprocess), plus the official
  `mongodb` driver for the read model. Data definitions
  (`src/data/*.data.ts`) are kept separate from the per-store writers
  (`src/writers/*.writer.ts`) so #8/#9 can port the DATA. Full report:
  `progress/impl_seed_job.md`.
- Deterministic ids are SHA-256-derived UUID-v4-*shaped* strings (not real
  v4 randomness) so `UniqueId.from()` accepts them while remaining a pure
  function of a stable namespace string — re-running the seed is
  byte-identical (verified live: same row-count summary and same
  `MD5(GROUP_CONCAT(orders.id))` checksum across two `pnpm seed` runs
  against the compose stack).
- `apps/seed`'s `tsconfig.json` deliberately has NO `rootDir` (unlike every
  other app) — its `include` list reaches into `apps/orders`,
  `apps/fulfillment` and `apps/billing`'s persistence modules by design, and
  an explicit `rootDir: "src"` would make `tsc` reject those cross-app
  files with TS6059. No `build`/`start` script either — `pnpm seed` runs
  directly via `tsx`, same as every other app's `dev` script.
- Added `mongodb` + `@testcontainers/mongodb` to the pnpm catalog and
  `MONGO_HOST` / `MONGO_DB_READMODEL` to `.env.example`/`.env` — the first
  Mongo client config in the repo (apps/projector is still a scaffold).

- **TS verdict: fallback to 5.9.3.** TS7 passed NestJS DI + Vitest but vue-tsc@3.3.10
  cannot load typescript@7 (`ERR_PACKAGE_PATH_NOT_EXPORTED`, reproduced
  independently by the reviewer) — the agreed fallback rule fired. TS7 goes in
  the README's "what I would do differently".
- **TypeScript 7** originally chosen by Juan Pablo (over the leader's 5.x recommendation),
  structured as a timeboxed validation spike inside `monorepo_scaffold` with an
  explicit fallback: if NestJS 11 decorators/`emitDecoratorMetadata`,
  `@nestjs/cli`, Vitest or Nuxt 4 cannot be made to work under TS 7 within the
  timebox, pin `typescript@^5.9` and record TS 7 under "what I would do
  differently". Either outcome is documented with evidence.

## Blockers

None.

## Notes

- **Seed data-coherence defect, owed by feature 18's live-boot pass (reviewer ruling, feature 17):** `apps/seed` stocks only 5 of its 22 companies, and its own demo orders ORD-000007/8/9 target the unstocked `ALBIONFOODS` — so those three park on `NOT_FOUND` rather than reserving. Not a feature-17 defect (the park is the designed negative path, observed live), but it must be fixed no later than feature 28 (`saga_e2e_verification`); the natural slot is 18's live boot.

- **`fulfillment_stock` (17) implementer pass, done.** All of A–I in `specs/fulfillment_stock/tasks.md` ticked; `pnpm quality`/`./init.sh` green; 11 integration files / 36 tests green (Testcontainers MySQL+Kafka+NATS); domain coverage 93.63%. Live boot found a genuine `apps/seed` data gap (only 5 of ~22 seeded companies have a Fulfillment `stock` row — `ALBIONFOODS`, the three originally-parked demo orders' company, is not one of them) that happens to collide with design.md §3.3's own documented "no carrier — NOT_FOUND, park for a human" edge case; a freshly-placed order against a seeded company (`IBERFOODS`/`PRD-0001`) reached `stock_reserved` + parked `credit.hold` unattended, confirming the designed happy path. Also reproduced live: `orders.create`'s Nest-packet reply shape (unlike Fulfillment's five bare-JSON responders) — a raw bare-JSON client times out even though the order is placed, exactly as design.md §6.3 predicted; feature 25's hand-over. Full report: `progress/impl_fulfillment_stock.md`.

- **Testing pattern for features 17–22 (reviewer ruling, third pass on feature 16):** saga integration tests synchronise only on terminal or monotonic evidence (a `saga_commands`/outbox status that never regresses, an append-only request log) — never on a transient live column the correct saga can pass through faster than one poll interval. Polling a state the system is supposed to leave is a race by construction.

- **Binding advisories inherited by feature 17 (from review_order_saga_orchestrator):** D1 — a distinct-eventId duplicate of a fact whose precondition still holds (e.g. a second `credit.rejected.v1` while `stock.release` is parked) hits `uq_saga_commands_order_command` and crash-loops the consumer on that offset (reproduced); fix = idempotent `enqueue` on `(order_id, command)`, must land before R16/DLQ is claimed at feature 27 — **feature 17's implementer fixes it first** since 17 is the first real responder that will produce such facts. D2 — dispatcher uses `Date.now()` not the `Clock` port (why no integration test runs the real sweeper service). D3 — R26's integration test asserts the wire, not the durable row. D6 — three interface-typed `@Optional()` params evade the DI guard. D4 — `0002_snapshot.json.prevId` still points at the feature-14 orphan; fix at the next Orders migration. D5 — consumer group is actually `orders.saga-server` (Nest appends `-server`); document or rename at feature 27.
- **Transport-binding convention (leader, landing now):** every `@MessagePattern`/`@EventPattern` must name its `Transport` — bare decorators bind to every connected transport, and a NATS-only pattern registered on Kafka crashes a hybrid app at boot (found live in feature 16; invisible to single-transport TestingModules). CLAUDE.md non-negotiable + ESLint guard.

- **Parked advisories with owners** (from review_orders_acceptance second pass): N3 — the DI ESLint guard only matches `TSParameterProperty`, so a manually-assigned bare-typed parameter evades it; leader tightens the selector **before feature 16** (the first @nestjs/cqrs graph). N4 — the `test-support` build exclude landed only in apps/orders; features 17/19 replicate it when siblings gain test-support dirs. N2 — nothing guards `emitDecoratorMetadata`/the six dev scripts against reversion; a config-guard spec dispatched to test_maintainer alongside N1/N5.
- **Leader lesson, third occurrence**: current.md must be updated at every status transition. The reviewer has now failed C2 on this three times. New personal rule: the same edit that changes feature_list.json changes current.md — one block, never two steps.

- **Process deviation (2026-08-20):** the `seed_job` review was run with an explicit `model: sonnet` override instead of the reviewer's unpinned default — the inherited-model run was blocked twice by an API-side safeguard flag (`reasoning_extraction`) before producing any output. One-off, not a change to the agent definition; revisit only if it recurs.

- **Leader lesson (D2, twice):** `progress/current.md` must be updated at every
  feature status transition, not at session close. The reviewer checks C2 on
  every pass; keep current.md in lockstep with `feature_list.json` — update both
  in the same breath.

---

## Template (reset to this on session close)

```markdown
# Current session

**Feature:** `<name>` (id <n>, phase <n>)
**Status:** <status>
**Session started:** <date>

## Goal

## Decisions taken this session

## Blockers

## Notes
```
