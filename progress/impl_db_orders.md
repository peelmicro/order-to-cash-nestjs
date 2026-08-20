# impl_db_orders

**Feature:** `db_orders` (id 9, phase 6)
**Status set to:** `in_review`

## What this is

Drizzle ORM schema + committed SQL migration(s) for the `otc_orders` database,
inside `apps/orders/src/infrastructure/persistence/`, plus a Testcontainers
integration test proving the migrations apply from empty and every table
round-trips (the feature's two acceptance criteria in `feature_list.json`).
`db_orders` is not `"sdd": true`, so implementation followed the acceptance
list + the "Tables (authoritative shapes)" section of the task prompt
directly (there is no `specs/db_orders/`).

## Files touched

**New — schema (infrastructure layer only, `src/domain` untouched):**
- `apps/orders/src/infrastructure/persistence/schema/currencies.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/products.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/retailers.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/companies.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/orders.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/order-items.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/outbox.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/processed-events.schema.ts`
- `apps/orders/src/infrastructure/persistence/schema/index.ts` (barrel, feeds
  both `drizzle-kit generate` and the Drizzle client factory)

**New — connection/migration plumbing:**
- `apps/orders/src/infrastructure/persistence/db-config.ts` — reads
  `ORDERS_DB_HOST` + the existing `MYSQL_*` vars into one config object
  (no `DATABASE_URL`: dotenv doesn't interpolate one var inside another, and
  the individual vars are already the single source of truth shared with
  `docker-compose.infra.yml` / `infra/mysql/init/01-create-databases.sh`).
- `apps/orders/src/infrastructure/persistence/client.ts` — Drizzle client
  factory (`createOrdersPool` / `createOrdersDb`) for future repositories.
- `apps/orders/src/infrastructure/persistence/migrator.ts` —
  `runOrdersMigrations(config)`, the one migration runner used by both the
  CLI script and the integration test.
- `apps/orders/src/infrastructure/persistence/migrate-cli.ts` — CLI entry
  point for `db:migrate`.
- `apps/orders/drizzle.config.ts` — `drizzle-kit generate` config (mysql
  dialect, schema barrel, `out: ./drizzle`).
- `apps/orders/drizzle/0000_bizarre_champions.sql` + `apps/orders/drizzle/meta/`
  — the committed migration (one file; regenerated once after a schema fix,
  see "What surprised me").

**New — tests:**
- `apps/orders/src/infrastructure/persistence/migrations.integration.spec.ts`
  — Testcontainers (`@testcontainers/mysql`, image `mysql:8.4.11`, the SAME
  pinned tag `docker-compose.infra.yml` uses).
- `apps/orders/vitest.integration.config.mts` — separate Vitest project for
  integration specs (`*.integration.spec.ts`), 120s test/hook timeouts.

**Modified:**
- `apps/orders/vitest.config.mts` — excludes `*.integration.spec.ts` so
  `pnpm test`/`pnpm quality` stay fast and Docker-independent.
- `apps/orders/package.json` — added `drizzle-orm`, `mysql2` (deps);
  `drizzle-kit`, `testcontainers`, `@testcontainers/mysql` (devDeps); scripts
  `db:generate`, `db:migrate`, `test:integration`.
- `pnpm-workspace.yaml` — catalog entries for the five packages above (used
  by `apps/orders` now, and by `db_fulfillment`/`db_billing` later — same
  stack, same pins); `allowBuilds` gained `cpu-features`/`protobufjs`/`ssh2`
  (transitive native/build deps of `dockerode`, which `testcontainers` uses;
  approved the same way `esbuild` already was).
- `package.json` (root) — convenience scripts `db:generate:orders`,
  `db:migrate:orders`, and a root `test:integration` aggregate.
- `.env.example` / `.env` — added `ORDERS_DB_HOST=localhost` (host the
  migration runner/future app connect to when run from the CLI against the
  compose MySQL, which publishes `MYSQL_HOST_PORT` on localhost).
- `feature_list.json` — `db_orders` status `in_progress` → `in_review`.

**Removed:** `apps/orders/src/infrastructure/.gitkeep` (directory now has
real content).

## Decisions

1. **`status` is `varchar(20)`, not a MySQL `ENUM`.** Per the task prompt
   explicitly: adding a status value must never be an `ALTER TABLE`. The
   domain owns the state machine (`specs/shared/domain-model.md` Table T-1);
   `OrderStatusRow` in `orders.schema.ts` is a TS-side mirror for this
   infrastructure layer only, documented in the file's header comment as
   tracking the domain's own type, never the reverse.
2. **`processed_events` gained a `created_at` column beyond the field list
   literally enumerated in the task prompt.** The prompt states a blanket
   rule up front — "All tables: `id` char(36) UUID PK, `created_at` datetime,
   and `updated_at` datetime where noted" — and the per-table field lists
   don't restate `id` either (yet obviously every table needs it, including
   `processed_events`, whose own list also omits `id`). Reading the blanket
   rule as literally universal, I added `created_at` to `processed_events`
   alongside the domain-meaningful `processed_at` (which is not renamed, per
   the prompt), with no `updated_at` (the ledger is append-only). Flagging
   this explicitly in case the reviewer reads "authoritative shapes" as the
   literal, closed field list per table instead — it's a one-line fix either
   way (`processed-events.schema.ts` + regenerate).
3. **`outbox` has `created_at` but no `updated_at`**, matching the prompt's
   explicit field list for that table (`created_at` only) — consistent with
   the row being append-only except for the later `published_at` stamp
   (R14 in `specs/shared/requirements.md`, implemented by the
   `outbox_and_idempotency` feature, not this one).
4. **No `DATABASE_URL` env var.** Individual `MYSQL_*` parts + new
   `ORDERS_DB_HOST` instead — see "Files touched" above. `dbCredentials` in
   `drizzle.config.ts` and `db-config.ts` both read the same parts.
5. **Integration tests are a separate gate, not part of `pnpm quality`.**
   `vitest.config.mts` excludes `*.integration.spec.ts`; a dedicated
   `vitest.integration.config.mts` + `test:integration` script runs them
   against Testcontainers (needs Docker, takes ~15-20s). `pnpm quality`
   (lint + typecheck + `pnpm test`) therefore stays fast and
   Docker-independent, matching the existing `apps/*/test` scripts' speed.
   This is the convention `db_fulfillment`/`db_billing` (phase 6, same
   shape) should reuse — same two-config split, same script names.
6. **`drizzle-kit push` is never used**, only `drizzle-kit generate` (in
   `db:generate`) followed by the project's own migrator (`runOrdersMigrations`,
   used identically by `db:migrate` and the integration test) — the committed
   SQL under `apps/orders/drizzle/` is the one source of truth for the DB
   shape, per the task prompt.
7. **FKs within `otc_orders` are used freely** (`order_items.order_id` →
   `orders.id` cascade delete, `orders.company_id/retailer_id/currency_id`,
   `products.currency_id`, etc.) — all within this one service's database,
   never across a service boundary (CLAUDE.md § Database per service).

## Traceability

`db_orders` is not `"sdd": true` and owns no `R<n>` in
`specs/shared/test-matrix.md` — the rows that mention outbox/processed_events
shape (R13, R14, R17) belong to the `outbox_and_idempotency` feature (id 14,
phase 8), which will exercise this schema's *behaviour* (transactional
writes, the relay, dedup logic); this feature only proves the schema and
migrations exist and are correct. No test-matrix.md row was touched.

Tests written here map to this feature's own acceptance criteria:

| Acceptance (`feature_list.json` #9) | Test |
|---|---|
| "migrations run from empty" | `migrations.integration.spec.ts` › *applies the committed migrations from empty and creates all 8 tables plus drizzle's own migrations table* |
| "round-trip integration test per table via Testcontainers" | `migrations.integration.spec.ts` › *round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling* |
| Spec §"Integration test" bullet 3 — reliability constraints bite | `migrations.integration.spec.ts` › *rejects a duplicate event_id in outbox* and › *rejects a duplicate (event_id, consumer) pair in processed_events* (plus a sanity assertion that a different consumer with the same eventId IS accepted, proving the constraint is the composite pair) |
| Spec §"Integration test" bullet 4 — `(published_at, occurred_at)` index exists | `migrations.integration.spec.ts` › *asserts the (published_at, occurred_at) index exists on outbox — the relay poll must be an index scan* |

## Verification (real output)

**1. `pnpm --filter @otc/orders db:migrate` against the running compose MySQL:**
```
$ pnpm run db:migrate
[orders] migrations applied against localhost:3306/otc_orders

$ docker exec otc-mysql mysql -uotc_app -p... -e "SHOW TABLES;" otc_orders
Tables_in_otc_orders
__drizzle_migrations
companies
currencies
order_items
orders
outbox
processed_events
products
retailers
```
9 tables total — the 8 from the spec plus drizzle's own migrations ledger.

**2. Integration test green:**
```
$ pnpm --filter @otc/orders run test:integration
 RUN  v4.1.11 .../apps/orders
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  17.67s
```

**3. Duplicate-insert rejections (from the same run, both assertions passed):**
- `outbox`: inserting a second row with a reused `event_id` throws
  `DrizzleQueryError` whose `.cause.code === 'ER_DUP_ENTRY'`
  (`Duplicate entry '<uuid>' for key 'outbox.outbox_event_id_unique'`).
- `processed_events`: inserting a second `(event_id, consumer)` pair throws
  the same way against `processed_events.uq_processed_events_event_consumer`;
  the same `event_id` with a *different* consumer is accepted (sanity check
  that the constraint is the pair, not `event_id` alone).

**4. `pnpm quality` (root):**
```
$ pnpm run quality
... lint: eslint . → clean
... typecheck: all 9 workspace projects → Done
... test: all 9 workspace projects → passed (apps/orders: 1 file, 1 test)
```
Green on a clean re-run. One earlier run showed an unrelated flaky timeout in
`packages/contracts` (`scripts/generate.spec.ts` › *run as a CLI...*, a
subprocess-spawning test hitting Vitest's 5s default under concurrent
`pnpm -r` load) — reproduced in isolation as passing
(`pnpm --filter @otc/contracts run test` → 5 files, 22 tests, all green), so
it is pre-existing flakiness under load, not a regression from this feature;
not touched, per "do not touch other apps' folders".

ESLint domain-purity rule: untouched, still passing — none of this feature's
new files are under any `src/domain/`, and `eslint.config.mjs`'s
`no-restricted-imports` block for `apps/*/src/domain/**` was not modified.

**5. `./init.sh`:** exit 0 (harness/backlog coherence green; 1
feature `in_progress` before this report, `progress/current.md` unmodified by
me — its diff predates this session).

## What I could not do / deferred

- The outbox **relay** and **idempotent-consumer** runtime behaviour (write
  aggregate + outbox in one transaction, poll-and-publish, stamp
  `publishedAt`, dedupe on `(eventId, consumer)`) is explicitly
  `outbox_and_idempotency` (feature id 14, phase 8, `"sdd": true`) — this
  feature only builds the tables and constraints that behaviour will run
  against, per the task's own scope ("Drizzle ORM schema + committed SQL
  migrations... plus a Testcontainers integration test proving the
  migrations run from empty and every table round-trips").
- No repository classes / ports were written — `client.ts` is the connection
  factory future features will build repositories on top of; writing
  repositories is out of this feature's scope (no aggregate exists yet —
  `orders_aggregate` is feature id 13, phase 8).

## What surprised me

Regenerating the migration mid-session (after realizing `processed_events`
should carry a blanket `created_at`, decision #2 above) meant dropping the
compose database's tables and re-running `db:migrate` from a clean file —
straightforward here since nothing else depends on the migration history yet,
but worth calling out for `db_fulfillment`/`db_billing`: get the schema right
*before* the first `db:generate`, since drizzle's migration folder is meant
to be an append-only, reviewable history from here on, and I intentionally
deleted+regenerated `0000_*` rather than adding a `0001_*` for a same-day,
not-yet-reviewed fix.
