# impl_db_billing

**Feature:** `db_billing` (id 11, phase 6)
**Status set to:** `in_review`

## What this is

Drizzle ORM schema + one committed SQL migration for the `otc_billing`
database, inside `apps/billing/src/infrastructure/persistence/`, plus a
Testcontainers integration test proving the migration applies from empty and
every table round-trips (this feature's two acceptance criteria in
`feature_list.json`). `db_billing` is `"sdd": false`, so implementation
followed the acceptance list + the task prompt's "Tables" section directly —
no `specs/db_billing/`. The task explicitly required following the patterns
set by `db_orders` (feature 9) and `db_fulfillment` (feature 10, both
approved) — this report calls out every place that pattern was followed or
deliberately adapted for Billing.

## Files touched

**New — schema (infrastructure layer only, `src/domain` untouched):**
- `apps/billing/src/infrastructure/persistence/schema/credits.schema.ts`
- `apps/billing/src/infrastructure/persistence/schema/credit-items.schema.ts`
- `apps/billing/src/infrastructure/persistence/schema/invoices.schema.ts`
- `apps/billing/src/infrastructure/persistence/schema/invoice-items.schema.ts`
- `apps/billing/src/infrastructure/persistence/schema/payments.schema.ts`
- `apps/billing/src/infrastructure/persistence/schema/outbox.schema.ts`
- `apps/billing/src/infrastructure/persistence/schema/processed-events.schema.ts`
- `apps/billing/src/infrastructure/persistence/schema/index.ts` (barrel)

**New — connection/migration plumbing (mirrors `apps/orders`/`apps/fulfillment` file-for-file):**
- `apps/billing/src/infrastructure/persistence/db-config.ts` —
  `loadBillingDbConfig`, reads `BILLING_DB_HOST` + the shared `MYSQL_*` vars.
- `apps/billing/src/infrastructure/persistence/client.ts` —
  `createBillingPool` / `createBillingDb`.
- `apps/billing/src/infrastructure/persistence/migrator.ts` —
  `runBillingMigrations(config)`, used by both the CLI script and the
  integration test.
- `apps/billing/src/infrastructure/persistence/migrate-cli.ts` — CLI entry
  point for `db:migrate`.
- `apps/billing/drizzle.config.ts` — `drizzle-kit generate` config.
- `apps/billing/drizzle/0000_brown_hammerhead.sql` + `apps/billing/drizzle/meta/`
  — the one committed migration (generated once via `drizzle-kit generate`,
  correct on the first pass).

**New — tests:**
- `apps/billing/src/infrastructure/persistence/migrations.integration.spec.ts`
  — Testcontainers (`@testcontainers/mysql`, image `mysql:8.4.11`, same
  pinned tag as `docker-compose.infra.yml` and the sibling DB features).
- `apps/billing/vitest.integration.config.mts` — separate Vitest project for
  `*.integration.spec.ts`, 120s test/hook timeouts (same shape as
  `apps/orders`/`apps/fulfillment`).

**Modified:**
- `apps/billing/vitest.config.mts` — excludes `*.integration.spec.ts`.
- `apps/billing/package.json` — added `drizzle-orm`, `mysql2` (deps);
  `drizzle-kit`, `testcontainers`, `@testcontainers/mysql` (devDeps); scripts
  `db:generate`, `db:migrate`, `test:integration`.
- `package.json` (root) — `db:generate:billing`, `db:migrate:billing`
  convenience scripts (root `test:integration` already aggregates every
  workspace's `test:integration` via `pnpm -r --if-present`, so no change
  needed there).
- `.env.example` / `.env` — added `BILLING_DB_HOST=localhost` (same pattern
  as `ORDERS_DB_HOST`/`FULFILLMENT_DB_HOST`; `MYSQL_DB_BILLING` and the grant
  for it already existed in `.env.example` /
  `infra/mysql/init/01-create-databases.sh` from the `infra_compose`
  feature, so nothing needed there).
- `feature_list.json` — `db_billing` status `pending` → `in_review`.

**Removed:** `apps/billing/src/infrastructure/.gitkeep` (directory now has
real content, same as `db_orders`/`db_fulfillment` did for their apps).

**Not touched:** `pnpm-workspace.yaml` — the catalog entries for
`drizzle-orm`, `drizzle-kit`, `mysql2`, `testcontainers`,
`@testcontainers/mysql` already exist (added by `db_orders` anticipating
`db_fulfillment`/`db_billing`), so no catalog change was needed.

## Decisions

1. **Tables map 1:1 onto `specs/shared/domain-model.md` §5 (Billing
   context)** and the task prompt's own table list — `credits` = the
   `BuyerCredit` aggregate root (§5.1), `credit_items` = the append-only
   `CreditLedgerEntry` ledger (§5.1 `entries`), `invoices` = the `Invoice`
   aggregate root (§5.2, INVOIC), `invoice_items` = `InvoiceLine` (§5.2
   `lines`), `payments` = the `Payment` child entity (§5.2, the remittance).
2. **No FK from any billing table to any Orders/Fulfillment table.**
   `retailerCode`, `companyCode`, `orderReference`, `productCode` are plain
   `varchar` business identifiers, matching the task's explicit instruction
   and CLAUDE.md § Database per service. FKs ARE used within `otc_billing`
   itself: `credit_items.credit_id` → `credits.id` (no cascade — same
   append-only-ledger-outliving-parent-row deliberation as
   `reservations.stock_id` in `db_fulfillment`), `invoice_items.invoice_id`
   → `invoices.id` (`onDelete: 'cascade'`, same pattern as
   `order_items.order_id` / `despatch_items.despatch_id`), and
   `payments.invoice_id` → `invoices.id` (no cascade — a payment record must
   never silently disappear if an invoice row were ever deleted; deleting
   invoices is not a domain operation this schema anticipates).
3. **Invariant B1** (`Σ(active holds) + Σ(open invoice exposure) ≤
   creditLimit`) **is NOT a DB CHECK constraint** — recorded explicitly in
   `credits.schema.ts`'s header comment. Unlike a single-row invariant, B1 is
   a *derived quantity over the whole `credit_items` ledger for an order*
   (domain-model.md §5.1 "Derived quantities"), so no CHECK on `credits`
   itself could even express it; it belongs in the `BuyerCredit` AGGREGATE (a
   later, `"sdd": true` feature), same layering argument as `db_fulfillment`'s
   invariant F1 (`reservedUnits <= units`).
4. **`credit_items.type`, `invoices.status`, `payments.source` are
   `varchar(20)` + a `$type<...>()` TS-side mirror**, NOT MySQL ENUMs — same
   precedent as `orders.status` / `reservations.status`: the domain owns the
   set of legal values (`hold | release | consume`, `issued | paid`,
   `operator | robot | test`) and growing it must never be an `ALTER TABLE`.
5. **`payments.source` uses `robot`, not `n8n`**, per the task prompt's
   explicit instruction — an already-approved spec decision that provenance
   of a remittance is a *role* (who/what triggered it), not the name of
   whichever automation tool happens to play that role in this repository.
6. **`outbox` and `processed_events` are copied verbatim** from
   `apps/orders`/`apps/fulfillment`'s equivalents — same columns, same
   unique constraints (`outbox.event_id` unique, `processed_events` unique
   on `(event_id, consumer)`), same `(published_at, occurred_at)` index, same
   "no `updated_at`" reasoning for `processed_events`. No `causation_id`
   column, per the task's explicit instruction — that decision belongs to
   feature 14 (`outbox_and_idempotency`) and must land in all three service
   DBs together, per `progress/review_db_orders.md` advisory #1 (already
   honoured identically by `db_fulfillment`).
7. **`payments` has no `updated_at`** — the task prompt itself carves this
   out ("all: ... except `payments`: `created_at` only"), consistent with
   B10/§5.2: a remittance is recorded once at intake and never mutated, the
   same append-only reasoning already used for `processed_events`.
8. **`credits` unique constraint is `uniqueIndex('uq_credits_retailer_company')`
   on `(retailer_code, company_code)`**, matching the task's explicit
   "unique(`retailer_code`, `company_code`)" instruction and
   domain-model.md §5.1 ("One credit line per (retailerCode, companyCode)
   pair").
9. **`credit_items` gets `idx_credit_items_credit_order` on
   `(credit_id, order_reference)`**, exactly the task's own instruction
   ("Index `(credit_id, order_reference)`"), justified against the
   activeHold/openExposure derivation and B4 ("at most one active hold per
   orderReference") — both filter the ledger by this pair.
10. **`invoices.invoice_reference` and `payments.payment_reference` are each
    a plain `.unique()`** (not composite) — matching the task's explicit
    "unique" instruction per column and domain-model.md B7 (exactly one
    invoice per orderReference is an aggregate-level invariant, not a
    (invoice_reference, X) DB pair) / B10 (payment_reference alone is the
    idempotency key of the remittance intake).
11. **Same integration-vs-quality gate split as the siblings**:
    `vitest.config.mts` excludes `*.integration.spec.ts`; a dedicated
    `vitest.integration.config.mts` + `test:integration` script runs against
    Testcontainers. `pnpm quality` stays fast and Docker-independent.
12. **`drizzle-kit push` never used**, only `drizzle-kit generate` followed by
    the project's own migrator (`runBillingMigrations`) — same as
    `db_orders`/`db_fulfillment`.
13. **Migration filename kept as drizzle-kit's own auto-generated name**
    (`0000_brown_hammerhead.sql`), not renamed for readability — same
    convention the two sibling features followed.

## Traceability

`db_billing` is not `"sdd": true` and owns no `R<n>` in
`specs/shared/test-matrix.md` (same as `db_orders`/`db_fulfillment` — the
Billing requirements belong to the later `billing_aggregate`/`invoice`/saga
features that exercise this schema's behaviour). No test-matrix.md row was
touched.

Tests written here map to this feature's own acceptance criteria:

| Acceptance (`feature_list.json` #11) | Test |
|---|---|
| "migrations run from empty" | `migrations.integration.spec.ts` › *applies the committed migrations from empty and creates all 7 tables plus drizzle's own migrations table* |
| "round-trip integration test per table" | `migrations.integration.spec.ts` › *round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling* |
| (reliability, beyond acceptance, same convention as the siblings) | *rejects a duplicate (retailer_code, company_code) pair in credits* (with a same-retailer-different-company sanity check); *rejects a duplicate invoice_reference in invoices*; *rejects a duplicate payment_reference in payments*; *rejects a duplicate event_id in outbox*; *rejects a duplicate (event_id, consumer) pair in processed_events* (with a same-event-different-consumer sanity check); *(published_at, occurred_at) index exists on outbox*; *(credit_id, order_reference) index exists on credit_items*; *cascade-deletes invoice_items when the parent invoice is deleted* |

## Verification (real output)

**1. `pnpm --filter @otc/billing db:migrate` against the running compose MySQL:**
```
$ pnpm --filter @otc/billing run db:migrate
[billing] migrations applied against localhost:3306/otc_billing

$ docker exec otc-mysql mysql -uotc_app -p... -e "SHOW TABLES;" otc_billing
Tables_in_otc_billing
__drizzle_migrations
credit_items
credits
invoice_items
invoices
outbox
payments
processed_events
```
8 tables total — the 7 from the spec plus drizzle's own migrations ledger.
One migration file: `apps/billing/drizzle/0000_brown_hammerhead.sql`.

**2. Integration test green:**
```
$ pnpm --filter @otc/billing run test:integration
 RUN  v4.1.11 .../apps/billing
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  15.12s
```

**3. `pnpm run quality` (root):**
```
$ pnpm run lint            → clean
$ pnpm run typecheck       → all 9 workspace projects, Done (incl. apps/billing)
$ pnpm --filter '!@otc/contracts' -r run test
                            → all 8 remaining workspaces pass, incl.
                              apps/billing (1 file, 1 test — the pre-existing
                              app.controller.spec.ts; integration spec
                              correctly excluded)
```
`pnpm run test` for the full workspace set also fails **one** unrelated,
pre-existing test — `packages/contracts` › `scripts/check.spec.ts` ›
*"exits 0 and prints OK against the real committed files"* — a `spawnSync`
of a cold `tsx` process that exceeds the suite's 5000ms default test timeout
under load on this machine. Confirmed **not** caused by this feature: `git
status`/`git diff` show `packages/contracts` completely untouched by
`db_billing`, and re-running just that one test with
`--testTimeout 30000` passes in ~4.9s — a pure timeout flake, not a logic
failure, on a package this feature never touches.

**4. Domain purity:**
```
$ grep -rEn "drizzle|mysql2|@nestjs|kafkajs|nats|mongodb|persistence" apps/*/src/domain/
(no matches — exit 1)
```
`eslint.config.mjs`'s domain-purity rule is unmodified; none of this
feature's files are under any `src/domain/`.

**5. `./init.sh`:** exit 0, confirms `db_billing` was the (sole)
`in_progress` feature going in.

## What I could not do / deferred

- The `BuyerCredit`/`Invoice`/`Payment` aggregates and invariants B1–B10 are
  `billing`-context, `"sdd": true` features scheduled later — this feature
  only builds the tables those aggregates will persist to.
- No repository classes / ports were written — `client.ts` is the connection
  factory a later feature builds repositories on top of, same scope boundary
  as `db_orders`/`db_fulfillment`.
- The outbox relay and idempotent-consumer runtime behaviour is
  `outbox_and_idempotency` (feature id 14) — this feature only builds the
  table + constraints it runs against, identical to the two sibling DBs.
- The unrelated `packages/contracts` timeout flake described above was not
  touched or "fixed" — it is out of scope for a single-feature change and the
  package is untouched by this diff.

## What surprised me

Nothing about the schema itself — following the `db_orders`/`db_fulfillment`
file-for-file pattern meant the schema was correct on the first
`drizzle-kit generate`. The one judgment call, flagged in Decisions §3, was
that invariant B1 is structurally different from `db_fulfillment`'s F1: F1 is
a same-row invariant a CHECK *could* theoretically express (even though it
shouldn't, per that feature's own reasoning); B1 is a derived sum over an
entire ledger for one `orderReference`, which no single-table CHECK
constraint could express even in principle — reinforcing, rather than just
repeating, the "invariants live in the aggregate" rule.
