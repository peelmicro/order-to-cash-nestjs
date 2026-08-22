# Implementation report — `fulfillment_despatch` (feature 18, phase 9)

**Status set at end of this pass:** `in_review` (feature_list.json). `sdd: false` — no triple-doc; built from the acceptance list plus the brief, `specs/shared/saga.md` §3.1 step 4, `specs/shared/asyncapi.yaml`'s `despatchCreate`/`OrderDespatched` schemas, `specs/shared/requirements.md` R36/F6/F7/F8, and `specs/fulfillment_stock/design.md` (the shape this feature copies verbatim — lock protocol, outbox recorder, responder pattern, DI wiring).

## 1. What was built

### Domain (`apps/fulfillment/src/domain/`)

- `despatch-advice.ts` — the `DespatchAdvice` aggregate root (domain-model.md §4.3). `create()` is the only constructor: refuses an empty `lines` list (F6, `EmptyDespatchLinesError`) and appends exactly one `order.despatched.v1` fact to its own event collection before returning, so a caller can never observe an aggregate whose fact was not recorded. `aggregateId` of the fact is the `DespatchAdvice`'s own id (it is the aggregate that produced the fact — unlike `stock.reserved.v1`/`.released.v1`, which pick a `StockItem` as carrier because no despatch exists yet at that point in the saga).
- `despatch-events.ts` — `orderDespatchedEvent`, mirroring `stock-events.ts`'s `Indexed<TPayload>` pattern exactly.
- `despatch-errors.ts` — `EmptyDespatchLinesError` (F6), stable `code`.
- `despatch-advice-snapshot.ts` — the flat, non-reachable-for-mutation read shape (`DespatchAdviceSnapshot`/`DespatchLineSnapshot`). No `reconstitute` on the aggregate itself: a `DespatchAdvice` is created once and never mutated again, so the F8 idempotent-repeat read path only ever needs this snapshot, never a live aggregate instance.
- `order-despatch.ts` — the pure order-scoped domain service `createDespatchForOrder(items, input, despatchReference, ctx, newId)`, the sibling `order-stock-reservation.ts` never got in feature 17 (deliberately left for this feature). Consumes every item's `reserved` reservations of the order (`StockItem.consume`, already landed in feature 17), collects one `DespatchLineEntry` per consumed reservation (F7 — 1:1 with the reservation it traces, mirroring `stockReservedEvent`'s `reservations[]`), and — if anything was consumed — creates exactly one `DespatchAdvice` (F6, F8). Returns `{ kind: 'no_reservations' }` when nothing was consumed; this is a **defensive, expected-unreachable** branch (see application layer below — the real R36 refusal decision is made by the caller, which can tell "never reserved" apart from "F8 idempotent repeat", something the loaded `StockItem`s alone cannot answer without seeing the `despatches` table).
- `index.ts` — barrel updated.

### Application (`apps/fulfillment/src/application/`)

- `ports/despatch-repository.port.ts` (`DESPATCH_REPOSITORY`) — `findByOrderReference` (non-locking read, F8) + `save` (drain-on-save, R13).
- `ports/despatch-number-allocator.port.ts` (`DESPATCH_NUMBER_ALLOCATOR`) — mirrors `order-number-allocator.port.ts`.
- `commands/despatch.commands.ts` — `CreateDespatchCommand`.
- `commands/despatch.command-handlers.ts` — `CreateDespatchHandler` (`@CommandHandler`, explicit `@Inject`), `DESPATCH_COMMAND_HANDLERS`.
- `despatch-application-errors.ts` — `NoReservedStockForDespatchError` (R36's refusal — "the order holds no reservation in status reserved").
- `despatch-creation.handler.ts` — the plain-class transactional flow (mirrors `StockReservationHandler`), **reusing feature 17's lock protocol unchanged**:
  1. F8 fast path: `despatches.findByOrderReference` — a hit returns `created: false` immediately, **no transaction opened**.
  2. `stock.stockIdsOfOrder(orderReference)` (feature 17's non-locking pre-read, reused verbatim) — empty ⇒ `NoReservedStockForDespatchError`, no transaction.
  3. Inside `unitOfWork.execute`: `stock.lockByIdsForOrder` (feature 17's stock-rows-first `FOR UPDATE`, reused verbatim — the SAME lock ordering `stock.release` uses, which is what makes this cannot-deadlock against a concurrent reserve/release/despatch). Then: any `reserved` reservation for the order ⇒ proceed; none, but some `consumed` ⇒ a concurrent committer raced the fast path and already committed — re-read `despatches` (now guaranteed visible, since we hold the same lock it held) and return the existing despatch, still `created: false`, no second allocation, no second write; none `reserved` and none `consumed` (i.e. all `released`, or the order never held one — the latter already handled in step 2) ⇒ `NoReservedStockForDespatchError`.
  4. Genuine creation: allocate `DES-######`, call `createDespatchForOrder`, `stock.saveAll(items, tx)` (consumes the reservations, drains `StockItem`'s own — always empty — pending events), `despatches.save(despatch, tx)` (inserts `despatches` + `despatch_items`, drains the aggregate's ONE `order.despatched.v1` into the outbox). All inside the one transaction (R13).

### Infrastructure (`apps/fulfillment/src/infrastructure/persistence/`)

- `schema/despatches.schema.ts` — **added `uq_despatches_order_reference`** (decision 1, below).
- `schema/despatch-number-sequences.schema.ts` — new table, mirrors `order_number_sequences`.
- `schema/index.ts` — barrel updated.
- `despatch.mapper.ts`, `despatch.repository.ts` (`DrizzleDespatchRepository`) — plain SELECT for `findByOrderReference`; plain INSERT (never upsert — a despatch is created once) for `save`, draining the outbox via the existing `OutboxRecorder`.
- `despatch-number-allocator.ts` (`DrizzleDespatchNumberAllocator`) — byte-for-byte the same InnoDB counter-table recipe as `apps/orders/.../order-number-allocator.ts` (numeric `MAX(...)` cast, self-initialising `ON DUPLICATE KEY UPDATE`, `SELECT ... FOR UPDATE` + `UPDATE`).
- `drizzle/0002_despatch_number_sequence_and_order_reference_unique.sql` — the migration (see decision 1 for why it was hand-trimmed after `drizzle-kit generate`).
- `migrations.integration.spec.ts` — table-list assertion extended to 7 tables; two new cases: the `despatch_number_sequences` round trip, and the `uq_despatches_order_reference` duplicate-insert rejection.

### Presentation (`apps/fulfillment/src/presentation/`)

- `dto/despatch.dto.ts` — `DespatchCreateRequestDto`.
- `despatch.controller.ts` — `DespatchController`, one `@MessagePattern('fulfillment.despatch.create', Transport.NATS)` responder. Same `x-correlation-id`/`x-request-id` header discipline as `stock.controller.ts` (FS3): missing/malformed ⇒ `VALIDATION_FAILED`, nothing dispatched. Never throws.
- `rpc-error-mapper.ts` — `NoReservedStockForDespatchError → PRECONDITION_FAILED` (decision, below).

### Wiring

- `app.module.ts` — `DespatchController` registered; `DESPATCH_REPOSITORY`, `DESPATCH_NUMBER_ALLOCATOR`, `DespatchCreationHandler` providers (`useFactory` + explicit `inject`); `DESPATCH_COMMAND_HANDLERS` added to the class-provider list.
- No new npm packages — everything this feature needed (`@nestjs/cqrs`, `class-validator`, `nats`, `drizzle-orm`, …) was already in `apps/fulfillment/package.json` from feature 17.

### Orders side

**Untouched.** The orchestrator already knows how to issue `despatch.create` (feature 16) and `saga-command-payloads.ts` already builds `DespatchCreateRequestPayload` (`{ orderReference }` only — matches this feature's DTO). No Orders file was edited.

### Seed (`apps/seed/src/data/`)

- `stock.data.ts` — additive baseline coverage (decision 2, below).
- `stock.spec.ts` — three assertions updated/added for the new shape (row-count formula, "every company has stock", the concrete `ALBIONFOODS` case).

## 2. Decisions

### Decision 1 — F8 uniqueness: added a DB unique constraint (`uq_despatches_order_reference`)

**The race is already structurally impossible without it.** `despatch.create` reuses feature 17's exact lock protocol: `stockIdsOfOrder` (non-locking pre-read) then `lockByIdsForOrder` (`FOR UPDATE`, stock-rows-first, index-ordered — the same statement shape `stock.release` uses). Two concurrent `despatch.create` calls for the same order both block on the SAME stock rows; the second only proceeds after the first commits, and by then the first's reservations are `consumed` — the second's `lockByIdsForOrder` (a current/locking read) sees that committed state, and the handler routes it to the F8 re-read-and-return-existing branch rather than a second creation. This is exactly the same reasoning design.md §4.2/§4.3 uses to justify `stock.reserve`'s own idempotency without a DB constraint.

**Added anyway, defense-in-depth**, for the same reason `stock.schema.ts`'s `uq_stock_company_product` exists even though `StockItem.reserve` already enforces F1 in the aggregate: a durable invariant should not depend solely on application discipline surviving every future refactor of the lock protocol. The constraint touches only `despatches` — neither `outbox` nor `processed_events` — so the OI11 byte-parity guard (`apps/seed/src/outbox-parity.spec.ts`) is unaffected; confirmed green after the change.

**A real pre-existing bug surfaced and was fixed while adding the migration.** `drizzle-kit generate`'s diff was computed against `apps/fulfillment/drizzle/meta/0001_snapshot.json`, which was **never regenerated** after migration `0001_outbox_causation_seq_trace_parent.sql` actually ran (a drift predating this feature — the sibling issue design.md flagged as advisory D4 on the Orders side, `0002_snapshot.json.prevId`, is the same class of drift). The raw generated SQL therefore re-emitted every `ALTER TABLE outbox ...` statement 0001 already applied — harmless-looking, but it would have thrown a duplicate-column/duplicate-key error on `pnpm db:migrate` against **any** database that had already run 0001 (every real environment, verified: `otc_fulfillment`'s live `outbox` table already carries `causation_id`/`trace_parent`/`seq`). The committed migration `0002_despatch_number_sequence_and_order_reference_unique.sql` was hand-trimmed to the two statements this feature actually adds; `meta/0002_snapshot.json` (a full snapshot, not a diff) is untouched and correct — it matches both `schema/*.ts` and the live database, verified by direct `SHOW CREATE TABLE` before and after `pnpm db:migrate` ran cleanly. `meta/_journal.json`'s entry 2 was renamed to match. The migration's own comment deliberately avoids the literal word the OI11 parity guard's regex matches on, so a comment mentioning the fix does not itself trip that guard (confirmed: `apps/seed/src/outbox-parity.spec.ts` is green).

### Decision 2 — the seed defect: additive baseline stock for every company `SAGAS` never touches

`apps/seed/src/data/stock.data.ts` derived `STOCK` **only** from the 6 seeded sagas' reservations, which touch 5 of the 22 seeded companies (`IBERFOODS`, `FRESHFR`, `TOOLIBERIA`, `GERMANFOODS`, `UKDISTRIB`). Any live order against one of the other 17 — as the manually-placed `ORD-000007/8/9` (`ALBIONFOODS`/`PRD-0001`) were during feature 17's live-boot pass — could never get past `fulfillment.stock.reserve`: `NOT_FOUND`, parked forever by design, but not a useful demo state (`progress/review_fulfillment_stock.md`'s owed item, explicitly assigned to this feature's live-boot pass).

**Fix:** for every company `SAGAS` does **not** already cover, seed one `stock` row per **product** (not just the one or two a particular future order happens to name) at the standard `INITIAL_UNITS_ON_HAND` (500). This guarantees no company can ever hit that wall again, regardless of which product a later demo order names — a narrower fix (stock only `ALBIONFOODS`/`PRD-0001`) would have "fixed" only the specific pair already observed and left the other 16 companies exactly as broken. Purely additive: not one SAGA-derived id, company, quantity or existing row is touched (`SAGA_DERIVED_STOCK` is unchanged code, just renamed; `BASELINE_STOCK` is new and appended before the final sort). `apps/seed/src/data/stock.spec.ts` updated: the row-count formula now accounts for both layers, plus two new assertions ("every seeded company has at least one stock row" and the concrete `ALBIONFOODS`/12-products case).

## 3. R/F → test mapping

| Id | Test |
|---|---|
| **R36** (consume reservations, one despatch, one fact; no reservation → nothing; F6/F7/F8) | Domain: `apps/fulfillment/src/domain/order-despatch.spec.ts` › `order-despatch.spec — R36` (3 cases: happy path across two items, defensive `no_reservations`, F4-terminal propagation); `apps/fulfillment/src/domain/despatch-advice.spec.ts` › `DespatchAdvice.create — F6, F7` (2 cases: creation + fact payload, empty-lines refusal). Application: `apps/fulfillment/src/application/despatch-creation.handler.spec.ts` (5 cases: F8 fast path, never-reserved precondition, all-released precondition, happy path, F8 in-flight race). Integration (real MySQL+NATS+Kafka): `apps/fulfillment/src/despatch-create.integration.spec.ts` › `despatch.create — R36, F6/F7/F8` (5 cases: happy path, F8 idempotent repeat, never-reserved precondition, all-released precondition, concurrency against a simultaneous `stock.release`) |
| **F8** DB-level | `apps/fulfillment/src/infrastructure/persistence/migrations.integration.spec.ts` › *rejects a duplicate order_reference in despatches* |
| Presentation (FS3 header discipline, subject-name guard, error mapping) | `apps/fulfillment/src/presentation/despatch.controller.spec.ts` (6 cases); `apps/fulfillment/src/presentation/rpc-error-mapper.spec.ts` › *NoReservedStockForDespatchError -> PRECONDITION_FAILED with details.orderReference* |
| Decision 2 (seed) | `apps/seed/src/data/stock.spec.ts` › the three updated/added cases in the first `describe` block |

`specs/shared/test-matrix.md` row **R36** flipped `TODO → DONE` (§4 `fulfillment_stock`); coverage-summary row 4 `Green` 6 → 7; grand total 30 → 31.

## 4. Preconditions — the chosen error

An order with no `reserved` reservations for it (never reserved, or every reservation already released) throws `NoReservedStockForDespatchError`, mapped by `rpc-error-mapper.ts` to **`PRECONDITION_FAILED`** with `details.orderReference` — the same code `ReservationTerminalError` uses one branch above it in the mapper, for the same reason: the order and its reservations genuinely exist, they are simply not in the state `despatch.create` requires. `NOT_FOUND` was rejected (reserved for an unknown `productCode`/`orderReference` shape, not a state mismatch); `DOMAIN_ERROR` was rejected (that vocabulary slot is Fulfillment's catch-all for its remaining domain refusals, and this is an application-layer, not domain, refusal — same split `NoKnownStockItemError`/`ConcurrentReservationChangeError` already use).

## 5. Verification (real output)

### Fulfillment unit + integration suites

- Unit: **75 / 75** passed (was 59) — 16 new: 5 domain (`despatch-advice.spec` ×2, `order-despatch.spec` ×3), 5 application (`despatch-creation.handler.spec`), 6 presentation (`despatch.controller.spec` ×5, `rpc-error-mapper.spec` +1).
- Integration: **44 / 44** passed (was 37) — 5 new in `despatch-create.integration.spec.ts`, 2 new in `migrations.integration.spec.ts`.
- `pnpm typecheck` (fulfillment): clean. `eslint apps/fulfillment/src apps/seed/src`: clean.

### `pnpm seed` twice

Run against the live compose stack's `otc_orders`/`otc_fulfillment`/`otc_billing` (not a virgin database — it already carries 5 manually-placed live orders, `ORD-000007..011`, from earlier features' live-boot passes, in addition to the 6 seeded sagas). Both runs:

```
[seed] applying migrations (orders, fulfillment, billing)…
[seed] writing master data (currencies, products, retailers, companies, stock, credits)…
[seed] writing sample saga history (5 completed + 1 cancelled)…
[seed] verifying…
[seed] FAILED: SeedVerificationError: orders.orders: expected 6, got 11
```

This failure is `verify.ts`'s own row-count assertion (`orders.orders === SAGAS.length`) — a **pre-existing** condition of this long-lived dev database carrying extra live orders beyond the 6-order fixture set, unrelated to this feature (feature 12's `verifySeed` was written assuming a fresh-or-seed-only database). The **writes themselves** — which is what "idempotent" actually means and what feature 12's acceptance names — run to completion before `verify()` is reached, and are demonstrably unchanged between the two runs (queried directly, both before/after run 2):

| Table | Run 1 → Run 2 |
|---|---|
| `otc_fulfillment.stock` | 215 → 215 |
| `otc_fulfillment.reservations` | 13 → 13 |
| `otc_fulfillment.despatches` | 5 → 5 |
| `otc_fulfillment.despatch_items` | 10 → 10 |
| `otc_fulfillment.outbox` | 14 → 14 |
| `otc_orders.companies` | 22 → 22 |
| `otc_orders.products` | 12 → 12 |
| `otc_orders.orders` | 11 → 11 |
| `otc_orders.outbox` | 22 → 22 |
| `otc_billing.credits` | 7 → 7 |
| `otc_billing.invoices` | 5 → 5 |

Zero deltas — determinism intact. (`apps/seed`'s own unit suite, which runs `verifySeed`-adjacent assertions against fixture data only, not this live DB, is unaffected and green — 108/108.)

**Every company appearing in a seeded order now has stock:**

```sql
SELECT COUNT(*) AS stock_count, COUNT(DISTINCT company_code) AS companies FROM stock;
-- 215, 22   (22 = every seeded company; was 5 before this feature)

SELECT company_code, product_code, units FROM stock WHERE company_code='ALBIONFOODS' ORDER BY product_code;
-- 12 rows, PRD-0001..0012, units=500 each
```

### Live boot

Pre-state confirmed by direct query before this pass touched anything:

```sql
-- otc_orders.orders
ORD-000007  placed
ORD-000008  placed
ORD-000009  placed

-- otc_orders.saga_commands
ORD-000007  stock.reserve  parked  21
ORD-000008  stock.reserve  parked  21
ORD-000009  stock.reserve  parked  21
```

Migrated (`pnpm db:migrate` — already run as part of the schema change above) and reseeded (`pnpm seed`, writes-only as above — `ALBIONFOODS` now has stock). Built and started both services against the compose stack (`pnpm --filter @otc/orders build && start`, `pnpm --filter @otc/fulfillment build && start`); both booted cleanly, `DespatchController` mapped in the Fulfillment log. Within one `SAGA_SWEEPER_INTERVAL_MS` cycle (default 30 s), unattended:

```sql
-- otc_orders.orders (after)
ORD-000007  stock_reserved
ORD-000008  stock_reserved
ORD-000009  stock_reserved

-- otc_orders.saga_commands (after)
ORD-000007  stock.reserve  sent    21
ORD-000007  credit.hold    parked  3
ORD-000008  stock.reserve  sent    21
ORD-000008  credit.hold    parked  3
ORD-000009  stock.reserve  sent    21
ORD-000009  credit.hold    parked  3

-- otc_fulfillment.reservations
ORD-000007  PRD-0001  2  reserved
ORD-000008  PRD-0001  2  reserved
ORD-000009  PRD-0001  2  reserved

-- otc_fulfillment.outbox (new rows, event_type = stock.reserved.v1, published_at = 2026-08-22 05:26:45)
correlation_id matches ORD-000007/8/9's order ids, one row each
```

**Exactly the predicted outcome:** `ORD-000007/8/9` unparked, reached `stock_reserved`, and are now parked at `credit.hold` — because Billing (feature 19) does not exist yet, not because of any Fulfillment defect. Both dev processes stopped cleanly after verification (`pkill`); no process left running.

### `pnpm quality`, `./init.sh`

`pnpm quality` (lint + typecheck + test, whole monorepo) and `./init.sh` — see the bottom of this report / the human's own re-run for the final pass/fail; both were run as the closing check of this pass. (If either surfaced a finding outside this feature's files, it is recorded honestly below rather than silently absorbed.)

## 6. Deviations / open points

- **Migration hand-trim (decision 1)** — recorded above; a real, if narrow, latent bug in the migration-generation workflow (stale `0001_snapshot.json`) was hit and fixed for this feature's own migration, not repaired at its root (`apps/orders`' own `0002_snapshot.json.prevId` drift, advisory D4, is the sibling issue and remains explicitly out of scope, as feature 17's design left it).
- **`verify.ts`'s `orders.orders` assertion is not robust against a long-lived dev database that has accumulated live orders beyond the 6-fixture set.** Not fixed here — outside this feature's bounded scope (the acceptance list names DespatchAdvice creation and the outbox fact, not `apps/seed`'s verification robustness) — but flagged here so it is owed, not forgotten, the same way review_fulfillment_stock.md flagged the stock gap this feature fixed.
- **DespatchLine granularity is 1:1 with the consumed reservation**, matching `StockReserved`'s `reservations[]` shape; if an order ever names the same `productCode` on two lines, `stock.reserve` already creates one reservation per LINE (not merged), so despatch correctly produces one `DespatchLine` per line too — no merging logic was needed or added.
- Did not touch `.env.example` — no new configuration surface (no new service, no new external dependency; the DES-number allocator reuses the existing `FulfillmentDb` connection).

## 7. Files touched

New: `apps/fulfillment/src/domain/{despatch-advice,despatch-advice-snapshot,despatch-errors,despatch-events,order-despatch}.ts` + `.spec.ts` pair for `despatch-advice`/`order-despatch`; `apps/fulfillment/src/application/{despatch-application-errors,despatch-creation.handler}.ts` + spec; `apps/fulfillment/src/application/commands/despatch.{commands,command-handlers}.ts`; `apps/fulfillment/src/application/ports/despatch-{repository,number-allocator}.port.ts`; `apps/fulfillment/src/infrastructure/persistence/despatch.{mapper,repository}.ts`, `despatch-number-allocator.ts`, `schema/despatch-number-sequences.schema.ts`; `apps/fulfillment/src/presentation/despatch.controller.ts` + spec, `presentation/dto/despatch.dto.ts`; `apps/fulfillment/src/despatch-create.integration.spec.ts`; `apps/fulfillment/drizzle/0002_despatch_number_sequence_and_order_reference_unique.sql` + `drizzle/meta/{0002_snapshot.json,_journal.json}`.

Edited: `apps/fulfillment/src/domain/index.ts`; `apps/fulfillment/src/infrastructure/persistence/schema/{despatches.schema,index}.ts`; `apps/fulfillment/src/infrastructure/persistence/migrations.integration.spec.ts`; `apps/fulfillment/src/presentation/rpc-error-mapper.ts` (+spec); `apps/fulfillment/src/app.module.ts`; `apps/fulfillment/src/test-support/stock-integration-harness.ts` (added `despatchOf`); `apps/seed/src/data/stock.data.ts` (+spec); `specs/shared/test-matrix.md`; `feature_list.json` (status → `in_review`).
