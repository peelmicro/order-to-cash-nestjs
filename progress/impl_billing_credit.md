# `billing_credit` (id 19, phase 10) — implementation report

**Author:** `implementer`
**Date:** 2026-08-22
**Spec:** `specs/billing_credit/{requirements,design,tasks}.md`, approved at the human gate with the binding amendment to open point 12 (see below).
**Status set:** `in_progress → in_review` in `feature_list.json`.

---

## 1. What was built

### Domain (`apps/billing/src/domain/`)
- `buyer-credit.ts` — the `BuyerCredit` aggregate root: `reconstitute` (refuses a snapshot violating B1 or B3, deliberately **not** B5 per order — see §4 deviation D1), `evaluateHold` (pure decision: `already_held` → `currency_mismatch` → `over_limit` → `fits`, in that priority order), `approveHold`, `refuseHold`, `releaseHold`, `consumeHold`, `appendedEntries`, `toSnapshot`.
- `credit-ledger-entry.ts` — `CreditLedgerEntry` (no mutator of any kind — B2 by shape) + `CREDIT_ENTRY_TYPES`.
- `credit-exposure.ts` — `summariseLedger`, the one pure function computing BC5/BC6 (the two-term identity: `exposure = Σhold − Σrelease`, `openExposure = min(Σconsume, exposure)`, `activeHold = exposure − openExposure`).
- `credit-events.ts` — the three fact builders (`creditApprovedEvent`, `creditRejectedEvent`, `creditReleasedEvent`); `creditRejectedEvent` has exactly one call site (`refuseHold`), which is what makes `BC14`/`R44` structural.
- `credit-errors.ts` — the six `DomainError` subclasses.
- `buyer-credit-snapshot.ts`, `index.ts` (barrel).

### Application (`apps/billing/src/application/`)
- Ports: `clock.port.ts`, `unit-of-work.port.ts`, `fact-publisher.port.ts` (verbatim copies of Orders'), `consumer-name.ts` (`CONSUMER_NAMES = []`), `buyer-credit-repository.port.ts`, `credit-read.port.ts`, `credit-decision.port.ts` (feature 20's seam — `AdapterRejectionReason = Exclude<CreditRejectionReason, 'over_limit'>`).
- `credit-hold.handler.ts` — the plain-class transactional unit (§5.5's flow), `credit-application-errors.ts` (`CreditLineNotFoundError`, `CreditCurrencyMismatchError`).
- `commands/credit.commands.ts` + `credit.command-handlers.ts`, `queries/credit.queries.ts` + `credit.query-handlers.ts` — thin `@nestjs/cqrs` wrappers, explicit `@Inject`.

### Infrastructure (`apps/billing/src/infrastructure/`)
- `credit/always-approve-credit-decision.ts` — the adapter bound today; feature 20 replaces only this provider.
- `persistence/drizzle-unit-of-work.ts`, `buyer-credit.mapper.ts`, `buyer-credit.repository.ts` (the three-statement lock protocol of §5.5), `credit-read.repository.ts` (three non-locking queries folded through `summariseLedger`).
- `outbox/` — the full seven-file canonical family copied with `// COPY OF —` banners (`outbox-recorder.ts`, `outbox-envelope-mapper.ts`, `outbox-relay.ts`, `outbox-relay.service.ts`, `outbox-relay.config.ts`, `kafka-fact-publisher.ts`, `create-kafka-client.ts`), plus `kafka.config.ts` (Billing's own topic constant + `FACTS_TOPIC` alias, **not** parity-guarded by design).
- `messaging/` — `bare-json-nats.{serializer,deserializer}.ts` (copies of Fulfillment's, banner added), `nats.config.ts` (copy of Orders'), `idempotent-consumer.ts` + `processed-events.repository.ts` (verbatim canonical copies, `OI12`).
- `system-clock.ts`.

### Presentation (`apps/billing/src/presentation/`)
- `credit.controller.ts` — two `@MessagePattern(subject, Transport.NATS)` responders, header extraction (`BC1`), never throws.
- `dto/credit.dto.ts`, `rpc-error-mapper.ts` — Billing's own error vocabulary.

### Wiring
- `app.module.ts` — `CqrsModule.forRoot()`, `CREDIT_DECISION` bound to `AlwaysApproveCreditDecision`, full outbox-relay wiring.
- `main.ts` — hybrid HTTP + one NATS microservice, no Kafka consumer transport.

### The outbox-relay service-neutral refactor (design §9, bounded to Group A)
- `apps/orders/src/infrastructure/persistence/client.ts` + `apps/fulfillment/.../client.ts` + `apps/billing/.../client.ts`: each gained `export type WriteModelDb = <Service>Db;`.
- `apps/orders/src/infrastructure/outbox/outbox-relay.ts`: `OrdersDb` → `WriteModelDb` (1 import, 2 references).
- `apps/orders/.../kafka.config.ts`: `export const FACTS_TOPIC = ORDERS_FACTS_TOPIC;`; `apps/orders/.../kafka-fact-publisher.ts`: imports `FACTS_TOPIC`. Same alias added to Fulfillment's and Billing's `kafka.config.ts`.
- `apps/fulfillment/.../outbox-relay.ts` and `kafka-fact-publisher.ts` re-synced to the canonical bodies.
- **Deviation D2 (see §4):** `apps/fulfillment/.../outbox-recorder.ts` also needed a one-line JSDoc fix to become byte-identical to the canonical after banner-stripping — not named in task A4, but required for `OB1` to pass. See §4.
- New: `apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts` (`OB1`/`BC17`, 3 cases).

### `apps/seed` (Group G + the human's amendment)
- `outbox-parity.spec.ts` — `stripSqlComments` in `normalise()` (`N1`/`BC18`); statement count unchanged (8/8/8 before and after — see §3).
- `verify.ts` — `assertEqual` (reference data: `currencies`, `products`, `retailers`, `companies`, `stock`, `credits`) vs `assertAtLeast` (everything saga-grown); extracted the pure `verifyCounts` function for `BC19`'s Docker-free unit test (`N3`).
- `verify.spec.ts` (new) — `BC19`.
- `credits.data.ts` (**the human's binding amendment to open point 12**) — additive baseline: every `(retailerCode, companyCode)` pair now has a credit line (7 × 22 = 154 total), not just the 7 primary-supplier pairs. `CR-000001`..`CR-000007` (the primary lines) keep their exact original codes, ids and amounts; the baseline lines continue the sequence from `CR-000008`.
- `reference-data.spec.ts` — updated for the new `CREDITS` cardinality, plus a new describe block: *"every (retailer, company) pair reachable from a seeded order has both stock and a credit line"* — the cheap class-level invariant test the leader asked me to consider. It is genuinely cheap (pure fixture-array assertions, no I/O) and would have caught this exact defect class before a live-boot pass ever ran.

---

## 2. `R<n>`/`BC<n>` → test mapping

### Shared rows (`specs/shared/test-matrix.md` §5, flipped `TODO → DONE`)

| Id | Test | Status |
|---|---|---|
| R37 | `apps/billing/src/domain/buyer-credit.spec.ts` › `buyer-credit.spec — R37` › *keeps active holds plus open exposure within the credit limit and raises on any update or deletion of a ledger entry* | DONE |
| R38 | `apps/billing/src/domain/credit-hold.spec.ts` › `credit-hold.spec — R38` › *appends a hold entry and emits exactly one credit.approved.v1 carrying the held amount and the resulting available credit* + integration half `credit-hold.integration.spec.ts` | DONE |
| R39 | `apps/billing/src/domain/credit-hold.spec.ts` › `credit-hold.spec — R39` › *appends no ledger entry and emits credit.rejected.v1 with a machine-readable reason when the amount exceeds the available credit or the credit port refuses* (matrix row's case name amended in the same edit, matching the shared-spec amendment) | DONE |
| R40 | `apps/billing/src/domain/credit-ledger.spec.ts` › `credit-ledger.spec — R40` › *appends a consume entry at invoice issue that leaves available credit numerically unchanged and emits no fact* — ledger arithmetic proven; `consumeHold` has no caller until feature 21 (matrix note preserved) | DONE |
| R41 | `apps/billing/src/domain/credit-ledger.spec.ts` › `credit-ledger.spec — R41` › *releases with reason invoice_paid on payment and with reason order_cancelled on cancellation, restoring available credit without going below zero* — `releaseHold` has no caller until features 22/25 | DONE |
| R42–R44 | Left `TODO` — feature 20's rows, unowned by this feature | TODO |

Coverage summary row: `billing_credit` 8 rows, 5 green (matching `requirements.md`'s framing that R42–R44 are feature 20's). Total flips to 36/61.

### Local rows (`specs/billing_credit/requirements.md` §2, all flipped `TODO → DONE`)

All 20 `BC<n>` rows (`BC1`–`BC20`) are flipped. Test names are verbatim as recorded in the requirements table; the file itself carries the authoritative mapping so it is not duplicated here. Highlights:

- **BC1** (header refusal + causation stamping): unit `credit.controller.spec.ts`, integration `credit-hold.integration.spec.ts`.
- **BC3/BC4** (the two contract violations): `credit-hold.integration.spec.ts`.
- **BC7** (already_held after a release): unit `credit-hold.handler.spec.ts` + integration (both the plain re-issue and the released-then-re-issued variant).
- **BC9** (the concurrent-hold race, 10 fresh lines): `credit-hold-race.integration.spec.ts`.
- **BC13/BC14** (the credit-decision port's ordering and type guarantees): `credit-hold.handler.spec.ts` (a recording fake asserting zero calls on the over-limit path) + `credit-decision.port.spec.ts` (`@ts-expect-error` probe, checked by `pnpm typecheck`).
- **BC17** (`OB1`): `apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts`, 3 cases, now comparing 3 copies.
- **BC18/BC19**: `apps/seed/src/outbox-parity.spec.ts` and the new `verify.spec.ts`.
- **BC20**: this document, § Live boot below.

---

## 3. Real output

### Domain + application unit suite

```
$ pnpm --filter @otc/billing test
 Test Files  15 passed (15)
      Tests  56 passed (56)
```

Domain coverage (`pnpm --filter @otc/billing test:coverage`):

```
domain            |   95.89 |    89.47 |   93.87 |   95.58
 buyer-credit.ts  |   93.75 |    86.66 |   92.59 |   93.15
 ...dger-entry.ts |      90 |      100 |    87.5 |      90
application       |   90.47 |       80 |     100 |   90.24
presentation      |     100 |    88.23 |     100 |     100
All files         |   96.74 |    90.29 |   96.51 |   96.62
```

Well above the ≥80% domain / ≥60% overall gates.

### Integration suite (Testcontainers MySQL + NATS + Kafka)

```
$ pnpm --filter @otc/billing test:integration
 Test Files  8 passed (8)
      Tests  28 passed (28)
```

8 files: `migrations.integration.spec.ts`, `buyer-credit.repository.integration.spec.ts`, `credit-read.repository.integration.spec.ts`, `outbox-relay.integration.spec.ts`, `credit-hold.integration.spec.ts`, `credit-hold-race.integration.spec.ts`, `credit-list.integration.spec.ts`, `credit-wire.integration.spec.ts`.

### `OB1`/`BC17` — the parity guard, armed

```
$ pnpm --filter @otc/orders test -- outbox-relay.parity
 Test Files  29 passed (29)
      Tests  390 passed (390)
```

All 3 cases green, comparing **3** copies (orders, fulfillment, billing). Before Group F1 copied Billing's files, case 1 (byte-identity ≥3 copies) and case 3 (census) failed as the spec predicted — the correct intermediate state.

### `OI12` — idempotent-consumer parity, now comparing 3 copies

```
$ pnpm --filter @otc/orders test -- idempotent-consumer.parity
 Test Files  29 passed (29)
      Tests  390 passed (390)
```

### Orders/Fulfillment full suites, re-run after the relay refactor

```
$ pnpm --filter @otc/orders test        → 29 files, 390 tests, green
$ pnpm --filter @otc/fulfillment test   → 16 files, 75 tests, green
```

### `apps/seed` — the outbox-parity comment-stripping fix (`N1`/`BC18`)

Compared-statement count, before and after the fix (recorded per task G1 — *"a fix that silently changes what is compared would be worse than the bug"*):

```
before: orders 8, fulfillment 8, billing 8
after:  orders 8, fulfillment 8, billing 8
```

**Unchanged.** The counts staying identical is the correct outcome: the committed migrations already avoid a literal "outbox" mention inside a comment-only chunk (that workaround is what forced migration `0002`'s header to say "the fact-relay table" in the first place). The fix does not change *what* is compared today — it removes the need for that workaround going forward, and the new `BC18` test cases assert the comment-stripping behaviour directly rather than relying on today's fixture data to exercise it.

### `apps/seed` full suite + integration

```
$ pnpm --filter @otc/seed test              → 8 files, 119 tests, green
$ pnpm --filter @otc/seed test:integration  → 1 file, 6 tests, green (seed.integration.spec.ts, real MySQL x3 + Mongo)
```

### Full repo

```
$ pnpm run quality   (lint && typecheck && test, all 10 workspace packages)
→ green, twice (once mid-implementation, once as the final gate)
$ ./init.sh
→ exit 0, "no feature in_progress"
```

---

## 4. Deviations from the spec, argued

**D1 — `reconstitute` checks B1 and B3 only, deliberately not B5 per order.** `tasks.md` B4 literally says *"refuses a snapshot breaking B1/B3"* — B5 (an order's exposure never negative) is not in that list. This is not an oversight: `BC11`'s third clause (*"refuses a release that would drive exposure below zero"*) needs a way to reach `CreditReleaseUnderflowError` at all, and since `releaseHold` always releases exactly the order's current outstanding exposure (never an explicit caller-supplied amount), that branch is otherwise structurally unreachable through normal operation. Feeding `reconstitute` a snapshot with a corrupted per-order ledger (constructed directly in the domain unit test, never via the repository) is the only way to exercise it, and the design's own task list permits this by omission. Recorded here so a reviewer checking `BuyerCredit.reconstitute` against `StockItem.reconstitute`'s more exhaustive validation understands why the two are not symmetric.

**D2 — `apps/fulfillment/src/infrastructure/outbox/outbox-recorder.ts` gained a one-line fix beyond task A4's named scope.** Task A4 names only `outbox-relay.ts` and `kafka-fact-publisher.ts` as needing re-sync to the canonical body. Building the actual `OB1` guard (task A5) surfaced that `outbox-recorder.ts` also diverged from the canonical by one line **inside** its `record()` method's JSDoc (not inside the leading banner block the guard strips) — Fulfillment's copy read *"Assigns no sequence — the store does, via AUTO_INCREMENT — and no / MySQL cursor..."* where the canonical reads *"...AUTO_INCREMENT (§3.2) — and / no MySQL cursor..."* (a stray reflow that also dropped a `§3.2` reference). This is a pure comment-text fix, zero behavioural change, and was necessary for the guard's byte-identity case to pass truthfully rather than being weakened to tolerate it. `git diff --stat apps/fulfillment` therefore shows 5 files, not the 4 task A4 names — the fifth is this one-line comment fix, confirmed via `diff` to be the *only* remaining non-banner divergence across all seven family files before this fix.

**D3 — the human's amendment to open point 12 landed as designed, and exceeded its own prediction.** The spec's own §11 predicted a *split* outcome live (`ORD-000010/11` advancing, `ORD-000007/8/9` staying parked on `BC3`'s `NOT_FOUND`) as the pre-amendment baseline. With the amendment applied, **all five** parked orders advanced to `despatched`/parked-at-`invoice.issue` — see § Live boot. This is the intended, better outcome the amendment was approved for, not a divergence from it.

**D4 — the `CreditHoldRequestDto`'s nested `amount` field name.** `design.md` §4.2's prose describes the nested object as `{ minorUnits: int, currency }`, but the *actual* generated `@otc/contracts` `Money` interface (and `asyncapi.yaml`'s own `Money` schema, `components.schemas.Money.properties`) names the field `amount`, not `minorUnits`. The DTO `implements CreditHoldRequestPayload` field-for-field, so it necessarily follows the real generated type (`{ amount: MinorUnits; currency: CurrencyCode }`) rather than the design prose. Confirmed correct against the live wire: `apps/orders/src/application/saga-command-payloads.ts`'s existing `credit.hold` payload construction (feature 16, unmodified by me) already builds `amount: { amount: order.totalAmount.amount, currency: ... }` — the caller and this feature's DTO agree. Recorded as a design-prose imprecision, not a code defect.

No other deviations from `tasks.md` were needed; every group A–J's tasks are ticked.

---

## 5. Live boot — `BC20`

**Pre-state** (read before touching anything, `2026-08-22`, UTC):

```sql
-- otc_orders
SELECT o.order_reference, r.code, c.code, o.status, o.total_amount FROM orders o
  JOIN retailers r ON r.id=o.retailer_id JOIN companies c ON c.id=o.company_id ORDER BY o.order_reference;

ORD-000001  CarrefourEs    IBERFOODS    completed        17492
ORD-000002  CarrefourFr    FRESHFR      completed        11194
ORD-000003  LeroyMerlinEs  TOOLIBERIA   completed        18384
ORD-000004  AldiDe         GERMANFOODS  completed        25988
ORD-000005  AldiGb         UKDISTRIB    completed         9965
ORD-000006  CarrefourEs    IBERFOODS    cancelled        24999
ORD-000007  AldiDe         ALBIONFOODS  stock_reserved   49998
ORD-000008  AldiDe         ALBIONFOODS  stock_reserved   49698
ORD-000009  AldiDe         ALBIONFOODS  stock_reserved   49698
ORD-000010  CarrefourEs    IBERFOODS    stock_reserved   74997
ORD-000011  CarrefourEs    IBERFOODS    stock_reserved   74997

SELECT order_reference, command, status, attempts FROM saga_commands
  WHERE order_reference IN (...007..011) ORDER BY order_reference, command;
-- credit.hold parked (81/81/81/87/87 attempts), stock.reserve sent — matches design.md §11 exactly.

-- otc_billing
SELECT code, retailer_code, company_code, credit_limit FROM credits;
-- 7 rows: CR-000001..CR-000007, one per retailer's primary supplier. No (AldiDe, ALBIONFOODS) line.
SELECT COUNT(*) FROM credit_items;  -- 15
```

Pre-state matches `design.md` §11's table exactly, confirming the design was written against this live database.

**Step 1 — re-seed additively (the human's amendment, applied before booting Billing so the fix is live for the sweeper's next retry, not deferred to after):**

```
$ pnpm seed
[seed] OK — self-verification summary:
{ "billing": { "credits": 154, "creditItems": 15, ... }, ... }
```

`credits` grew 7 → 154 (7 retailers × 22 companies). Verified:

```sql
SELECT code, retailer_code, company_code, credit_limit FROM credits
  WHERE retailer_code='AldiDe' AND company_code='ALBIONFOODS';
-- CR-000124  AldiDe  ALBIONFOODS  500000
```

**Step 2 — build and start Orders, Fulfillment and Billing** against the running compose stack (`otc-mysql`, `otc-kafka`, `otc-nats`, `otc-mongodb` already up). `SAGA_SWEEPER_INTERVAL_MS` unset → default `30_000`ms.

**Step 3 — observed, unattended, within roughly one sweeper cycle:**

```sql
-- otc_orders, ~90s after Billing came up
SELECT order_reference, status FROM orders WHERE order_reference IN (...007..011);
ORD-000007  despatched
ORD-000008  despatched
ORD-000009  despatched
ORD-000010  despatched
ORD-000011  despatched

SELECT order_reference, command, status FROM saga_commands
  WHERE order_reference IN (...007..011) AND command='invoice.issue';
ORD-000007  invoice.issue  parked   (last_error: transport failure on subject "billing.invoice.issue": no responder is subscribed to this subject)
ORD-000008  invoice.issue  parked   (same)
ORD-000009  invoice.issue  parked   (same)
ORD-000010  invoice.issue  parked   (same)
ORD-000011  invoice.issue  parked   (same)

-- otc_billing
SELECT order_reference, type, amount FROM credit_items WHERE order_reference IN (...007..011);
ORD-000007  hold  49998
ORD-000008  hold  49698
ORD-000009  hold  49698
ORD-000010  hold  74997
ORD-000011  hold  74997
-- 5 credit.approved.v1 rows in outbox, all published_at NOT NULL

-- otc_fulfillment
SELECT order_reference, status FROM reservations WHERE order_reference IN (...007..011);
-- all 5: consumed
SELECT despatch_reference, order_reference FROM despatches WHERE order_reference IN (...007..011);
-- DES-000006 ORD-000011, DES-000007 ORD-000010, DES-000008 ORD-000008, DES-000009 ORD-000007, DES-000010 ORD-000009
```

**Result: all five previously-parked orders reach `despatched`, parked at `invoice.issue`** — the first three-service crossing in this repository, and (thanks to the seed fix) *every one* of the five parked orders advances, not just `ORD-000010/11` as the pre-amendment design predicted. `ORD-000007/8/9` no longer hit `BC3`'s `NOT_FOUND` because `(AldiDe, ALBIONFOODS)` now has a credit line (`CR-000124`).

**A note on the boot itself, for the record:** two stale Orders/Fulfillment processes from an earlier session (running since `07:26`, ~5.5h) were already up when this pass started; they were killed cleanly (`SIGTERM`) and restarted fresh once it became clear their saga-command-sweeper had stalled (their own port conflict with my first, aborted start attempt appears to have triggered a Kafka consumer-group rebalance that the long-running instances did not recover from). Fresh instances of all three services picked the parked rows up on the very next due `next_attempt_at`, within seconds — nothing in this feature's own code was implicated; recorded here in case a future implementer sees the same symptom against this long-lived dev stack.

### The genuine over-limit compensation — `R44`'s last clause, no simulator bound

Available credit on `CR-000001` (`CarrefourEs`/`IBERFOODS`) after the two holds above: `500 000 − 74 997 − 74 997 = 350 006`. `15 × PRD-0001` (`24 999` each) = `374 985` — over the limit, and `374 985 mod 100 = 85`, unmistakably not the `.99` affordance.

Placed via `orders.create` directly against the running Orders NATS responder (twice, independently — the first via a malformed fire-and-forget request that still ran server-side, the second a proper request/reply). **Both ran the full compensation end to end, in well under one second:**

```sql
-- otc_orders
SELECT order_reference, status, cancellation_reason, total_amount FROM orders
  WHERE order_reference IN ('ORD-000012','ORD-000013');
ORD-000012  cancelled  credit_rejected  374985
ORD-000013  cancelled  credit_rejected  374985

SELECT event_type, correlation_id, occurred_at FROM outbox o JOIN orders ord ON ord.id=o.aggregate_id
  WHERE ord.order_reference IN ('ORD-000012','ORD-000013') ORDER BY seq;
order.placed.v1     87077555-...  2026-08-22 11:17:19.527
order.cancelled.v1  87077555-...  2026-08-22 11:17:20.200   -- 673ms later
order.placed.v1     8645fe18-...  2026-08-22 11:17:41.501
order.cancelled.v1  8645fe18-...  2026-08-22 11:17:41.905   -- 404ms later

-- otc_billing
SELECT event_type, correlation_id, payload FROM outbox WHERE event_type='credit.rejected.v1' ORDER BY seq DESC LIMIT 2;
credit.rejected.v1  8645fe18-...  {"reason":"over_limit","currency":"EUR","creditCode":"CR-000001",
  "companyCode":"IBERFOODS","retailerCode":"CarrefourEs","orderReference":"ORD-000013",
  "availableCredit":350006,"requestedAmount":374985}
credit.rejected.v1  87077555-...  {"reason":"over_limit", ... "orderReference":"ORD-000012",
  "availableCredit":350006,"requestedAmount":374985}

SELECT * FROM credit_items WHERE order_reference IN ('ORD-000012','ORD-000013');
-- ZERO rows — B1: "a hold that would break the limit is not recorded"

-- otc_fulfillment
SELECT order_reference, product_code, units, status FROM reservations
  WHERE order_reference IN ('ORD-000012','ORD-000013');
ORD-000012  PRD-0001  15  released
ORD-000013  PRD-0001  15  released

SELECT event_type, correlation_id FROM outbox WHERE event_type='stock.released.v1' ORDER BY seq DESC LIMIT 2;
stock.released.v1  8645fe18-...
stock.released.v1  87077555-...
```

**Confirmed, twice: `credit.rejected.v1` with `reason: over_limit`, exactly the requested/available amounts computed by hand above; `stock.release`/`stock.released.v1` compensation; the order reaching `cancelled`/`credit_rejected`; and `credit_items` gained no row for either order.** This is the first end-to-end compensation this repository has run, and it ran without the credit-check simulator — `R44`'s last clause ("the simulator must not be the only way to reach a genuine over-limit rejection") is satisfied before feature 20 exists.

### `pnpm seed` after live traffic (`N3`/`I4`)

```
$ pnpm seed   (after the live boot above: 13 orders, 10 despatches, 20 credit items, ...)
[seed] OK — self-verification summary:
{ "orders": {"orders":13,"orderItems":18,"outbox":31,...},
  "fulfillment": {"despatches":10,"outbox":26,...},
  "billing": {"credits":154,"creditItems":20,"outbox":28,...},
  "mongoOrderTimelines":6 }
[seed] done.
```

Exit 0 both times run (idempotent, deterministic counts across two runs). Before this feature's `N3` fix, `assertEqual('orders.orders', 13, 6)` would have thrown and exited 1 on this exact long-lived database.

---

## 6. Manual verification script (for the human)

```bash
pnpm --filter @otc/billing test                 # 15 files / 56 tests
pnpm --filter @otc/billing test:coverage         # domain ≥80%, overall ≥60%
pnpm --filter @otc/billing test:integration      # 8 files / 28 tests (needs Docker)
pnpm --filter @otc/orders test -- outbox-relay.parity        # OB1, 3 cases, 3 copies
pnpm --filter @otc/orders test -- idempotent-consumer.parity # OI12, now 3 copies
pnpm --filter @otc/orders test && pnpm --filter @otc/fulfillment test
pnpm --filter @otc/seed test && pnpm --filter @otc/seed test:integration
pnpm run quality
./init.sh
```

Live boot (compose stack already up): `pnpm seed`, then start `apps/orders`, `apps/fulfillment`, `apps/billing`; observe `otc_orders.orders`/`otc_billing.credit_items`/`otc_fulfillment.despatches` for `ORD-000007..011` within one sweeper interval, then place a fresh order against `(CarrefourEs, IBERFOODS)` for enough units to exceed whatever's left of `CR-000001`'s `500 000` limit.

---

## 7. Packages added (for the commit message)

`apps/billing/package.json`: `@nestjs/cqrs`, `@nestjs/microservices`, `class-transformer`, `class-validator`, `kafkajs`, `nats` (deps); `@nestjs/testing`, `@testcontainers/kafka`, `@testcontainers/nats` (dev) — all `catalog:`, no new catalog entries.

---

## 8. Hand-over

- **`N2`** (design §10.3) — `despatch-creation.handler.ts:99-100`'s `companyCode`/`retailerCode` sourcing asymmetry: reassigned, not fixed here (correct today, a comprehension hazard). Owner: the next pass that opens `apps/fulfillment/src/application/` for its own reasons, feature 27's retry/DLQ work at the latest.
- **The missing `billing.credit.release` subject** — `releaseHold` is delivered and unit-tested but has no responder; `asyncapi.yaml` defines no such channel even though `requestOrdersCancel`'s description implies one. Owner: whoever specifies `orders.cancel`'s unwind (feature 25 at the latest; natural slot is the feature-22 shared pass).
- **The messaging-family parity guard** (design §4.3) — the bare-JSON `(de)serializer` pair is now a third byte-identical copy (Orders' original → Fulfillment → Billing) but is not yet parity-guarded the way the outbox-relay family now is. Banners are in place so a guard can be armed retroactively without touching the copies. Recorded as an open point, not smuggled into this feature.
- **The seeded credit-line coverage decision** (design §11) — resolved via the human's binding amendment: every `(retailerCode, companyCode)` pair now has a baseline credit line, mirroring `stock.data.ts`'s existing baseline-coverage pattern for stock. `apps/seed/src/data/reference-data.spec.ts` now carries the class-level invariant test the leader asked me to consider (`"every (retailer, company) pair reachable from a seeded order has both stock and a credit line"`), which is cheap (pure fixture-array assertions) and would have caught this exact defect class — and the earlier `stock.data.ts` one from `review_fulfillment_stock.md` — before either reached a live-boot pass.
- **Feature 22's same-transaction ordering note** (design §9.5) — `payment.received.v1` and `credit.released.v1` must be written to the outbox in one transaction, in that order, on the same partition key. Nothing in this feature exercises it (`releaseHold` has no caller yet); the constraint is written down here per the design so feature 22 does not have to rediscover it — a single `outboxRecorder.record(tx, [...])` call in emission order is sufficient, since the relay's `ORDER BY seq` poll and the shared `correlationId` key already preserve ordering.

---

## 9. Deviations summary (quick reference)

| # | What | Where | Why it's not a defect |
|---|---|---|---|
| D1 | `reconstitute` checks B1/B3 only, not B5 per order | `buyer-credit.ts` | `tasks.md` B4's own wording; needed to make `BC11`'s underflow branch reachable at all |
| D2 | `outbox-recorder.ts` gained a 1-line JSDoc fix beyond task A4's named files | `apps/fulfillment/.../outbox-recorder.ts` | Required for `OB1`'s byte-identity case to pass truthfully; zero behavioural change |
| D3 | All 5 parked orders advanced live, not just 2 as the pre-amendment design predicted | live boot | The intended, better outcome of the human's amendment |
| D4 | `CreditHoldRequestDto.amount`'s nested field is named `amount`, not `minorUnits` as design.md §4.2's prose says | `credit.dto.ts` | Follows the real generated `@otc/contracts` type and the real live caller (`apps/orders`'s existing, unmodified `saga-command-payloads.ts`), not the design's prose paraphrase |
