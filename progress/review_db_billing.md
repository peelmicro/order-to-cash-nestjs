# review_db_billing

**Feature:** `db_billing` (id 11, phase 6) — Drizzle schema + migrations for `otc_billing`
**Reviewer verdict:** **APPROVED** (first pass, 0 blocking defects, 1 REQUIRED
follow-up on a pre-existing `packages/contracts` test-timeout flake — see
"Flake ruling" below; feature-14 advisories inherited by design)
**Date:** 2026-08-20

---

## Probes run (real output, not the implementer's report)

### 1. Integration test — re-run independently

```
$ pnpm --filter @otc/billing run test:integration
 RUN  v4.1.11 .../apps/billing
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  15.66s
```

10/10 green against a **disposable Testcontainers `mysql:8.4.11`** (same pinned
tag as `docker-compose.infra.yml` and both sibling DB features). The spec
connects via `container.getHost()/getPort()` — never the compose instance.

### 2. Cross-service purity — read from the committed SQL

`apps/billing/drizzle/0000_brown_hammerhead.sql` contains exactly **three**
`FOREIGN KEY` clauses, all internal to `otc_billing`:

- `credit_items.credit_id` → `credits.id` (no action — append-only ledger,
  same deliberation as `reservations.stock_id`)
- `invoice_items.invoice_id` → `invoices.id` (`ON DELETE cascade`, same
  pattern as `order_items` / `despatch_items`)
- `payments.invoice_id` → `invoices.id` (no action — a payment record must
  never silently disappear)

No reference of any kind to orders/fulfillment tables. `retailer_code`
varchar(20), `company_code` varchar(20), `order_reference` varchar(20),
`product_code` varchar(30) — plain varchars whose widths **match the orders
schema byte-for-byte** (verified against `apps/orders/drizzle/0000_*.sql`:
retailers/companies code 20, orders.order_reference 20, products.code 30). ✅
`grep -iE 'decimal|float|double'` over the SQL: zero hits — money is int
minor units everywhere (`credit_limit`, `amount`, `discount`, `total_amount`,
`price`). ✅

### 3. Outbox / processed_events parity — diffed against BOTH siblings

Extracted the `CREATE TABLE outbox` / `CREATE TABLE processed_events` blocks
and the `idx_outbox_published_occurred` line from all three committed
migrations and diffed billing against orders AND fulfillment:
**byte-identical** in all six comparisons — every column, both PKs, both
uniques (`outbox_event_id_unique`, `uq_processed_events_event_consumer`), the
`(published_at, occurred_at)` index. ✅

`causation_id` correctly **NOT** added — grep over `apps/billing/` finds it
only in `outbox.schema.ts:13`'s comment deferring to feature 14
(`outbox_and_idempotency`), consistent with `review_db_orders.md` advisory #1
and db_fulfillment's identical handling. ✅

### 4. Schema vs `specs/shared/domain-model.md` §5 — column by column

**`credits`** (§5.1 `BuyerCredit`): `id` char(36) PK; `code` varchar(30)
unique (CR-######); `uq_credits_retailer_company UNIQUE(retailer_code,
company_code)` = §5.1 "One credit line per (retailerCode, companyCode) pair";
`credit_limit` int (minor units) + `currency_code` char(3). Invariant **B1
deliberately NOT a DB CHECK** — recorded in `credits.schema.ts:8–18` with the
correct (and stronger-than-F1) rationale: B1 is a derived sum over the whole
`credit_items` ledger, inexpressible as a single-table CHECK even in
principle; it belongs in the `BuyerCredit` aggregate. `grep -i check` over
the SQL: zero constraint hits. ✅

**`credit_items`** (§5.1 `CreditLedgerEntry`): local FK to credits;
`order_reference` plain varchar(20); `type` **varchar(20) + TS union
`'hold' | 'release' | 'consume'` via `$type<>`** (exactly §5.1's set), NOT a
MySQL ENUM — orders/fulfillment precedent; `idx_credit_items_credit_order
(credit_id, order_reference)` present in the SQL and justified against the
activeHold/openExposure derivation and B4. ✅

**`invoices`** (§5.2): `invoice_reference` varchar(20) **unique** (INV-######);
`amount`/`discount`/`total_amount` int; `status` varchar(20) + TS union
`'issued' | 'paid'` (§5.3 state machine values); **`paid_at` the only
nullable business column** (B9: present iff paid) — correct; `outbox.published_at`
the only other nullable. B7 (one invoice per orderReference) left to the
aggregate — see advisory below, symmetric with db_fulfillment's F8. ✅

**`invoice_items`** (§5.2 `InvoiceLine`): local cascade FK, `product_code`
varchar(30), `units` int, `price` int minor units. ✅

**`payments`** (§5.2 `Payment`): `payment_reference` varchar(30) **unique** —
the B10 remittance idempotency key, DB-enforced; **`source` TS union is
`'operator' | 'robot' | 'test'`** (`payments.schema.ts:19–21`) — **`robot`,
not `n8n`**, exactly the approved spec decision and §5.2's value set, and the
round-trip test inserts `source: 'robot'` proving the value live; **no
`updated_at`** (`created_at` only) — the task's explicit carve-out, consistent
with B10's record-once semantics. ✅

### 5. Flake ruling — `packages/contracts` spawnSync timeout (task check #5)

Verified independently, not trusted:

- `git status --short -- packages/contracts` and `git diff HEAD --stat --
  packages/contracts` → **both empty**. The package is untouched by this
  feature (and by the whole uncommitted phase-6 stack). ✅ pre-existing.
- `pnpm --filter @otc/contracts run test` in isolation → **22/22 passed
  (17.15s)**. No failure when run alone.
- Full `pnpm run quality` → lint OK, typecheck OK, then under the full
  parallel `-r` test run the flake **reproduced for me — and worse than
  reported**: **two** spawnSync-based CLI tests timed out at the 5000ms
  default (`scripts/check.spec.ts:71` *"exits 0 and prints OK…"* AND
  `scripts/generate.spec.ts:38` *"run as a CLI (tsx scripts/generate.mts)…"*),
  20/22 passing. The implementer saw only the first.
- `vitest run --testTimeout 30000` in `packages/contracts` → **22/22 passed**.
  Pure cold-`tsx`-under-load timeout, not a logic failure.

**Ruling: case (a) — genuinely pre-existing and unrelated to `db_billing`.**
Not a defect of this feature; does not block approval. But a quality gate
that fails under load trains people to ignore it — the worst outcome — so a
follow-up is **REQUIRED, not optional**:

> **REQUIRED FOLLOW-UP (owner: leader → `test_maintainer`, before the next
> feature closes):** bump the test timeout on the two spawnSync CLI tests in
> `packages/contracts` (`scripts/check.spec.ts:71`, `scripts/generate.spec.ts:38`)
> — either a per-test `{ timeout: 30_000 }` on each `it`, or one
> `testTimeout` line in `packages/contracts/vitest.config.mts` scoped with a
> comment. This is a one-to-two-line mechanical change squarely inside
> `test_maintainer`'s remit. Until it lands, `pnpm quality` is flaky under
> load on this machine and its exit code cannot be trusted as a gate.

### 6. Test assertion quality

- Round-trip is **field-level** (`toMatchObject` over every column +
  `getTime()` equality on every datetime), all 7 tables, deep `toEqual` on a
  nested outbox JSON payload with a lines array (spec `:245–272`). No row
  counts, no vacuous asserts.
- Same datetime honesty as the siblings: millisecond truncation before insert
  with the explanatory comment (`:116–118`); `timezone: 'Z'` on the
  connection with the UTC rationale (`:46–49`).
- **All five duplicate rejections genuine** (each `rejects.toMatchObject({
  cause: { code: 'ER_DUP_ENTRY' } })` after a real first insert):
  `credits (retailer_code, company_code)` with different `code` proving the
  pair is the trigger, **plus** the same-retailer/different-company accept
  proving compositeness (`:292–334`); `invoices.invoice_reference`
  (`:336–374`); `payments.payment_reference` (`:376–420`); `outbox.event_id`
  (`:422–452`); `processed_events (event_id, consumer)` plus the
  same-event/different-consumer accept (`:454–488`).
- Cascade genuinely asserted: parent invoice deleted → child selected back →
  `toHaveLength(0)` (`:490–528`).
- Both index-existence tests assert exact column order via
  `information_schema.statistics` (`:87–113`).

### 7. Gates

- `pnpm run lint` → OK; `pnpm run typecheck` → OK (all workspaces);
  `pnpm --filter '!@otc/contracts' -r run test` → all green incl.
  apps/billing (integration spec correctly excluded from the default config).
  Full `pnpm quality` blocked only by the pre-existing contracts flake ruled
  on above — the justified equivalent the task anticipated.
- Domain purity: `grep -rEn "drizzle|mysql2|@nestjs|kafkajs|nats|mongodb|persistence" apps/*/src/domain/`
  → **zero hits**; ESLint domain rule unmodified; none of this feature's
  files live under any `src/domain/`.
- `./init.sh` → **exit 0** ("environment and state are coherent").
- No Jest anywhere in the feature's files (grep clean); Vitest 4 only.
- `drizzle-kit push` never used — grep hits only the comment forbidding it;
  committed SQL + `runBillingMigrations` is the single application path.
  `drizzle/meta/` (`_journal.json` + `0000_snapshot.json`) committed.
- `git status` scope: only `apps/billing/**`, root `package.json` (two
  `db:*:billing` scripts), `pnpm-lock.yaml`, `.env.example`
  (`BILLING_DB_HOST=localhost` — no secret), `progress/*`,
  `feature_list.json`. (`apps/orders/**`, `apps/fulfillment/**`,
  `pnpm-workspace.yaml` also dirty — the still-uncommitted, already-approved
  sibling features, not this one.) `.env` git-ignored
  (`git check-ignore .env` confirms). `pnpm-workspace.yaml` untouched by
  this feature, as claimed — catalog pins landed with db_orders. ✅

### 8. Pattern drift vs siblings — none

Diffed every plumbing file (`db-config.ts`, `client.ts`, `migrator.ts`,
`migrate-cli.ts`, `drizzle.config.ts`, `vitest.config.mts`,
`vitest.integration.config.mts`) against apps/fulfillment modulo the service
name: **only comment wording/wrapping differs**. `package.json` is
**identical modulo name** (scripts, deps, devDeps). Root scripts follow the
exact `db:generate:<svc>` / `db:migrate:<svc>` convention; root
`test:integration` already aggregates. ✅

---

## Acceptance → test mapping (sdd: false — no owned R<n>; R37–R49 belong to the later billing aggregate/invoice features)

| Acceptance (`feature_list.json` #11) | Named test (all in `migrations.integration.spec.ts`) | Verified |
|---|---|---|
| "migrations run from empty" | *applies the committed migrations from empty and creates all 7 tables plus drizzle's own migrations table* | ✅ re-run, exact table-set assert |
| "round-trip integration test per table" | *round-trips one row per table via typed Drizzle insert/select, field-level equality including outbox JSON payload and datetime handling* | ✅ all 7 tables, field-level |
| (reliability, beyond acceptance) | five ER_DUP_ENTRY probes (credits pair proven composite both ways, invoice_reference, payment_reference, outbox.event_id, processed_events pair proven composite both ways); both index-existence tests; *cascade-deletes invoice_items* | ✅ |

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
- [x] every done feature has passing tests (db_billing: 10/10 integration re-run by reviewer)
- [x] progress/current.md describes the active session — names db_billing and
      the phase-6 goal, but again lags one transition (`in_progress` while the
      list says `in_review`) — the same minor D2 lag as last review, noted,
      not blocking
- [x] no blocked features

**C3 — architecture respected**
- [x] no framework imports in any domain/ folder (ESLint rule + grep, both clean)
- [x] no cross-service DB access; all three FKs internal to otc_billing (read from the SQL)
- [x] no shared runtime code beyond shared-kernel and contracts
- [x] shared-kernel still zero runtime deps
- [x] no inter-service interaction added (schema-only feature); nothing to classify
- [x] no stray debug logging, no context-free TODOs

**C4 — verification real**
- [x] quality gates pass (lint + typecheck + all suites re-run by reviewer;
      sole failure is the pre-existing contracts timeout flake, ruled
      unrelated above, follow-up REQUIRED and owned)
- [x] domain tests pure (no domain code yet; nothing violated)
- [x] integration tests use Testcontainers against real MySQL 8.4.11, no mocked store
- [x] coverage thresholds — n/a for this feature's code path (infrastructure
      schema exercised by the integration gate; no domain code to measure)
- [x] no Jest anywhere (grep clean; Vitest 4 only)

**C5 — session closed cleanly**
- [x] no suspicious untracked files
- [x] history.md entry with effort record (appended by this review)
- [x] feature_list.json reflects true state (db_billing → done by this review)
- [x] human told what was done + how to test manually (impl_db_billing.md
      §Verification: `pnpm --filter @otc/billing run test:integration`;
      `pnpm db:migrate:billing` against compose MySQL then `SHOW TABLES`)
- [x] Claude did not commit

**C6 — SDD:** n/a (`"sdd": false`; no sdd feature past `todo` yet).

**C7 — trilogy reusability**
- [x] specs/shared/ untouched by this feature
- [x] n8n/ untouched
- [x] history effort records complete (incl. this entry)

---

## Defects

**Blocking: none.**

**Required follow-up (pre-existing, NOT a db_billing defect — owner: leader →
`test_maintainer`, before the next feature closes):**

1. **`packages/contracts` spawnSync CLI tests flake under load** —
   `scripts/check.spec.ts:71` and `scripts/generate.spec.ts:38` exceed the
   5000ms default when the full workspace test run is parallel (cold `tsx`
   start), both pass in isolation and with `--testTimeout 30000`. Fix is a
   one/two-line timeout bump. A flaky `pnpm quality` will train people to
   ignore the gate — do not let it linger.

**Advisory (new, recorded for the invoice aggregate feature — symmetric with
db_fulfillment's F8 advisory):**

2. **B7 has no DB-level backstop.** domain-model.md §5.2 B7: "Exactly one
   invoice per `orderReference`" — the schema uniques `invoice_reference` but
   not `invoices.order_reference`. Like F8 (despatches), this is a *static*
   uniqueness a DB index could race-proof against two concurrent issue
   commands both passing the aggregate's read-then-write idempotency check.
   The task's table shape did not include it; the invoice aggregate feature
   must decide deliberately: add `UNIQUE(order_reference)` in a `0001_*`
   migration (catching ER_DUP_ENTRY to keep B7's idempotent-success
   semantics), or document why serialization elsewhere makes the race
   impossible. Same decision point, same options, decide both (F8 + B7)
   together if possible.

**Inherited by design (recorded in `review_db_orders.md`, owned by feature
14):** no `causation_id` column; `occurred_at` DATETIME(0) relay-poll
tiebreak. The verbatim outbox copy here is correct — divergence would have
been the defect.

---

## Verdict

**APPROVED.** `feature_list.json` #11 → `done` — **phase 6 complete** (all
three service databases). History entry appended with effort record.
