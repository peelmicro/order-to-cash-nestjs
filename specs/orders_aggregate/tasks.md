# `orders_aggregate` — Tasks

> Ordered. Each task is small enough to verify on its own. The implementer ticks `[x]` as it goes and stops at the first task it cannot complete honestly. Tests are written **inside** the loop — a task that adds behaviour and the task that proves it are adjacent, never batched to the end.
>
> **Order of groups: A → B → C → D → E → F → G → H → J → I.** Group J is a post-gate insertion lettered out of sequence so that the ids the approval gate read keep their meaning; I stays last because it closes the loop.
>
> Requirement ids: shared `R1`–`R10` ([`specs/shared/requirements.md`](../shared/requirements.md) §1); local `OA1`–`OA5` ([`requirements.md`](./requirements.md) §2). Design: [`design.md`](./design.md).

## A. Wiring

- [x] **A1.** Add `"@otc/shared-kernel": "workspace:*"` and `"@otc/contracts": "workspace:*"` to the `dependencies` of **all three** service packages — `apps/orders/package.json`, `apps/billing/package.json` and `apps/fulfillment/package.json` — then run `pnpm install`. *(Post-gate amendment: the gate widened this from `apps/orders` alone. Verified — only `apps/seed` declares the two packages today, because it is the only app that imports them so far; the omission is latent and identical in all three services, and fixing it once here spares features 17–20 the same discovery twice. `apps/gateway` and `apps/web` are out of scope: this feature does not touch them.)*
- [x] **A2.** Verify the packages resolve: `pnpm build` then `pnpm --filter @otc/orders typecheck` (and the same for `@otc/billing`, `@otc/fulfillment`). Both resolve through `dist/`, which is git-ignored — if `typecheck` cannot find the types, build first; do **not** change the root `quality` script in this feature (noted as an open point for feature 34).
- [x] **A3.** *Clean-state proof of A1.* A warm workspace can hide a missing dependency declaration — pnpm's store and an already-linked `node_modules` will resolve `@otc/shared-kernel` from the root even when a package never asks for it. So prove the fix from scratch: `rm -rf node_modules apps/*/node_modules packages/*/node_modules`, then `pnpm install`, then `pnpm build`, then `pnpm quality`. All four must succeed in that order, and `pnpm build` must run **before** `pnpm quality` for the `dist/`-resolution reason in A2. Record the exact command sequence and its outcome in the progress file (task I5) — that record, not the warm run, is the evidence the defect is fixed.

## B. Closed types

- [x] **B1.** `apps/orders/src/domain/order-status.ts` — `ORDER_STATUSES` const tuple, `OrderStatus` union, `isOrderStatus` guard (design §3).
- [x] **B2.** `apps/orders/src/domain/order-cancellation-reason.ts` — `CANCELLATION_REASONS`, `CancellationReason`, `isCancellationReason`.
- [x] **B3.** *Test* `apps/orders/src/domain/order-status.spec.ts` — parity with `@otc/contracts`: mutual assignability of both unions and equality of the value sets.
- [x] **B4.** *Test* `apps/orders/src/infrastructure/persistence/schema/orders.schema.spec.ts` — `ORDER_STATUS_VALUES` from `orders.schema.ts` equals `ORDER_STATUSES`. This test lives in `infrastructure/` on purpose: a `domain/` test may not import `infrastructure/` (ESLint).

## C. Table T-1 as data

- [x] **C1.** `apps/orders/src/domain/order-transitions.ts` — `OrderTransition`, the 12 rows of Table T-1 verbatim (including `trigger` text and the `emits` cell), the lookup map and `findTransition(from, to)` (design §5).
- [x] **C2.** *Test* `order-state-machine.spec.ts` › *walks every legal edge of Table T-1 and reaches cancelled only from placed, stock_reserved, credit_approved and confirmed* — **R8**. Name the case exactly as `specs/shared/test-matrix.md` §1 names it.
- [x] **C3.** *Test* `order-state-machine.spec.ts` › *raises on every (from, to) pair absent from Table T-1 without mutating state or appending an event* — **R9**. Iterate the full 9 × 9 product; assert 11 succeed and the other 70 each throw `OrderTransitionNotAllowedError` with `from`/`to` set, leave the status unchanged and leave `pullDomainEvents()` empty. (C2/C3 will not compile until D and E land; write them alongside and let them go green there.)

## D. Errors and value plumbing

- [x] **D1.** `apps/orders/src/domain/order-errors.ts` — the ten error classes of design §7, each extending `DomainError` with its stable `code` and typed fields.
- [x] **D2.** `apps/orders/src/domain/order-line.ts` — `OrderLine extends Entity<OrderLine>`, immutable fields, `withQuantity(q)` returning a new instance with the same id, no setters.
- [x] **D3.** `apps/orders/src/domain/order-totals.ts` — `computeOrderTotals(currency, lines)` using `Money` arithmetic only; order-level discount as a named `Money.zero(currency)` term; `NegativeOrderTotalError` on a negative total (design §4.3).
- [x] **D4.** *Test* `order-totals.spec.ts` › *recomputes initialAmount, initialDiscount and totalAmount after each mutation and rejects a negative total* — **R6** (matrix wording).
- [x] **D5.** *Test* `order-totals.spec.ts` › *refuses a line whose price or discount currency differs from the order currency, with an order-level error and no partial mutation* — **OA1**: assert the error is `OrderLineCurrencyMismatchError`, **not** the kernel's `CurrencyMismatchError`.

## E. The aggregate

- [x] **E1.** `apps/orders/src/domain/order-snapshot.ts` — `OrderSnapshot` / `OrderLineSnapshot` in value objects, carrying **no totals fields** (design §4.2).
- [x] **E2.** `apps/orders/src/domain/order.ts` — `Order extends AggregateRoot<Order>`, private constructor, `OrderProps`, read-only accessors, `TransitionContext`.
- [x] **E3.** `Order.place(input, ctx)` — creation invariants in order (≥ 1 line → currency → totals → status `placed`), one `order.placed.v1`.
- [x] **E4.** *Test* `order.spec.ts` › *refuses to create an order with no lines and to remove the last remaining line* — **R5** (matrix wording).
- [x] **E5.** `Order.reconstitute(snapshot)` — no events, totals re-derived, status validated, cancellation reason required iff `cancelled` (design §4.2).
- [x] **E6.** *Test* `order.spec.ts` › *reconstitutes without emitting an event, recomputes the totals from the lines and refuses inconsistent persisted state* — **OA3**.
- [x] **E7.** `addLine`, `removeLine`, `changeLineQuantity` with the validate-then-commit sequence and the `LINES_MUTABLE_IN` guard (design §4.4).
- [x] **E8.** *Test* `order.spec.ts` › *refuses to add, remove or modify a line once the order is confirmed and leaves every field unchanged* — **R7** (matrix wording). Assert across all six frozen statuses, and assert the totals too.
- [x] **E9.** `get lines()` returning frozen copies; *Test* `order.spec.ts` › *returns lines that cannot be used to mutate the order or its totals* — **OA5**.
- [x] **E10.** The private `transitionTo(to, ctx)` funnel plus the eight command methods `markStockReserved`, `approveCredit`, `confirm`, `markDespatched`, `markInvoiced`, `markPaid`, `complete`, `cancel` (design §4.5). C2/C3 go green here.

## F. Facts

- [x] **F1.** `apps/orders/src/domain/order-events.ts` — the four builders for `order.placed.v1`, `order.confirmed.v1`, `order.completed.v1`, `order.cancelled.v1` using `createDomainEvent` and `@otc/contracts` payload types (`import type` only). `correlationId = aggregateId = order.id`; `causationId`/`occurredAt` from the context; `Money` → minor units + currency; `Date` → ISO-8601.
- [x] **F2.** *Test* `order-events.spec.ts` › *emits exactly one fact on the four Table T-1 edges that name one and no fact at all on the five internal edges* — **OA2**.
- [x] **F3.** *Test* `order-events.spec.ts` — envelope assertions: every field present, `eventType` matches `<aggregate>.<fact>.v<n>`, `correlationId` is the order id, `occurredAt` is the supplied instant (supports R11/R12 without duplicating their integration rows).

## G. Cancellation

- [x] **G1.** `cancel(reason, ctx, compensationSteps = [])` — closed set, immutable once set, reason ↔ status pairing from T-1, `compensationSteps` passed through to the payload (design §4.5).
- [x] **G2.** *Test* `order-cancellation.spec.ts` › *requires a reason from the closed set, records it immutably and carries it on order.cancelled.v1* — **R10** (matrix wording).
- [x] **G3.** *Test* `order-cancellation.spec.ts` › *refuses a cancellation reason that Table T-1 does not pair with the current status and changes nothing* — **OA4**. Include the `stock_rejected`-from-`placed` and `credit_rejected`-from-`stock_reserved` positive cases and `operator_cancelled` from all four.

## H. Port and barrel

- [x] **H1.** `apps/orders/src/application/ports/order-repository.port.ts` — `ORDER_REPOSITORY` symbol token and the `OrderRepository` interface (design §8). **Interface only — no Drizzle adapter in this feature.**
- [x] **H2.** `apps/orders/src/domain/index.ts` — the deliberate public surface of the domain (aggregate, entity, closed types, transitions, errors, event builders, snapshot types); internals stay unexported.

## J. Schema — the `order_items.description` column (post-gate amendment)

> **Lettered out of sequence on purpose.** Group J is inserted by the post-gate amendment of 2026-08-20 and runs **here, between H and I**, so that every task id the approval gate read (`A1`–`I6`) keeps the meaning it had when it was approved. Work it after H and before I. Rationale and the rejected alternative: [`design.md`](./design.md) §9.1.
>
> These tasks are **schema and fixture** work, not domain work: they do not touch `apps/orders/src/domain/`, and they leave this feature's domain suite pure.

- [x] **J1.** `apps/orders/src/infrastructure/persistence/schema/order-items.schema.ts` — add `description: varchar('description', { length: 255 }).notNull()` after `productId`, with a comment stating it is a **snapshot** taken at order time (`domain-model.md` §3.1), not a join into `products`. Import `varchar` from `drizzle-orm/mysql-core`.
- [x] **J2.** Generate the migration: `pnpm --filter @otc/orders db:generate`. It must produce `apps/orders/drizzle/0001_<name>.sql` containing a single `ALTER TABLE ... ADD ... varchar(255) NOT NULL` statement against `order_items` (the exact SQL is in `design.md` §9.1) plus the matching `meta/` journal + snapshot entries. Commit the generated SQL as generated — do **not** hand-edit it, and do **not** touch `0000_bizarre_champions.sql` (a committed migration is immutable).
- [x] **J3.** Update the existing Testcontainers spec `apps/orders/src/infrastructure/persistence/migrations.integration.spec.ts`: add `description` to the `order_items` insert in the round-trip case and to its `toMatchObject` assertion, so the round-trip still proves every column of the table. The table-list case still expects **8** tables plus `__drizzle_migrations` — this migration adds a column, not a table. Run `pnpm --filter @otc/orders test:integration`; it must be green from an empty database.
- [x] **J4.** Fix `apps/seed` so it is not left broken: add `description: string` to `OrderLineFixture` in `apps/seed/src/data/sagas.data.ts`, populate it in `resolveLines(...)` from `productByCode(line.productCode).name` — the value `orderPlacedLines(...)` **already** puts into the `order.placed.v1` payload, so the row and the fact agree by construction — and write it in the `order_items` insert in `apps/seed/src/writers/orders-db.writer.ts`, including in that insert's `onDuplicateKeyUpdate` set so a warm database backfills on the next seed run. Do **not** switch the description source to `products.description` here: that would change payloads the seeded outbox rows already carry, and it is a seed-data decision, not an aggregate one.
- [x] **J5.** Verify the whole chain end to end: `pnpm --filter @otc/seed test` and `pnpm --filter @otc/seed test:integration` green; then, against a database recreated from empty (`docker compose down -v` → up → `pnpm --filter @otc/orders db:migrate` → seed → `pnpm --filter @otc/seed verify` or the app's verify entry point), confirm `order_items.description` is populated for every seeded line. Note in the progress file (I5) that a pre-existing warm database must be recreated, since a `NOT NULL` column with no default cannot be added over existing rows in strict `sql_mode`.

## I. Closing the loop

- [x] **I1.** Update `specs/shared/test-matrix.md` §1: flip rows **R5, R6, R7, R8, R9, R10** to `DONE` with the concrete file path and the case name, in the same style as the already-green `R1`–`R4` rows. Update the "Green" column of the coverage summary (§1 row) and leave R1's API half `TODO`. Touch **nothing else** in `specs/shared/` — it is the trilogy contract.
- [x] **I2.** Update `specs/orders_aggregate/requirements.md` §3: flip `OA1`–`OA5` to `DONE` with file path and case name.
- [x] **I3.** Run `pnpm quality` (lint + typecheck + test) from the repository root; it must be green. Run `pnpm --filter @otc/orders test:coverage` and check the domain layer is at **≥ 80 %**.
- [x] **I4.** Deliberately verify domain purity: temporarily add `import { Injectable } from '@nestjs/common';` to `apps/orders/src/domain/order.ts`, confirm `pnpm lint` fails with the domain-purity message, then remove it. Record the observation in the progress file (do not commit the violation).
- [x] **I5.** Write `progress/impl_orders_aggregate.md`: what was built, every requirement (`R5`–`R10`, `OA1`–`OA5`) with its test, the coverage numbers, the purity check of I4, any deviation from `design.md` with its reason, and the manual verification steps for the human.
- [x] **I6.** Set `orders_aggregate` to `in_review` in `feature_list.json`. Do **not** set it `done` (the reviewer does) and do **not** commit.
