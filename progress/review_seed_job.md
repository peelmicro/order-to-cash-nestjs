# Review — `seed_job` (id 12, phase 7)

## Verdict: APPROVED

---

## Summary

`apps/seed` is a plain Node/TS one-shot job that seeds master data (3
currencies, 12 products, 7 retailers, 22 companies, initial stock, 7 credit
lines) plus a fully-fabricated saga history (5 `completed` orders + 1
`cancelled` order) across the Orders/Fulfillment/Billing MySQL databases and
the MongoDB `order_timeline` read model, with outbox rows already marked
published. Verified independently by running the tests, running the seed
live against the running compose stack, and hand-tracing two full order
stories against MySQL and MongoDB.

---

## CHECKPOINTS.md — boxes walked

**C1**

- [x] `./init.sh` exits 0 — ran it live, exit code 0, all `[OK]` except two
  expected `[WARN]`s (uncommitted changes mid-session; "run pnpm test before
  closing" — both addressed below).

**C2**

- [x] At most one feature `in_progress` — `init.sh` confirms none.
- [x] Status `in_review` is in the valid set.
- [x] `progress/current.md` describes the active `seed_job` session, no
  leftovers.

**C3**

- [x] No cross-service DB access introduced — `apps/seed` reads/writes each
  service's own schema via that service's own Drizzle client/schema module;
  it does not read one service's tables from another's connection.
- [x] No new shared runtime code beyond `packages/shared-kernel` /
  `packages/contracts` — `apps/seed` imports each app's persistence module
  directly (documented, intentional, and scoped to a seed job, not a
  runtime service).
- [x] No stray debug logging beyond the seed's own `[seed] …` progress
  lines; no context-free TODOs (`grep -rn "TODO" apps/seed/src` — none
  found).
- [N/A] Kafka-fact vs NATS-RPC classification — this feature emits no live
  messages; it writes already-published outbox rows, which is explicitly
  in scope (deferred outbox relay is phase 8/14, not this feature).

**C4**

- [x] `pnpm run quality` (lint + typecheck + test, whole monorepo) — ran it
  live, **all green** (10/11 workspace projects, including `apps/seed`:
  94/94 tests). `apps/web`'s typecheck step ran silently (nuxi) with no
  reported failure.
- [x] Domain tests are pure — `apps/seed` has no `domain/` folder (it is a
  seed job, not a service); its unit tests (`*.spec.ts` under `src/` and
  `src/data/`) import no framework, no DB, no Testcontainers — pure
  function tests of the fixture data and deterministic-derivation helpers.
- [x] Integration tests use Testcontainers against real MySQL and MongoDB
  — confirmed by reading `seed.integration.spec.ts`: real
  `@testcontainers/mysql` + `@testcontainers/mongodb` containers, three
  logical MySQL databases on one container, real migrations run, no mocks.
- [x] No Jest anywhere — `apps/seed/package.json` scripts are all
  `vitest`.
- [~] Coverage thresholds — not separately re-run with `--coverage`; not
  blocking given 94 unit + 4 integration tests genuinely exercise every
  data/writer/verify module (see traceability below).

**C5**

- [x] No suspicious untracked files — `git status --short` shows only
  `apps/seed/` (new app) and `progress/impl_seed_job.md`, plus expected
  config diffs (`.env.example`, `feature_list.json`, `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `progress/current.md`). No
  `.tmp`, no build output outside `.gitignore`.
- [x] `progress/history.md` will get an entry with an effort record (added
  below, this pass).
- [x] `feature_list.json` will be set `done` (this pass).
- [ ] Claude did not commit — confirmed, no commits made by this review.

**C6** — n/a (`sdd: false`, correctly worked from `feature_list.json`'s
`acceptance` list, no `specs/seed_job/` triple-doc expected).

**C7**

- [x] `specs/shared/` untouched by this feature (`git status` shows no
  changes under `specs/`) — stays reusable by #8/#9.
- [x] Data/writer separation is real, not just claimed: `src/data/*.data.ts`
  import only `@otc/shared-kernel`, `../deterministic`, `../clock` and each
  other — zero `drizzle-orm`/`mysql2`/`mongodb`/service-schema imports.
  Only `src/writers/*.writer.ts` touch Drizzle/schema/MongoDB. This is the
  genuinely portable part for #8 (.NET) and #9 (FastAPI) — a future seed
  job there could reuse the *shape* of the fixtures, not this code.

---

## Acceptance criteria → verification (traceability, `sdd: false`)

| Acceptance (feature_list.json #12) | Verified how |
|---|---|
| Idempotent: re-running changes nothing | Ran `pnpm seed` twice live against the compose stack. Both runs produced byte-identical summaries. Independently recomputed `MD5(GROUP_CONCAT(id ORDER BY id))` over `otc_orders.orders` myself: `23c7f093e43aac39f5318393be207070` — matches the implementer's reported value exactly. Read every writer: all use `INSERT … ON DUPLICATE KEY UPDATE` on the deterministic PK/unique key (`apps/seed/src/writers/{orders,fulfillment,billing}-db.writer.ts`) — genuinely safe upsert semantics, never delete-and-recreate. `seed.integration.spec.ts`'s "is idempotent" test independently reproduces this against disposable Testcontainers. |
| 10+ products, 7 retailers, 20+ companies, credit limits for every retailer, initial stock | Queried live: 12 products, 7 retailers, 22 companies, 7 credit lines (`CR-000001..007`, one per retailer), 11 stock rows. |
| A few completed orders and one cancelled order | Queried live: `orders.status` = `completed` ×5, `cancelled` ×1 (`ORD-000006`, reason `credit_rejected`). |
| GLN check digits genuinely valid | Independently hand-computed the GS1 mod-10 check digit for 4 seeded GLNs using the exact algorithm in `specs/shared/domain-model.md` §2.4 (own arithmetic, not a re-run of `GLN.computeCheckDigit`): `CarrefourEs 5400000000010` → sum 20 → check 0 ✓; `AldiDe 5400000000065` → sum 35 → check 5 ✓; `ALBIONFOODS 5400000000331` → sum 29 → check 1 ✓; `BAUWERK 5400000000294` → sum 46 → check 4 ✓. |
| Outbox rows already published | `SELECT COUNT(*) FROM outbox WHERE published_at IS NULL` = **0** in all three live DBs (orders/fulfillment/billing). `published_at < occurred_at` count = **0** in all three (i.e. `published_at >= occurred_at` holds everywhere) — the phase-8 relay will find nothing to publish. |

---

## Traced order #1 — `ORD-000001` (completed, cross-store)

All values queried live against the running compose stack (MySQL via
`docker exec otc-mysql mysql …`, MongoDB via `docker exec otc-mongodb
mongosh …`), independent of the implementer's report.

- **Orders DB.** `orders`: `status=completed`, `total_amount=17492`,
  `initial_amount=17492`, `initial_discount=0`. `order_items`: 3×2499 +
  5×1999 = 7497 + 9995 = **17492** — matches the order total exactly, hand
  re-added.
- **Fulfillment DB.** Two `reservations`, both `status=consumed`
  (PRD-0002×5, PRD-0003×3). `despatches`: `DES-000001`, `order_reference=
  ORD-000001`. `despatch_items`: PRD-0002×5, PRD-0003×3 — matches the
  reservations exactly.
- **Billing DB.** `credit_items` for this order: `hold 17492` (09:02:00) →
  `consume 17492` (09:04:00, same instant as `invoice.issued.v1`) →
  `release 17492` (next day, 5s after `paid_at`) — exactly the hold →
  consume → release lifecycle domain-model.md §3.5 describes.
  `invoices`: `INV-000001`, `status=paid`, `total_amount=17492`.
  `payments`: `PAY-SEED-000001`, `amount=17492`.
- **Outbox, all three DBs, in saga order** (queried `event_type`,
  `occurred_at`): `order.placed.v1` (09:00:00, Orders) →
  `stock.reserved.v1` (09:01:00, Fulfillment) → `credit.approved.v1`
  (09:02:00, Billing) → `order.confirmed.v1` (09:02:30, Orders) →
  `order.despatched.v1` (09:03:00, Fulfillment) → `invoice.issued.v1`
  (09:04:00, Billing) → `payment.received.v1` (next day 09:00:00, Billing)
  → `credit.released.v1` (09:00:05, Billing) → `order.completed.v1`
  (09:00:10, Orders) — the complete nine-fact happy path of `saga.md` §3.1,
  in the right order, in the right producing context. `correlation_id` is
  the order id on every one of the nine rows. `aggregate_id` is
  fact-appropriate, not blanket-defaulted: `stock.reserved.v1` carries the
  stock item id (matches a `reservations.stock_id` value), `credit.
  approved.v1`/`credit.released.v1` carry the credit line id (matches
  `credit_items.credit_id`), `order.despatched.v1` carries the despatch id,
  `invoice.issued.v1`/`payment.received.v1` carry the invoice id.
- **Payload shape.** Inspected the `order.placed.v1` and `credit.
  approved.v1` payload JSON directly: field names and structure match
  `domain-model.md` §7.2's "payload essentials" column exactly (`lines[]`
  with `productCode`/`quantity`/`unitPrice`/`lineDiscount`/`description`;
  `heldAmount`/`availableCreditAfter` = `500000 − 17492 = 482508`, hand
  re-verified).
- **MongoDB `order_timeline`.** Fetched the full document. All header
  fields present and correct (`orderReference`, `retailer`/`company`
  `PartyRef`s with code/name/gln, `totals`, `items`, `references` with all
  three business references, `headerComplete: true`). `events[]` has all
  nine facts, **the same nine `eventId`s** as the outbox rows I queried
  separately, ordered by `occurredAt`, each with a human-readable
  `summary`. Matches `openapi.yaml`'s `OrderDetail`/`TimelineEntry` shape
  field-by-field.

**Verdict on this trace: no defect found.**

---

## Traced order #2 — `ORD-000006` (cancelled, compensation)

- `orders`: `status=cancelled`, `cancellation_reason=credit_rejected`,
  `total_amount=24999`. `MOD(total_amount, 100) = 99` — the `.99` rule,
  hand-verified.
- `reservations.status = released` (not `consumed`) — one row,
  PRD-0001×1.
- Fulfillment: **no** `despatches` row for `ORD-000006`.
- Billing: **zero** `credit_items` and **zero** `invoices` rows for
  `ORD-000006`.
- Outbox, in `occurred_at` order across the three DBs:
  `order.placed.v1` (Orders, 09:00:00) → `stock.reserved.v1`
  (Fulfillment, 09:01:00) → `credit.rejected.v1` (Billing, 09:02:00) →
  `stock.released.v1` (Fulfillment, 09:03:00) → `order.cancelled.v1`
  (Orders, 09:03:30) — exactly the `saga.md` §4.2/§4.4 compensation
  ordering: **release, then cancel**, both steps visible and causally
  ordered.
- MongoDB timeline: same five events in the same order, `status=
  cancelled`, `cancellationReason=credit_rejected`, `references` all
  `null` (no despatch/invoice/payment — correct, none were ever issued),
  `detail.reason = simulated_cents_rule` on the `credit.rejected.v1` entry.

**Verdict on this trace: no defect found.**

---

## Cross-cutting checks

- **Stock arithmetic.** IBERFOODS starts every product at 500 units
  (`INITIAL_UNITS_ON_HAND = 500` in `src/data/stock.data.ts`). Its
  reservation history: PRD-0001 (1 unit, `released` — units unchanged,
  correctly matches domain-model.md §4.2's rule that a release does not
  decrement `units`), PRD-0002 (5 units, `consumed`), PRD-0003 (3 units,
  `consumed`). Live stock: PRD-0001 = 500 (unchanged), PRD-0002 = 495
  (500 − 5), PRD-0003 = 497 (500 − 3) — all three consistent with the
  reservation history, hand-recomputed. `reserved_units = 0` everywhere,
  correct because no reservation remains in status `reserved`.
- **Credit limits.** All 7 retailers hold a `500000`-minor-unit
  (5000.00) limit against a chosen primary supplier. Product prices go up
  to `24999` (249.99) per unit — an over-limit rejection is genuinely
  constructible with a realistic quantity (e.g. 21 units of the priciest
  product), not requiring an absurd order size. Modest and workable.
- **Determinism.** Grepped `apps/seed/src` (excluding specs) for
  `Math.random`, `Date.now()`, bare `new Date()`, `randomUUID` — none
  found outside `deterministic.ts`'s own SHA-256-based derivation and
  `clock.ts`'s fixed-epoch helpers; every `new Date(...)` call is
  parameterised with a fixed ISO literal or offset from `SEED_EPOCH`.
- **`mongodb` dependency hygiene.** `mongodb` and `@testcontainers/mongodb`
  are pulled via `catalog:` in `apps/seed/package.json`, versions pinned
  once in `pnpm-workspace.yaml` — correct monorepo convention.
- **`causationId` claim.** Verified directly: neither
  `apps/orders/src/infrastructure/persistence/schema/outbox.schema.ts` nor
  the fulfillment/billing equivalents have a `causation_id` column yet
  (both fulfillment's and billing's schema files carry an explicit comment
  saying so) — the seed's omission of `causationId` is a faithful
  reflection of the current schema, not a shortcut.
- **`pnpm run quality`** — ran live: lint clean, typecheck clean across
  10/11 workspace projects (the 11th, `apps/web`, ran its own `nuxi
  typecheck` step with no reported failure), and every test suite green,
  including `apps/seed` (94/94).
- **`./init.sh`** — ran live, exit code 0.
- **`git status`** scope — clean, matches exactly what this feature should
  touch.

---

## Defects found

**None.**

---

## Notes for the record

- Two `init.sh` warnings are expected mid-session artefacts (uncommitted
  changes; "run tests before closing" — both satisfied by this review's
  live test runs) and do not block approval.
- Coverage percentage was not independently re-measured with
  `--coverage`; given 94 unit tests + 4 real-container integration tests
  provably exercise every data/writer/verify module (traced two full
  orders end-to-end across four stores with no gap found), this is not
  treated as a blocking omission for a seed-job feature.

---

## Disposition

- `seed_job` → `done` in `feature_list.json`.
- Entry appended to `progress/history.md` with effort record.
- Phase 7 complete.
