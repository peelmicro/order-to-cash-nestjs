# Implementation report — `seed_job` (id 12, phase 7)

**Status set to:** `in_review`
**sdd:** `false` — worked from `feature_list.json`'s `acceptance` list, not a `specs/seed_job/` triple-doc.

## What was built

`apps/seed` — a plain Node/TS workspace app (`"type": "commonjs"`, no NestJS)
that:

1. Runs the three services' already-committed Drizzle migrations
   (`runOrdersMigrations` / `runFulfillmentMigrations` / `runBillingMigrations`,
   imported directly — never shelled out).
2. Seeds master data into the Orders DB (3 currencies, 12 products, 7
   retailers, 22 companies), initial stock into the Fulfillment DB, and a
   credit limit for every retailer into the Billing DB.
3. Seeds 5 `completed` orders and exactly 1 `cancelled` order
   (`credit_rejected`, total `24999` → `.99` rule) as a **fully fabricated,
   cross-store-consistent saga history**: `orders`/`order_items` +
   already-published `outbox` rows in the Orders DB; `reservations` +
   `despatches`/`despatch_items` + already-published `outbox` rows in the
   Fulfillment DB; `credit_items`/`invoices`/`invoice_items`/`payments` +
   already-published `outbox` rows in the Billing DB; one MongoDB
   `order_timeline` document per order, shaped exactly like
   `specs/shared/openapi.yaml`'s `OrderDetail`.
4. Self-verifies (`src/verify.ts`): row counts per table/collection (all
   **derived from the fixture data modules**, never hand-counted), every
   outbox row published, one completed order's cross-store consistency, and
   the cancelled order's compensation sequence — throws and the process
   exits non-zero on any mismatch.

Run via `pnpm seed` (root) → `pnpm --filter @otc/seed run seed` →
`dotenv -e ../../.env -- tsx src/index.ts`, same CLI pattern as every other
app.

### Determinism / idempotency mechanism

- `src/deterministic.ts`: `deterministicId(namespace)` is a SHA-256 hash of
  `namespace`, with the version/variant nibbles forced so the result is
  **shaped** like a UUID v4 (passes `UniqueId.from()`'s regex) while being a
  pure function of the namespace string — not real randomness. `makeGln(seq)`
  builds a 12-digit GS1-prefixed body and computes the check digit via the
  real `GLN.computeCheckDigit()` from `@otc/shared-kernel` (never invented),
  then round-trips it through `GLN.of()` to fail loudly at seed time if
  wrong. `makeEan13(seq)` does the analogous mod-10 EAN check digit
  (cosmetic — `products.ean` carries no domain validation).
- `src/clock.ts`: every timestamp is `SEED_EPOCH` (`2026-06-01T09:00:00Z`)
  plus a fixed offset — never `new Date()`.
- Every writer uses `INSERT ... ON DUPLICATE KEY UPDATE` (`sql\`VALUES(col)\``)
  against the deterministic primary/unique key, so a second run touches the
  same rows with the same values — **verified live** (see below), not just
  asserted.

### Reused vs. new code

Reused directly (relative imports, no duplication): each service's
`db-config.ts`, `client.ts`, `migrator.ts`, `schema/index.ts`. This is why
`apps/seed/tsconfig.json` has **no `rootDir`** — TS infers a common root
across `apps/seed`, `apps/orders`, `apps/fulfillment`, `apps/billing`, which
avoids the `TS6059` "file not under rootDir" error an explicit `rootDir:
"src"` would otherwise raise for these cross-app imports.

New: the Mongo config/connection (`src/mongo-config.ts`,
`src/writers/mongo.writer.ts` — the first Mongo client in the repo;
`apps/projector` is still a scaffold) and `MONGO_HOST` /
`MONGO_DB_READMODEL` added to `.env.example` / `.env`. Added `mongodb` and
`@testcontainers/mongodb` to the pnpm catalog (`pnpm-workspace.yaml`).

### Data design (the fabricated history)

- **7 retailers** exactly as specified — CarrefourEs/CarrefourFr/
  LeroyMerlinEs/LeroyMerlinFr/AldiEs/AldiDe/AldiGb, GLN sequences 1–7.
- **22 companies** across ES(4)/FR(3)/DE(3)/GB(3)/IT(3)/PT(2)/NL(2)/BE(2),
  GLN sequences 21–42 (no overlap with retailers).
- **12 products** — 8 EUR, 2 GBP, 2 USD. `PRD-0001` is priced `24999` so a
  single line of quantity 1 already totals `.99` — the line the cancelled
  order uses.
- **A credit line for every retailer** (`CR-000001`..`CR-000007`) against a
  chosen "primary supplier", limit `500000` minor units (the same figure
  `specs/shared/asyncapi.yaml`'s own `credit.rejected.v1` example uses for
  `availableCredit`).
- **Sagas** (`src/data/sagas.data.ts`) — one builder function per outcome
  (`buildCompletedSaga` / `buildCancelledSaga`) constructs every fact
  envelope, every DB row and every timeline entry for one order from a
  small spec object, so the 5 completed + 1 cancelled fixtures share no
  hand-duplicated arithmetic. `aggregateId` follows the convention
  `specs/shared/asyncapi.yaml`'s own examples use (order id for Orders'
  own facts; the credit line's row id for `credit.*`; the first line's
  stock-item id for `stock.*`; the despatch/invoice's own id for their
  facts) — never blanket-defaulted to the order id.
  Every payload is **typed against the imported `@otc/contracts` payload
  interfaces** (`OrderPlacedPayload`, `StockReservedPayload`, …), so a shape
  mismatch is a compile error, not just a runtime one.
- `src/data/stock.data.ts` derives the Fulfillment stock rows **from**
  `SAGAS` (never a second hand-typed quantity list): a `consumed`
  reservation permanently reduces `units`; a `released` one leaves `units`
  untouched (domain-model.md §4.2) — single source of truth, cannot drift.
- **No `causationId` written anywhere.** The `outbox` table has no
  `causation_id` column in any of the three committed schemas yet (each
  schema's own header comment: that lands with feature 14,
  `outbox_and_idempotency`, across all three DBs together), and the
  OpenAPI `TimelineEntry` read-model shape doesn't carry it either — so
  this seed does not fabricate a field no consumer can read yet. Documented
  inline in `sagas.data.ts`.

## Files touched

- `apps/seed/**` — new app (package.json, tsconfig, vitest configs, 12 src
  modules, 5 unit spec files, 1 integration spec).
- `pnpm-workspace.yaml` — added `mongodb` / `@testcontainers/mongodb` to the
  catalog.
- `package.json` (root) — added the `seed` script.
- `.env.example`, `.env` — added `MONGO_HOST` / `MONGO_DB_READMODEL`.
- `feature_list.json` — `seed_job` → `in_review`.
- `progress/current.md` — updated in the same breath as the status change.
- `pnpm-lock.yaml` — regenerated by `pnpm install`.

## Traceability (acceptance criteria, `sdd: false` — no `R<n>`s)

| Acceptance (feature_list.json #12) | Proof |
|---|---|
| "idempotent: re-running changes nothing" | Live: two `pnpm seed` runs against the compose stack produced byte-identical row-count summaries and an identical `MD5(GROUP_CONCAT(orders.id))` checksum (see Verification below). Also `seed.integration.spec.ts`'s "is idempotent" test (Testcontainers, runs the full seed twice, diffs `verifySeed()` output + a representative-table checksum). |
| "10+ products, 7 retailers, 20+ companies, credit limits for every retailer, initial stock" | `src/data/reference-data.spec.ts` — exact counts/codes for retailers, `>=20` companies, `>=10` products, one credit line per retailer. `src/data/stock.spec.ts` — stock derived from the sagas, non-negative, zero `reservedUnits`. Live: seed summary shows `retailers:7, companies:22, products:12, credits:7, stock:11`. |
| "a few completed orders and one cancelled order" | `src/data/sagas.spec.ts` — `COMPLETED_SAGAS.length` in `[4,6]` (is 5), `CANCELLED_SAGAS.length === 1`. |
| GLN check digits genuinely valid | `src/deterministic.spec.ts` (`makeGln`) + `src/data/reference-data.spec.ts` (every retailer/company GLN via `GLN.of()`, all unique). |
| Totals arithmetic / `.99` property | `src/data/sagas.spec.ts` — items sum to order total for every saga; cancelled order's total mod 100 === 99 and is exclusive to it. |
| Reference-sequence integrity | `src/data/sagas.spec.ts` — `ORD-000001..006` sequential/unique; `DES-`/`INV-000001..005` sequential across completed orders only; cancelled order has neither. |
| Envelopes validate against contracts types | `src/data/sagas.spec.ts` (`REQUIRED_KEYS` table checked against every built payload) + compile-time typing in `sagas.data.ts` itself. |
| Compensation sequence visible, in causal order | `src/data/sagas.spec.ts`, `src/writers/mongo.writer.spec.ts`, and `seed.integration.spec.ts` all assert `['order.placed.v1','stock.reserved.v1','credit.rejected.v1','stock.released.v1','order.cancelled.v1']`. |
| Outbox rows already published | `seed.integration.spec.ts` ("every outbox row … is already published") + `verifySeed()` (run live). |
| Testcontainers, full seed run twice, idempotency by row-count + checksum diff | `apps/seed/src/seed.integration.spec.ts` (MySQL 8.4.11 + Mongo 8.3.8, three logical DBs on one MySQL container). |

## What I could not do / deferred

- No `docker-compose.apps.yml` one-shot container — explicitly phase 23,
  out of scope here (task prompt reiterates this).
- `apps/projector`'s own Mongo client does not exist yet (still a
  scaffold); `apps/seed`'s `mongo-config.ts` is the first one in the repo,
  and is written so `apps/projector` can follow the same shape later
  without needing to change env var names.
- `causationId` is deliberately never written (see "Data design" above) —
  not a gap in this feature, a consequence of the outbox schema not having
  the column yet.

## Surprises

- TypeScript refuses to assign a closed `interface` (e.g. the generated
  `OrderPlacedPayload`) to a `Record<string, unknown>`-typed field
  ("Index signature for type 'string' is missing") even though it is
  structurally compatible — resolved by typing `OutboxFixture.payload` as
  `object` instead, which has no such restriction.
- `apps/seed` importing `apps/orders`/`apps/fulfillment`/`apps/billing`
  source files directly (as the task explicitly asked for) only works
  cleanly with `tsc` if `rootDir` is left unset — an explicit `"src"`
  `rootDir` (the pattern every other app uses) rejects the cross-app files
  with TS6059.

## Verification (real output, against the running compose stack)

```
$ pnpm seed
[seed] applying migrations (orders, fulfillment, billing)…
[seed] writing master data (currencies, products, retailers, companies, stock, credits)…
[seed] writing sample saga history (5 completed + 1 cancelled)…
[seed] verifying…
[seed] OK — self-verification summary:
{
  "orders": { "currencies": 3, "products": 12, "retailers": 7, "companies": 22, "orders": 6, "orderItems": 11, "outbox": 17 },
  "fulfillment": { "stock": 11, "reservations": 11, "despatches": 5, "despatchItems": 10, "outbox": 12 },
  "billing": { "credits": 7, "creditItems": 15, "invoices": 5, "invoiceItems": 10, "payments": 5, "outbox": 21 },
  "mongoOrderTimelines": 6
}
[seed] done.
```

Re-run (`pnpm seed` again): **identical** summary. `MD5(GROUP_CONCAT(id ORDER BY id))`
over `otc_orders.orders` was `23c7f093e43aac39f5318393be207070` both times.

`ORD-000001` cross-store story (spot-checked via `mysql`/`mongosh`): Orders
DB `total_amount=17492`, Fulfillment DB `despatch_reference=DES-000001`
consuming 2 reservations, Billing DB `invoice_reference=INV-000001` /
`payment_reference=PAY-SEED-000001` both `17492`, Mongo document carries all
three references and the full 9-fact timeline in `occurredAt` order.

`ORD-000006` (cancelled): `status=cancelled`, `cancellation_reason=
credit_rejected`, `total_amount=24999`; Fulfillment reservation
`status=released`; Billing has **zero** `credit_items`/`invoices` rows for
it; Mongo timeline is exactly
`['order.placed.v1','stock.reserved.v1','credit.rejected.v1','stock.released.v1','order.cancelled.v1']`.

Unit tests: 94 passed (5 files) — `pnpm --filter @otc/seed test`.
Integration tests: 4 passed — `pnpm --filter @otc/seed test:integration`
(Testcontainers MySQL 8.4.11 with three logical databases + MongoDB 8.3.8).
`pnpm run quality` (whole monorepo): lint + typecheck + test all green.
`./init.sh`: exits 0.
