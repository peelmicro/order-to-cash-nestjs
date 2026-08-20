# review_db_orders

**Feature:** `db_orders` (id 9, phase 6) — Drizzle schema + migrations for `otc_orders`
**Reviewer verdict:** **APPROVED** (first pass, 0 blocking defects, 2 advisory notes for feature 14, 1 process note for the leader)
**Date:** 2026-08-20

---

## Probes run (real output, not the implementer's report)

### 1. Integration test — re-run independently

```
$ pnpm --filter @otc/orders run test:integration
 RUN  v4.1.11 .../apps/orders
 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  11.09s
```

5/5 green against a **disposable Testcontainers `mysql:8.4.11`** (same pinned
tag as `docker-compose.infra.yml`). Verified it is NOT the compose instance:
the spec connects via `container.getHost()/getPort()` (random mapped port),
never `localhost:3306`; `docker ps` before/during showed `otc-mysql` on 3306
untouched.

### 2. Schema vs conventions — read from the committed SQL (`apps/orders/drizzle/0000_bizarre_champions.sql`), the truth

Walked column-by-column for `orders`, `outbox`, `processed_events` (and
scanned the other five):

- **snake_case** everywhere (`order_reference`, `cancellation_reason`,
  `correlation_id`, `processed_at`, …). ✅
- **char(36) UUID PKs** on all 8 tables. ✅
- **Money = int minor units**: `orders.initial_amount/initial_discount/total_amount`,
  `products.price`, `order_items.price/discount` are all `int NOT NULL`.
  `grep -i decimal` over the migration: zero hits. ✅
- **`datetime`, never `timestamp`** — all temporal columns are `datetime`;
  UTC handled at the client (`timezone: 'Z'` on the mysql2 connection in the
  test; documented in the spec file, lines 44–47). ✅
- **`orders.status` is `varchar(20)`, NOT a MySQL ENUM** — adding a status
  never needs an ALTER. ✅
- **Nullability matches shapes**: `cancellation_reason`/`notes` nullable
  (present iff cancelled / free text per domain-model §3.1), `disabled_at`
  nullable on catalogue tables, `outbox.published_at` nullable (unstamped
  until broker ack, R14), everything else NOT NULL. ✅
- Business uniques: `orders.order_reference`, `currencies.code`,
  `products.code` + `products.ean`, `retailers.code`, `companies.code`. ✅

### 3. Reliability constraints — in the SQL AND proven live

In the migration SQL:
- `CONSTRAINT outbox_event_id_unique UNIQUE(event_id)` ✅
- `CONSTRAINT uq_processed_events_event_consumer UNIQUE(event_id, consumer)` ✅
- `CREATE INDEX idx_outbox_published_occurred ON outbox (published_at, occurred_at)` ✅

Proven live by the test run itself, and the assertions are not vacuous:
- duplicate `event_id` insert → `rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } })`
  (`migrations.integration.spec.ts:305–335`);
- duplicate `(event_id, consumer)` rejected AND same `event_id` with a
  *different* consumer **accepted** — proves the constraint is the composite
  pair, not `event_id` alone (`:337–371`);
- index existence asserted via `information_schema.statistics` with the exact
  column order `['published_at','occurred_at']` (`:86–98`).

### 4. Domain purity

- `grep -rn "drizzle|mysql2|persistence" apps/*/src/domain/` → **zero hits**
  (`apps/orders/src/domain/` still holds only `.gitkeep`).
- All new code lives under `src/infrastructure/persistence/`. ✅
- `pnpm run lint` → clean (the ESLint `no-restricted-imports` domain rule is
  unmodified). ✅

### 5. Migration hygiene

- `drizzle.config.ts` is generate-only (`out: ./drizzle`); **no `push`
  anywhere** — `grep push` over scripts/config: zero hits. The migrator
  (`migrator.ts` → `runOrdersMigrations`) is the single application path,
  used identically by `db:migrate` and the test. ✅
- `drizzle/meta/_journal.json` + `meta/0000_snapshot.json` are committed →
  `generate` won't renumber. ✅
- "From empty" is genuinely proven: the container has never seen a CREATE
  TABLE before `runOrdersMigrations` runs (`spec :34–42`), and the table-set
  assertion is exact (`toEqual` on all 9 names, `:64–84`).
- The mid-session delete+regenerate of `0000_*` (instead of appending
  `0001_*`) is acceptable **only** because nothing was reviewed/committed
  yet; from this approval onwards the folder is append-only history.

### 6. Round-trip fidelity

Per-table assertions are field-level (`toMatchObject` over every column plus
explicit `getTime()` equality on datetimes), not row counts. Outbox JSON
payload round-trips with deep `toEqual` on a nested object including an array
of lines (`:257–284`). No vacuous assertions found.

**Datetime precision — judgement (asked for explicitly):** the columns are
`DATETIME` (0 fsp, second precision). The test truncates milliseconds
*before* insert (`Math.floor(Date.now()/1000)*1000`, `:101–103`) and says so
in a comment — this is honest acknowledgement of the truncation, not
papering-over: the assertion would fail if the DB mangled anything beyond the
documented second-level truncation. Does the lost precision matter for the
`(published_at, occurred_at)` relay poll? **Within one second — yes, ordering
among facts written in the same second is nondeterministic**, and one
transaction routinely writes several outbox rows in the same second. My
judgement: **acceptable for this feature**, because (a) the real ordering
guarantee for consumers is Kafka per-partition order keyed by
`correlationId` (R15), not the poll's ORDER BY, and consumers must tolerate
at-least-once/reordering anyway (R16–R18); (b) even `DATETIME(3)` can tie —
the correct fix is a deterministic tiebreak, which belongs to the relay.
**Binding note for `outbox_and_idempotency` (id 14):** the relay's poll MUST
add a monotonic secondary sort key (auto-increment sequence column in a
`0001_*` migration, or at minimum `ORDER BY published_at, occurred_at, id`
with an understanding that UUID order ≠ insert order) and/or widen
`occurred_at` to `datetime(3)`; and the projector's `occurredAt` ordering
(R50) should read the envelope's ISO-8601 value (ms-capable), not this column.

### 7. Scripts + docs

- App scripts: `db:generate`, `db:migrate`, `test:integration`
  (`apps/orders/package.json:14–16`). Root: `db:generate:orders`,
  `db:migrate:orders`, aggregate `test:integration` (`package.json:19,23–24`). ✅
- `.env.example` gained `ORDERS_DB_HOST=localhost` with a clear comment. ✅
- Integration-vs-quality gate decision (integration tests excluded from
  `pnpm quality`, run via a dedicated config/script needing Docker) is
  recorded in `vitest.config.mts` and `impl_db_orders.md` §Decisions 5, and
  is sensible — `quality` stays fast and Docker-independent; the acceptance
  criterion is still enforced by a named, runnable gate. Convention set for
  `db_fulfillment`/`db_billing`.

### 8. Gates

- `pnpm run quality` → lint clean, typecheck all projects Done, all tests
  pass (incl. `packages/contracts` 22/22 — the flake the implementer saw did
  not reproduce). ✅
- `./init.sh` → exit 0. ✅
- `git status` scope: only `apps/orders/**`, root
  `package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml`, `.env.example`,
  `progress/*`, `feature_list.json`. Nothing stray. ✅

---

## Acceptance → test mapping (sdd: false — no owned R<n>; feature 14 owns R11–R18 behaviour)

| Acceptance (`feature_list.json` #9) | Named test (all in `migrations.integration.spec.ts`) | Verified |
|---|---|---|
| "migrations run from empty" | *applies the committed migrations from empty and creates all 8 tables plus drizzle's own migrations table* | ✅ re-run, exact table-set assert |
| "round-trip integration test per table via Testcontainers" | *round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling* | ✅ all 8 tables, field-level |
| (reliability, beyond acceptance) | *rejects a duplicate event_id in outbox*; *rejects a duplicate (event_id, consumer) pair in processed_events*; *(published_at, occurred_at) index exists* | ✅ |

Test-matrix rows R13/R14/R17 correctly left to `outbox_and_idempotency` —
this feature builds the tables those behaviours run against; no matrix row
was claimed or touched.

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
- [x] every done feature has passing tests (db_orders: 5/5 integration re-run by reviewer)
- [ ] progress/current.md describes the active session — **stale**: still says
      "idle — phase 5 complete" while db_orders was implemented and reviewed.
      Process note for the leader (D2 lesson, third occurrence); not a code
      defect and not blocking — leader to reset/refresh current.md at close.
- [x] no blocked features

**C3 — architecture respected**
- [x] no framework imports in any domain/ folder (ESLint rule + grep, both clean)
- [x] no cross-service DB access; every FK is internal to otc_orders
- [x] no shared runtime code beyond shared-kernel and contracts
- [x] shared-kernel still zero runtime deps
- [x] no inter-service interaction added (schema-only feature); nothing to classify
- [x] no stray debug logging (migrate-cli's console output is the CLI's UX), no context-free TODOs

**C4 — verification real**
- [x] pnpm quality passes (re-run by reviewer)
- [x] domain tests pure (no domain code yet; nothing violated)
- [x] integration tests use Testcontainers against real MySQL 8.4.11, no mocked store
- [x] coverage thresholds — n/a for this feature's code path (infrastructure schema, exercised by the integration gate; domain-layer 80% gate has no domain code to measure); root gates unchanged and green
- [x] no Jest anywhere (grep clean; Vitest 4 only)

**C5 — session closed cleanly**
- [x] no suspicious untracked files
- [x] history.md entry with effort record (appended by this review)
- [x] feature_list.json reflects true state (db_orders → done by this review)
- [x] human told what was done + how to test manually (impl_db_orders.md §Verification: `pnpm --filter @otc/orders run test:integration`; `pnpm db:migrate:orders` against compose MySQL then `SHOW TABLES`)
- [x] Claude did not commit

**C6 — SDD:** n/a (`"sdd": false`; no sdd feature past `todo` yet).

**C7 — trilogy reusability**
- [x] specs/shared/ untouched by this feature (stack-agnostic intact)
- [x] n8n/ untouched
- [x] history effort records complete (incl. this entry)

---

## Defects

**Blocking: none.**

**Advisory (recorded for feature 14, `outbox_and_idempotency` — not defects of db_orders):**

1. **`outbox` has no `causation_id` column** — R11 requires the published
   envelope to carry `causationId`, and the round-trip test's `payload` is the
   business payload, not the full envelope
   (`apps/orders/src/infrastructure/persistence/schema/outbox.schema.ts`;
   spec `:257–275`). The relay cannot reconstruct `causationId` from the
   current columns. Feature 14 must either add the column in a `0001_*`
   migration or define `payload` as the complete envelope — decide there,
   before the relay is written. Why it matters: R12's causal chain is
   unrecoverable after the fact if it isn't stored.
2. **`occurred_at` second precision + no deterministic poll tiebreak** — see
   the datetime judgement in probe 6 above. Fix belongs to the relay's
   migration/query, not here.

**Process note (leader):** `progress/current.md` was not kept in lockstep
(C2, see above) — reset it as part of session close.

---

## Verdict

**APPROVED.** `feature_list.json` #9 → `done`; history entry appended with
effort record.
