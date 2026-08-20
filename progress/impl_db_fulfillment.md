# impl_db_fulfillment

**Feature:** `db_fulfillment` (id 10, phase 6)
**Status set to:** `in_review`

## What this is

Drizzle ORM schema + one committed SQL migration for the `otc_fulfillment`
database, inside `apps/fulfillment/src/infrastructure/persistence/`, plus a
Testcontainers integration test proving the migration applies from empty and
every table round-trips (this feature's two acceptance criteria in
`feature_list.json`). `db_fulfillment` is `"sdd": false`, so implementation
followed the acceptance list + the task prompt's "Tables" section directly —
no `specs/db_fulfillment/`. The task explicitly required following the
patterns (and advisories) set by `db_orders` (feature 9, approved) — this
report calls out every place that pattern was followed or deliberately
adapted.

## Files touched

**New — schema (infrastructure layer only, `src/domain` untouched):**
- `apps/fulfillment/src/infrastructure/persistence/schema/stock.schema.ts`
- `apps/fulfillment/src/infrastructure/persistence/schema/reservations.schema.ts`
- `apps/fulfillment/src/infrastructure/persistence/schema/despatches.schema.ts`
- `apps/fulfillment/src/infrastructure/persistence/schema/despatch-items.schema.ts`
- `apps/fulfillment/src/infrastructure/persistence/schema/outbox.schema.ts`
- `apps/fulfillment/src/infrastructure/persistence/schema/processed-events.schema.ts`
- `apps/fulfillment/src/infrastructure/persistence/schema/index.ts` (barrel)

**New — connection/migration plumbing (mirrors `apps/orders` file-for-file):**
- `apps/fulfillment/src/infrastructure/persistence/db-config.ts` —
  `loadFulfillmentDbConfig`, reads `FULFILLMENT_DB_HOST` + the shared
  `MYSQL_*` vars.
- `apps/fulfillment/src/infrastructure/persistence/client.ts` —
  `createFulfillmentPool` / `createFulfillmentDb`.
- `apps/fulfillment/src/infrastructure/persistence/migrator.ts` —
  `runFulfillmentMigrations(config)`, used by both the CLI script and the
  integration test.
- `apps/fulfillment/src/infrastructure/persistence/migrate-cli.ts` — CLI
  entry point for `db:migrate`.
- `apps/fulfillment/drizzle.config.ts` — `drizzle-kit generate` config.
- `apps/fulfillment/drizzle/0000_nappy_mad_thinker.sql` + `apps/fulfillment/drizzle/meta/`
  — the one committed migration (generated once, schema was correct on the
  first pass — see "What surprised me").

**New — tests:**
- `apps/fulfillment/src/infrastructure/persistence/migrations.integration.spec.ts`
  — Testcontainers (`@testcontainers/mysql`, image `mysql:8.4.11`, same
  pinned tag as `docker-compose.infra.yml` and `db_orders`).
- `apps/fulfillment/vitest.integration.config.mts` — separate Vitest project
  for `*.integration.spec.ts`, 120s test/hook timeouts (same shape as
  `apps/orders`).

**Modified:**
- `apps/fulfillment/vitest.config.mts` — excludes `*.integration.spec.ts`.
- `apps/fulfillment/package.json` — added `drizzle-orm`, `mysql2` (deps);
  `drizzle-kit`, `testcontainers`, `@testcontainers/mysql` (devDeps); scripts
  `db:generate`, `db:migrate`, `test:integration`.
- `package.json` (root) — `db:generate:fulfillment`, `db:migrate:fulfillment`
  convenience scripts (root `test:integration` already aggregates every
  workspace's `test:integration` via `pnpm -r --if-present`, so no change
  needed there).
- `.env.example` / `.env` — added `FULFILLMENT_DB_HOST=localhost` (same
  pattern as `ORDERS_DB_HOST`; `MYSQL_DB_FULFILLMENT` and the grant for it
  already existed in `.env.example` / `infra/mysql/init/01-create-databases.sh`
  from the `infra_compose` feature, so nothing needed there).
- `feature_list.json` — `db_fulfillment` status `in_progress` → `in_review`.

**Removed:** `apps/fulfillment/src/infrastructure/.gitkeep` (directory now
has real content, same as `db_orders` did for `apps/orders`).

**Not touched:** `pnpm-workspace.yaml` — the catalog entries for
`drizzle-orm`, `drizzle-kit`, `mysql2`, `testcontainers`,
`@testcontainers/mysql` already exist (added by `db_orders` specifically
anticipating `db_fulfillment`/`db_billing`), so no catalog change was needed.

## Decisions

1. **Tables map 1:1 onto `specs/shared/domain-model.md` §4 (Fulfillment
   context)**, cross-checked against the task prompt's own table list —
   `stock` = `StockItem` aggregate (§4.1), `reservations` = the `Reservation`
   child entity (§4.1), `despatches` = `DespatchAdvice` aggregate root
   (§4.3), `despatch_items` = `DespatchLine` (§4.3 `lines`).
2. **No FK from `stock`/`reservations`/`despatches`/`despatch_items` to any
   Orders table.** `companyCode`, `productCode`, `retailerCode`,
   `orderReference` are `varchar` business identifiers, matching the task
   prompt's explicit instruction and CLAUDE.md § Database per service. FKs
   ARE used within `otc_fulfillment` itself: `reservations.stock_id` →
   `stock.id` (no cascade — a reservation outliving deletion of its stock row
   is a domain-layer concern, not modeled here) and `despatch_items.despatch_id`
   → `despatches.id` (`onDelete: 'cascade'`, same pattern as
   `order_items.order_id` in `db_orders`).
3. **`reservedUnits <= units` (invariant F1) is NOT a DB CHECK constraint** —
   recorded explicitly in `stock.schema.ts`'s header comment per the task
   prompt's instruction: it belongs in the `StockItem` AGGREGATE (a later,
   `"sdd": true` feature), because (a) a CHECK would also fire on legitimate
   intermediate states reachable inside a single transaction, and (b) it
   would duplicate domain logic that must already exist in the aggregate to
   produce the correct `stock.rejected.v1` fact instead of a raw DB error —
   citing CLAUDE.md's Clean Architecture layering ("invariants live in the
   domain, not the schema").
4. **`reservations.status` and `stock`/`despatches` timestamps follow the
   `orders.status` precedent exactly**: `varchar(20)` + a `$type<...>()`
   TS-side mirror (`ReservationStatusRow`), NOT a MySQL ENUM — same reasoning
   as `db_orders` (adding a status value must never be an `ALTER TABLE`; the
   domain owns the state machine, domain-model.md §4.2).
5. **`outbox` and `processed_events` are copied verbatim** from
   `apps/orders/.../schema/{outbox,processed-events}.schema.ts` — same
   columns, same unique constraints (`outbox.event_id` unique,
   `processed_events` unique on `(event_id, consumer)`), same
   `(published_at, occurred_at)` index, same "no `updated_at`" reasoning for
   `processed_events` (append-only ledger). No `causation_id` column, per
   the task's explicit instruction — that decision belongs to feature 14
   (`outbox_and_idempotency`, id 14) and must land in all three service DBs
   together, per `progress/review_db_orders.md` advisory #1, which this
   feature does not attempt to pre-empt.
6. **`reservations` gets an extra index beyond the literal task table
   description**: `idx_reservations_order_status` on
   `(order_reference, status)` — the task prompt itself specifies this
   ("Index `(order_reference, status)`"), so it is not a deviation, just
   flagging it mirrors the `orders` table's precedent of indexing the
   columns the saga/compensation queries actually filter by (domain-model.md
   §4.2: compensation releases "every reservation of this order still in
   status reserved"; despatch idempotency (F8) checks "has this order
   already been consumed").
7. **`stock` unique constraint is `uniqueIndex('uq_stock_company_product')`
   on `(company_code, product_code)`**, matching the task's explicit
   "unique(`company_code`, `product_code`)" instruction and domain-model.md
   §4.1 ("`productCode` — Unique together with `companyCode`").
8. **Same integration-vs-quality gate split as `db_orders`**:
   `vitest.config.mts` excludes `*.integration.spec.ts`; a dedicated
   `vitest.integration.config.mts` + `test:integration` script runs against
   Testcontainers. `pnpm quality` stays fast and Docker-independent.
9. **`drizzle-kit push` never used**, only `drizzle-kit generate` followed by
   the project's own migrator (`runFulfillmentMigrations`) — same as
   `db_orders`.
10. **Migration filename kept as drizzle-kit's own auto-generated name**
    (`0000_nappy_mad_thinker.sql`), same convention `db_orders` followed
    (`0000_bizarre_champions.sql`) — not renamed for readability, since the
    filename carries no semantic meaning and renaming would just be
    inconsistent with the sibling service.

## Traceability

`db_fulfillment` is not `"sdd": true` and owns no `R<n>` in
`specs/shared/test-matrix.md` (same as `db_orders` — R30–R36, the Fulfillment
requirements, belong to the later `fulfillment_aggregate`/saga features that
exercise this schema's behaviour). No test-matrix.md row was touched.

Tests written here map to this feature's own acceptance criteria:

| Acceptance (`feature_list.json` #10) | Test |
|---|---|
| "migrations run from empty" | `migrations.integration.spec.ts` › *applies the committed migrations from empty and creates all 6 tables plus drizzle's own migrations table* |
| "round-trip integration test per table" | `migrations.integration.spec.ts` › *round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling* |
| (reliability, beyond acceptance, same as `db_orders`) | *rejects a duplicate event_id in outbox*; *rejects a duplicate (event_id, consumer) pair in processed_events*; *(published_at, occurred_at) index exists on outbox* |
| (fulfillment-specific reliability, beyond acceptance) | *rejects a duplicate (company_code, product_code) pair in stock — one StockItem per product per supplier* (with a same-product-different-company sanity check, proving the constraint is the composite pair); *(order_reference, status) index exists on reservations*; *cascade-deletes despatch_items when the parent despatch is deleted* |

## Verification (real output)

**1. `pnpm --filter @otc/fulfillment db:migrate` against the running compose
MySQL:**
```
$ pnpm --filter @otc/fulfillment run db:migrate
[fulfillment] migrations applied against localhost:3306/otc_fulfillment

$ docker exec otc-mysql mysql -uotc_app -p... -e "SHOW TABLES;" otc_fulfillment
Tables_in_otc_fulfillment
__drizzle_migrations
despatch_items
despatches
outbox
processed_events
reservations
stock
```
7 tables total — the 6 from the spec plus drizzle's own migrations ledger.
One migration file: `apps/fulfillment/drizzle/0000_nappy_mad_thinker.sql`.

**2. Integration test green:**
```
$ pnpm --filter @otc/fulfillment run test:integration
 RUN  v4.1.11 .../apps/fulfillment
 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  12.51s
```

**3. `pnpm run quality` (root):**
```
$ pnpm run quality
... lint: eslint . → clean
... typecheck: all 9 workspace projects → Done (incl. apps/fulfillment)
... test: all 9 workspace projects → passed (apps/fulfillment: 1 file, 1 test — the pre-existing app.controller.spec.ts; integration spec correctly excluded)
```

**4. Domain purity:**
```
$ grep -rn "drizzle|mysql2|persistence" apps/*/src/domain/
(no matches — exit 1)
```
`eslint.config.mjs`'s domain-purity rule is unmodified; none of this
feature's files are under any `src/domain/`.

**5. `./init.sh`:** exit 0, confirms `db_fulfillment` was the (sole)
`in_progress` feature going in.

## What I could not do / deferred

- The `StockItem`/`Reservation`/`DespatchAdvice` aggregates and invariants
  F1–F8 are `fulfillment_aggregate` (a later, `"sdd": true` feature) — this
  feature only builds the tables those aggregates will persist to.
- No repository classes / ports were written — `client.ts` is the connection
  factory a later feature builds repositories on top of, same scope boundary
  as `db_orders`.
- The outbox relay and idempotent-consumer runtime behaviour is
  `outbox_and_idempotency` (feature id 14) — this feature only builds the
  table + constraints it runs against, identical to `apps/orders`.

## What surprised me

Nothing — following `db_orders`' file-for-file pattern (same connection
plumbing shape, same test shape, same package.json script names) meant the
schema was correct on the first `drizzle-kit generate`, so — unlike
`db_orders` — there was no need to delete and regenerate `0000_*`. The one
judgment call was invariant F1 (`reservedUnits <= units`): the task prompt
already told me not to add a CHECK and to record why, so I did, citing the
same domain-purity/layering argument the prompt itself uses, plus the
concrete reason (legitimate multi-statement intermediate states inside one
transaction) so the reasoning survives review independent of the prompt.
