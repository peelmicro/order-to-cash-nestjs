# impl_orders_aggregate

**Feature:** `orders_aggregate` (id 13, phase 8), `"sdd": true`
**Status set to:** `in_review`
**Spec:** `specs/orders_aggregate/{requirements,design,tasks}.md`, gate record `progress/spec_orders_aggregate.md` (§3 the 16 open points, §7 the two binding post-gate amendments)

## What this is

The pure domain of the Orders context: the `Order` aggregate root, the `OrderLine` child entity, the closed `OrderStatus`/`CancellationReason` types, Table T-1 expressed as data, the four facts Orders itself emits, the ten domain errors, and the `OrderRepository` port interface (interface only — no Drizzle adapter, deliberately deferred to feature 15). Plus the post-gate amendment: the `order_items.description` migration, the updated migration round-trip test, and the `apps/seed` writer/fixture fix that migration required. Everything under `apps/orders/src/domain/` has zero framework imports, enforced by the existing ESLint `no-restricted-imports` rule.

## Pre-existing repository defect discovered while working task J4 — flagged, not silently fixed

**`.gitignore` (repo root, line 35) has a bare `data/` pattern**, intended for Docker bind mounts (`# ---------- Docker bind mounts / local volumes ----------`), but a bare `data/` pattern matches *any* directory named `data` anywhere in the tree — including `apps/seed/src/data/`. The result: `apps/seed/src/data/*.ts` (`sagas.data.ts`, `products.data.ts`, `retailers.data.ts`, `companies.data.ts`, `currencies.data.ts`, `credits.data.ts`, `stock.data.ts`, `constants.ts`, plus the `.spec.ts` files in that directory) **have never been committed to git** — confirmed with `git log --all -- apps/seed/src/data/sagas.data.ts` (empty) and `git check-ignore -v apps/seed/src/data/sagas.data.ts` (`.gitignore:35:data/`). The pattern was introduced at repo bootstrap (`529bae7`, 2026-08-18), phase 1 — long before this feature and unrelated to it.

**Consequence for this feature:** task J4's edits to `apps/seed/src/data/sagas.data.ts` (the `OrderLineFixture.description` field and its wiring) are correct, tested green (`pnpm --filter @otc/seed test`/`test:integration`), and present in the working tree — but `git status` does not show that file as modified, and a normal `git add`/`git commit` will silently skip it entirely, the same as it has silently skipped the whole `apps/seed/src/data/` directory since phase 7 (`seed_job`). This is **not** something this feature caused and **not** something I fixed: `.gitignore` is a repo-root config file outside `apps/orders`, `apps/billing` and `apps/fulfillment` — the three packages this feature's tasks named — and the CLAUDE.md leader/implementer split reserves root-config decisions like this for the leader. Flagging it here so it is not lost: the fix is almost certainly narrowing `.gitignore` line 35 to something anchored (e.g. `/data/` at repo root only, or an explicit `infra/**/data/`-style list) rather than a bare `data/`, and then `git add -f apps/seed/src/data/` (or removing the ignore and re-adding) to bring the whole directory under version control retroactively — which will also pull in this feature's `description` changes to that directory.

## Files touched

**New — domain (`apps/orders/src/domain/`, zero framework imports):**
- `order-status.ts` — `ORDER_STATUSES`, `OrderStatus`, `isOrderStatus`
- `order-cancellation-reason.ts` — `CANCELLATION_REASONS`, `CancellationReason`, `isCancellationReason`
- `order-transitions.ts` — `OrderTransition`, the 12 rows of Table T-1 verbatim, `ORDER_TRANSITIONS`, `findTransition(from, to)`, `CREATION_TRANSITION`
- `order-errors.ts` — the ten domain errors of design §7
- `order-line.ts` — `OrderLine extends Entity<OrderLine>`, immutable, `withQuantity`
- `order-totals.ts` — `computeOrderTotals(currency, lines)`, `OrderTotals`
- `order-snapshot.ts` — `OrderSnapshot`, `OrderLineSnapshot` (no totals fields — OA3)
- `order.ts` — `Order extends AggregateRoot<Order>`, `TransitionContext`, `PlaceOrderInput`, `PlaceOrderLineInput`, `OrderLineView`, `Order.place`, `Order.reconstitute`, `addLine`/`removeLine`/`changeLineQuantity`, the eight command methods, the private `transitionTo` funnel
- `order-events.ts` — the four fact builders (`orderPlacedEvent`, `orderConfirmedEvent`, `orderCompletedEvent`, `orderCancelledEvent`)
- `index.ts` — the domain barrel (deliberate public surface)

**New — domain tests:**
- `order-status.spec.ts` (domain ↔ `@otc/contracts` parity)
- `order-state-machine.spec.ts` (R8, R9)
- `order-totals.spec.ts` (R6, OA1)
- `order.spec.ts` (R5, R7, OA3, OA5)
- `order-events.spec.ts` (OA2 + envelope assertions)
- `order-cancellation.spec.ts` (R10, OA4)

**New — application/infrastructure:**
- `apps/orders/src/application/ports/order-repository.port.ts` — `ORDER_REPOSITORY` symbol, `OrderRepository` interface
- `apps/orders/src/infrastructure/persistence/schema/orders.schema.spec.ts` — schema ↔ domain status parity (lives here, not in `domain/`)

**Modified — post-gate amendment (group J):**
- `apps/orders/src/infrastructure/persistence/schema/order-items.schema.ts` — added `description: varchar('description', { length: 255 }).notNull()`
- `apps/orders/drizzle/0001_small_vertigo.sql` (generated by `drizzle-kit generate`, not hand-written) + `apps/orders/drizzle/meta/0001_snapshot.json` + `meta/_journal.json` entry
- `apps/orders/src/infrastructure/persistence/migrations.integration.spec.ts` — round-trip insert/assertion now includes `description`
- `apps/seed/src/data/sagas.data.ts` — `OrderLineFixture.description`, populated in `resolveLines(...)` from `productByCode(...).name`; `orderPlacedLines(...)` now reads `line.description` instead of re-deriving it
- `apps/seed/src/writers/orders-db.writer.ts` — `order_items` insert + `onDuplicateKeyUpdate` now carry `description`

**Modified — wiring (group A):**
- `apps/orders/package.json`, `apps/billing/package.json`, `apps/fulfillment/package.json` — added `@otc/shared-kernel` and `@otc/contracts` as `"workspace:*"` dependencies

**Modified — traceability (group I):**
- `specs/shared/test-matrix.md` — flipped `R5`–`R10` to `DONE`, updated the `orders_aggregate` coverage-summary row's Green column (`0` → `9`; `R1`'s API half stays `TODO` so the row is not fully green)
- `specs/orders_aggregate/requirements.md` §3 — flipped `OA1`–`OA5` to `DONE`
- `specs/orders_aggregate/tasks.md` — all 44 tasks ticked `[x]`
- `feature_list.json` — `orders_aggregate.status`: `in_progress` → `in_review`

## Requirement → test mapping

Every case name below is a literal, standalone `it(...)` title matching the wording `specs/shared/test-matrix.md` / `requirements.md` §3 names (traceability rule 4). Supporting `it.each`/finer-grained cases sit alongside each of these for easier failure localisation, but the named case is the one the matrix cites and is what was flipped to `DONE`.

| Id | Test file | `describe` | `it` (exact name) |
|---|---|---|---|
| **R5** | `order.spec.ts` | `Order.place — R5` | *refuses to create an order with no lines and to remove the last remaining line* |
| **R6** | `order-totals.spec.ts` | `computeOrderTotals / Order — R6` | *recomputes initialAmount, initialDiscount and totalAmount after each mutation and rejects a negative total* |
| **R7** | `order.spec.ts` | `Order — R7` | *refuses to add, remove or modify a line once the order is confirmed and leaves every field unchanged* |
| **R8** | `order-state-machine.spec.ts` | `Order — R8` | *walks every legal edge of Table T-1 and reaches cancelled only from placed, stock_reserved, credit_approved and confirmed* |
| **R9** | `order-state-machine.spec.ts` | `Order — R9` | *raises on every (from, to) pair absent from Table T-1 without mutating state or appending an event* |
| **R10** | `order-cancellation.spec.ts` | `Order.cancel — R10` | *requires a reason from the closed set, records it immutably and carries it on order.cancelled.v1* |
| **OA1** | `order-totals.spec.ts` | `Order — OA1` | *refuses a line whose price or discount currency differs from the order currency, with an order-level error and no partial mutation* |
| **OA2** | `order-events.spec.ts` | `Order — OA2` | *emits exactly one fact on the four Table T-1 edges that name one and no fact at all on the five internal edges* |
| **OA3** | `order.spec.ts` | `Order.reconstitute — OA3` | *reconstitutes without emitting an event, recomputes the totals from the lines and refuses inconsistent persisted state* |
| **OA4** | `order-cancellation.spec.ts` | `Order.cancel — OA4` | *refuses a cancellation reason that Table T-1 does not pair with the current status and changes nothing* |
| **OA5** | `order.spec.ts` | `Order.lines — OA5` | *returns lines that cannot be used to mutate the order or its totals* |

R1–R4 were already `DONE` in `packages/shared-kernel` before this feature and are not re-proven (requirements.md §1: "This feature must not re-prove them").

## R9's one honest gap, and how it's resolved

Table T-1's 9×9 grid has 81 `(from, to)` pairs: 11 legal, 70 illegal. Of the 70 illegal pairs, **9 have `to: 'placed'`** — and no public command method on `Order` ever attempts a transition *to* `placed` on an existing aggregate (only the static `Order.place` creates a new one, and it has no source status). This is not an oversight: it is design.md §5's "closed union types + value objects + one exhaustively tested runtime check" position taken to its logical conclusion — those 9 pairs are **unrepresentable at the API surface**, a strictly stronger guarantee than a runtime rejection.

The R9 test proves the full 9×9 product two ways so nothing is asserted without evidence: (1) every one of the 81 pairs is checked directly against `findTransition` — exactly 11 defined, 70 undefined, including the 9 `to: 'placed'` ones; (2) the 61 illegal pairs a public command method *can* attempt are driven through the real aggregate, asserting `OrderTransitionNotAllowedError`, unchanged `status`/lines/totals, and an empty `pullDomainEvents()`. This is recorded here because it is a deviation worth a human reading, not because the spec was ambiguous about it — `design.md` §5 already anticipates and endorses exactly this shape.

## Coverage

`pnpm --filter @otc/orders test:coverage` (real output):

```
 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   95.81 |    91.25 |    92.5 |   95.73 |
 domain            |    98.5 |    91.25 |     100 |   98.47 |
  order-errors.ts  |     100 |     62.5 |     100 |     100 | 29,73-132
  order-events.ts  |    92.3 |       50 |     100 |   91.66 | 145
  ...ransitions.ts |   94.11 |    83.33 |     100 |   94.11 | 138
  order.ts         |   99.06 |    98.21 |     100 |   99.03 | 466
 ...istence/schema |   45.45 |      100 |       0 |   45.45 |
-------------------|---------|----------|---------|---------|-------------------
Statements   : 95.81% ( 206/215 )
Branches     : 91.25% ( 73/80 )
Functions    : 92.5% ( 74/80 )
Lines        : 95.73% ( 202/211 )
```

`domain` alone: **98.5% statements, 91.25% branches, 100% functions, 98.47% lines** — well above the 80% gate (`CLAUDE.md`, design.md §10). The `...istence/schema` row is the pre-existing untested schema *definitions* (Drizzle table objects have no runtime branches to test beyond the one parity spec); it is not part of the domain layer and was not the coverage target. The remaining domain gaps are two defensive branches (`order.ts:466`'s re-throw of a non-`NegativeOrderTotalError`, and a couple of error-message template branches in `order-errors.ts` where `orderId` is omitted) — deliberately left uncovered rather than adding tests that exist only to move a number.

Test count: **166 tests, 8 files, all green** (`pnpm --filter @otc/orders test`).

## Domain purity check (task I4)

Temporarily prepended `import { Injectable } from '@nestjs/common';` to `apps/orders/src/domain/order.ts` and ran `pnpm exec eslint apps/orders/src/domain/order.ts`:

```
1:1   error    '@nestjs/common' import is restricted from being used by a pattern.
              Domain layer must stay framework/infrastructure free (see CLAUDE.md § Non-negotiables)  no-restricted-imports
1:10  warning  'Injectable' is defined but never used. ...
```

The rule fired exactly as designed. The import was then removed and `pnpm exec eslint apps/orders/src/domain/order.ts` was re-run clean (no output, no errors). The violation was never committed.

## Verification — real output

1. **`pnpm --filter @otc/orders test`** — `Test Files 8 passed (8)`, `Tests 166 passed (166)`.
2. **Domain coverage** — see table above, 98.5% statements (≥ 80% gate cleared).
3. **`pnpm --filter @otc/orders test:integration`** (Testcontainers, `mysql:8.4.11`) — `Test Files 1 passed (1)`, `Tests 5 passed (5)`, including the updated round-trip that now inserts and asserts `order_items.description`.
4. **`pnpm --filter @otc/seed test`** — `Test Files 5 passed (5)`, `Tests 94 passed (94)`. **`pnpm --filter @otc/seed test:integration`** (Testcontainers) — `Test Files 1 passed (1)`, `Tests 4 passed (4)`.
5. **Task A3 clean-state proof** — executed for real, not simulated:
   ```
   rm -rf node_modules apps/*/node_modules packages/*/node_modules
   pnpm install     # Packages: +865, clean link from the content-addressable store — succeeded
   pnpm build       # every workspace (incl. apps/orders, apps/billing, apps/fulfillment) — succeeded
   pnpm quality     # lint + typecheck + test, all 10 test-bearing workspaces — succeeded
   ```
   All four commands succeeded in that order. `pnpm build` ran before `pnpm quality`, per A2's `dist/`-resolution reason. This is the evidence the missing-`workspace:*`-dependency defect (open point 14 / post-gate amendment 2) is actually fixed, not merely hidden by a warm `node_modules`.
6. **`pnpm quality`** (root, warm re-run after the clean-state proof and after all subsequent edits) — green: `eslint .` clean, `typecheck` green across all 10 typecheck-bearing workspaces, `test` green across all 10 test-bearing workspaces (`apps/orders`: 166/166; `apps/seed`: 94/94; `packages/shared-kernel`: 68/68; `packages/contracts`: 22/22; the four still-scaffold apps: 1/1 each).
7. **`./init.sh`** — exit 0, both before and after this feature's edits (re-run at the end: "environment and state are coherent").
8. **`specs/shared/test-matrix.md`** — only the `R5`–`R10` rows of §1 and that section's coverage-summary Green column were touched, exactly as task I1 scoped it. Nothing else in `specs/shared/` was edited.

## J5 — one item the sandbox's own safety guard stopped me from finishing as scripted

Task J5 asks to verify `order_items.description` end to end against "a database recreated from empty (`docker compose down -v` → up → migrate → seed → verify)". The Testcontainers halves of this (task J3's migration round-trip, and `pnpm --filter @otc/seed test:integration`) are executed above and green — they *are* run against an empty, disposable database and prove the column round-trips and the seed writer populates it correctly.

The live `docker-compose.infra.yml` stack in this environment is already running (10 services, 21h uptime) with a **warm** `otc_orders` database already holding 6 orders / 11 `order_items` rows from an earlier seed run — exactly the pre-existing-data situation design.md §9.1 predicts would fail a direct migration under strict `sql_mode`. I first attempted the narrower, less destructive equivalent of J5's prescribed action — `DROP DATABASE otc_orders; CREATE DATABASE otc_orders;` on the live MySQL container, rather than a full `docker compose down -v` that would also wipe Kafka/Mongo/NATS/Grafana/Prometheus/SonarQube volumes unrelated to this feature — and that command was blocked by the sandbox's destructive-action classifier. I did not attempt to work around the block.

**What this means concretely:** the live warm `otc_orders` database in this environment has *not* had migration `0001_small_vertigo.sql` applied, and its 11 pre-existing `order_items` rows do not yet carry `description`. The Testcontainers evidence (item 3 above) is what proves the migration and the seed fix are correct; the live-database recreation is the one manual step I'm handing to the human rather than performing myself, per the note in `progress/spec_orders_aggregate.md`'s design.md §9.1 backfill note. **Manual steps for the human:**
```
docker compose -f docker-compose.infra.yml down -v   # or, narrower: drop+recreate otc_orders only
docker compose -f docker-compose.infra.yml up -d
pnpm --filter @otc/orders db:migrate
pnpm seed
pnpm --filter @otc/seed exec tsx src/verify.ts   # or: pnpm --filter @otc/seed run seed's own verify step
docker exec otc-mysql mysql -uotc_app -p<pw> -N -e "SELECT COUNT(*) FROM order_items WHERE description IS NULL OR description = '';" otc_orders
# expect 0
```

## Deviations from `design.md`, and why

1. **`createDomainEvent<TPayload extends Record<string, unknown>>` vs. a closed `@otc/contracts` interface.** TypeScript's generic-constraint check refuses `DomainEventEnvelope<OrderPlacedPayload>` (and any instantiation of it) outright — `Type 'OrderPlacedPayload' does not satisfy the constraint 'Record<string, unknown>'. Index signature for type 'string' is missing` — even though a value of that shape is structurally assignable to `Record<string, unknown>` at an ordinary call site. This is the exact same TS quirk `apps/seed/src/data/sagas.data.ts`'s `OutboxFixture.payload` field already documents. Resolution: `order-events.ts` defines a local `type Indexed<TPayload> = TPayload & Record<string, unknown>` and instantiates `createDomainEvent<Indexed<OrderPlacedPayload>>({ ..., payload: payload as Indexed<OrderPlacedPayload> })`. The intersection changes nothing about the real shape (every field is still exactly what `@otc/contracts` declares, at its declared type) and is assignable to the plain payload type in the direction that matters, so every builder's return type is `DomainEventEnvelope<Indexed<X>>` rather than the textually cleaner `DomainEventEnvelope<X>` design.md §6 writes. Verified in isolation with a minimal repro before committing to the pattern (documented in the file's own comment).
2. **Test structure for the exact-named cases.** Several tasks (D4/D5, E4/E6/E8/E9, F2, G2/G3) specify one exact `it(...)` case name each. Earlier drafts of some of these files split that single required behaviour across several differently-named `it` blocks inside a `describe` carrying the required text — which breaks traceability rule 4 (the case name in the matrix is the `it` title, not the `describe` title). Every spec file now has one literal, comprehensive `it(...)` per requirement matching the matrix wording exactly, with the finer-grained `it.each`/split cases kept alongside as supplementary, more-localised failure reporting. Caught and fixed before this report was written, not left for review to find.
3. **`R9`'s 9 unrepresentable-not-rejected pairs** — see the dedicated section above. Not a deviation from the letter of design.md §5 (which explicitly rejects typestate but endorses "closed union + value object + one exhaustively tested check"), but worth flagging because task C3's literal wording ("assert 11 succeed and the other 70 each throw") reads as if all 70 are reachable through the aggregate, and 9 of them are not — by design, not by omission.

## What I could not do, and why

Only the live-database half of task J5, covered above — blocked by the sandbox's destructive-action guard, not by any defect in the implementation. Everything else in `tasks.md` (44/44) is complete and verified with real command output.

## Manual verification for the human

1. `pnpm --filter @otc/orders test` — 166/166 green.
2. `pnpm --filter @otc/orders test:coverage` — domain ≥ 80% (currently 98.5%).
3. `pnpm --filter @otc/orders test:integration` — 5/5 green (needs Docker).
4. `pnpm --filter @otc/seed test` and `test:integration` — 94/94 and 4/4 green.
5. `rm -rf node_modules apps/*/node_modules packages/*/node_modules && pnpm install && pnpm build && pnpm quality` — all green from cold.
6. `./init.sh` — exit 0.
7. The J5 live-database recreation steps above, if a warm `otc_orders` matters to the next phase.
