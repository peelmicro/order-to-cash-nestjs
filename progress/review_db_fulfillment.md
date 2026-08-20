# review_db_fulfillment

**Feature:** `db_fulfillment` (id 10, phase 6) — Drizzle schema + migrations for `otc_fulfillment`
**Reviewer verdict:** **APPROVED** (first pass, 0 blocking defects, 1 new advisory for `fulfillment_aggregate`, feature-14 advisories inherited by design)
**Date:** 2026-08-20

---

## Probes run (real output, not the implementer's report)

### 1. Integration test — re-run independently

```
$ pnpm --filter @otc/fulfillment run test:integration
 RUN  v4.1.11 .../apps/fulfillment
 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  12.82s
```

8/8 green against a **disposable Testcontainers `mysql:8.4.11`** (same pinned
tag as `docker-compose.infra.yml` and db_orders). The spec connects via
`container.getHost()/getPort()` — never the compose instance on 3306.

### 2. Cross-service purity — the headline rule, read from the committed SQL

`apps/fulfillment/drizzle/0000_nappy_mad_thinker.sql` contains exactly **two**
`FOREIGN KEY` clauses, both internal to `otc_fulfillment`:

- `reservations.stock_id` → `stock.id` (no action — deliberate, documented in
  `reservations.schema.ts` and impl Decisions §2)
- `despatch_items.despatch_id` → `despatches.id` (`ON DELETE cascade`, same
  pattern as `order_items.order_id`)

No reference of any kind to orders/billing tables. `company_code` (varchar 20),
`retailer_code` (varchar 20), `product_code` (varchar 30), `order_reference`
(varchar 20) are plain varchars — and the lengths **match the orders schema
byte-for-byte** (`companies.code`/`retailers.code` varchar(20), `products.code`
varchar(30), `orders.order_reference` varchar(20)), so the business identifiers
carried in messages fit both sides. ✅

### 3. Outbox / processed_events parity with db_orders

Extracted both `CREATE TABLE` blocks from each service's committed migration
and diffed them: **byte-identical** — every column (`id`, `event_id`,
`event_type` varchar(60), `aggregate_id`, `correlation_id`, `payload` json,
`occurred_at`, `published_at` nullable, `created_at` / `id`, `event_id`,
`consumer` varchar(50), `processed_at`, `created_at`), both PRIMARY KEYs, both
uniques (`outbox_event_id_unique`, `uq_processed_events_event_consumer`), and
the `idx_outbox_published_occurred (published_at, occurred_at)` index. ✅

`causation_id` correctly **NOT** added — grep over `apps/fulfillment/` finds it
only in `outbox.schema.ts`'s comment explaining the deferral to feature 14
(`outbox_and_idempotency`), where the decision lands for all three DBs together
per `review_db_orders.md` advisory #1. ✅

### 4. The no-DB-CHECK decision for F1 (`reserved_units <= units`)

Recorded in `stock.schema.ts:7–17` with the required rationale: the invariant
lives in the `StockItem` aggregate (the one place that can see the whole ledger
operation atomically and produce `stock.rejected.v1` instead of a raw DB
error), plus the concrete reason that a CHECK would fire on legitimate
intermediate states inside a single transaction. Cites CLAUDE.md layering.
`grep -i check` over the migration SQL: zero constraint hits. ✅

### 5. Schema vs `specs/shared/domain-model.md` §4 — column by column

**`stock`** (§4.1 `StockItem`): `id` char(36) PK; `company_code`,
`product_code` varchar NOT NULL; `units`, `reserved_units`,
`low_stock_threshold` int NOT NULL (integer quantities, never decimal —
`grep -i decimal` over the SQL: zero hits); `created_at`/`updated_at`
`datetime` NOT NULL; `uq_stock_company_product UNIQUE(company_code,
product_code)` = §4.1 "productCode — Unique together with companyCode". ✅

**`reservations`** (§4.1 child entity): `stock_id` local FK; `company_code`,
`retailer_code`, `product_code`, `order_reference` NOT NULL varchars; `units`
int; `status` **varchar(20), NOT a MySQL ENUM**, with the TS-side union
`ReservationStatusRow = 'reserved' | 'released' | 'consumed'` via `$type<>`
(`reservations.schema.ts:15–17,31`) — exactly §4.1's value set, same
no-ENUM reasoning as `orders.status`. `idx_reservations_order_status
(order_reference, status)` present in the SQL (line 77) and justified against
the actual compensation/idempotency queries (§4.2, F8). ✅

**`despatches`/`despatch_items`** (§4.3): `despatch_reference` unique
(DES-######), `despatch_date` datetime, business identifiers, ≥1-line and F7/F8
behaviours correctly left to the aggregate. All temporal columns `datetime`,
UTC at the client (`timezone: 'Z'`). Nullability: only `outbox.published_at`
nullable — correct; the fulfillment context has no optional fields. ✅

### 6. Test assertion quality

- Round-trip test is **field-level** (`toMatchObject` over every column +
  explicit `getTime()` equality on datetimes), all 6 tables, including deep
  `toEqual` on a nested outbox JSON payload with an array (spec `:210–236`).
  No row counts, no vacuous assertions.
- Same datetime honesty as db_orders: millisecond truncation before insert
  with an explanatory comment (`:114–116`) — DATETIME(0) second precision is
  acknowledged, not papered over.
- Three duplicate-rejections are genuine: `stock (company_code, product_code)`
  dup rejected with `ER_DUP_ENTRY` **and** same product / different company
  accepted (proves the composite, `:256–298`); `outbox.event_id` dup rejected
  (`:300–330`); `processed_events (event_id, consumer)` dup rejected and same
  event / different consumer accepted (`:332–366`).
- Cascade-delete genuinely asserted: parent despatch deleted → child row
  selected back → `toHaveLength(0)` (`:368–399`).
- Both index-existence tests assert exact column order via
  `information_schema.statistics`.

### 7. Gates

- `pnpm run quality` → **exit 0** (re-run by reviewer; lint clean, typecheck
  all projects, all unit suites green; fulfillment's integration spec correctly
  excluded from the default config).
- Domain purity: `grep -rEn "drizzle|mysql2|@nestjs|kafkajs|nats|mongodb|persistence" apps/*/src/domain/`
  → **zero hits**; `apps/fulfillment/src/domain/` holds only `.gitkeep`.
  ESLint domain rule unmodified.
- `./init.sh` → **exit 0**.
- No Jest anywhere in the feature's files; Vitest 4 only.
- `drizzle-kit push` never used — grep hits only the comment forbidding it;
  committed SQL + `runFulfillmentMigrations` is the single application path
  for CLI and test. `drizzle/meta/` journal + snapshot committed.
- `git status` scope: only `apps/fulfillment/**`, root `package.json`
  (two `db:*:fulfillment` scripts), `pnpm-lock.yaml`, `.env.example`
  (`FULFILLMENT_DB_HOST=localhost` — no secret, mirrors `ORDERS_DB_HOST`),
  `progress/*`, `feature_list.json`. (`apps/orders/**` etc. also dirty — the
  still-uncommitted, already-approved db_orders feature, not this one.)
  `.env` is git-ignored (`git check-ignore .env` confirms). ✅
- `pnpm-workspace.yaml` untouched by this feature, as claimed — catalog pins
  landed with db_orders.

### 8. Pattern drift vs db_orders — none

Diffed every plumbing file (`db-config.ts`, `client.ts`, `migrator.ts`,
`migrate-cli.ts`, `drizzle.config.ts`, `vitest.config.mts`,
`vitest.integration.config.mts`) modulo the service name: **only comment
wording differs** (fulfillment's comments point at the db_orders decision
records instead of restating them). `package.json` scripts and
dependencies/devDependencies blocks are **identical** to `apps/orders`.
Root scripts follow the exact `db:generate:<svc>` / `db:migrate:<svc>`
convention; root `test:integration` already aggregates. ✅

---

## Acceptance → test mapping (sdd: false — no owned R<n>; R30–R36 belong to later fulfillment features)

| Acceptance (`feature_list.json` #10) | Named test (all in `migrations.integration.spec.ts`) | Verified |
|---|---|---|
| "migrations run from empty" | *applies the committed migrations from empty and creates all 6 tables plus drizzle's own migrations table* | ✅ re-run, exact table-set assert |
| "round-trip integration test per table" | *round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling* | ✅ all 6 tables, field-level |
| (reliability, beyond acceptance) | *rejects a duplicate (company_code, product_code) pair in stock*; *rejects a duplicate event_id in outbox*; *rejects a duplicate (event_id, consumer) pair in processed_events*; both index-existence tests; *cascade-deletes despatch_items* | ✅ |

No `specs/shared/test-matrix.md` row touched — correct.

---

## CHECKPOINTS walked

**C1 — harness complete**
- [x] AGENTS.md, CLAUDE.md, CHECKPOINTS.md, feature_list.json, init.sh exist
- [x] progress/current.md and progress/history.md exist
- [x] .claude/agents/ holds all five agents
- [x] every agent declares its model
- [x] ./init.sh exits 0

**C2 — state coherent**
- [x] at most one feature in_progress (zero after this close)
- [x] every status in rules.valid_status
- [x] every done feature has passing tests (db_fulfillment: 8/8 integration re-run by reviewer)
- [x] progress/current.md describes the active session — **fixed this time**:
      it names db_fulfillment and the session goal (it lagged one transition,
      saying `in_progress` while the list said `in_review` — minor, not the
      stale-previous-session failure of the last three reviews)
- [x] no blocked features

**C3 — architecture respected**
- [x] no framework imports in any domain/ folder (ESLint rule + grep, both clean)
- [x] no cross-service DB access; both FKs internal to otc_fulfillment (read from the SQL)
- [x] no shared runtime code beyond shared-kernel and contracts
- [x] shared-kernel still zero runtime deps
- [x] no inter-service interaction added (schema-only feature); nothing to classify
- [x] no stray debug logging, no context-free TODOs

**C4 — verification real**
- [x] pnpm quality passes (re-run by reviewer, exit 0)
- [x] domain tests pure (no domain code yet; nothing violated)
- [x] integration tests use Testcontainers against real MySQL 8.4.11, no mocked store
- [x] coverage thresholds — n/a for this feature's code path (infrastructure
      schema exercised by the integration gate; no domain code to measure);
      root gates unchanged and green
- [x] no Jest anywhere (grep clean; Vitest 4 only)

**C5 — session closed cleanly**
- [x] no suspicious untracked files
- [x] history.md entry with effort record (appended by this review)
- [x] feature_list.json reflects true state (db_fulfillment → done by this review)
- [x] human told what was done + how to test manually (impl_db_fulfillment.md
      §Verification: `pnpm --filter @otc/fulfillment run test:integration`;
      `pnpm db:migrate:fulfillment` against compose MySQL then `SHOW TABLES`)
- [x] Claude did not commit

**C6 — SDD:** n/a (`"sdd": false`; no sdd feature past `todo` yet).

**C7 — trilogy reusability**
- [x] specs/shared/ untouched by this feature
- [x] n8n/ untouched
- [x] history effort records complete (incl. this entry)

---

## Defects

**Blocking: none.**

**Advisory (new, recorded for `fulfillment_aggregate` — not a defect of db_fulfillment):**

1. **F8 has no DB-level backstop.** domain-model.md §4.3 F8: "At most one
   `DespatchAdvice` per `orderReference`" — the schema uniques
   `despatch_reference` but not `order_reference`
   (`apps/fulfillment/drizzle/0000_nappy_mad_thinker.sql:38`). Unlike F1, this
   is a *static* uniqueness a DB index could race-proof: two concurrent
   despatch commands for the same order could both pass the aggregate's
   read-then-write idempotency check. The task's table shape did not include
   it, and the invariants-live-in-the-aggregate rationale covers it for this
   feature — but `fulfillment_aggregate` must decide deliberately: either add
   `UNIQUE(order_reference)` on `despatches` in a `0001_*` migration (and
   catch `ER_DUP_ENTRY` to return the existing reference, keeping F8's
   idempotent-success semantics), or document why serialization elsewhere
   makes the race impossible.

**Inherited by design (already recorded in `review_db_orders.md`, apply to
this outbox copy equally, owned by feature 14):** no `causation_id` column;
`occurred_at` DATETIME(0) needs a deterministic relay-poll tiebreak. The
verbatim copy here is correct — divergence would have been the defect.

---

## Verdict

**APPROVED.** `feature_list.json` #10 → `done`; history entry appended with
effort record.
