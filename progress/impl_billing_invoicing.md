# `billing_invoicing` (feature 21, phase 10) — implementation record

> Written by the implementer. Traces every `BI<n>` and the shared `R45`/`R46` to a named, green test; records the three armed fact-deletion results (fact-emission rule, `CLAUDE.md`); records the live-boot evidence (`BI22`); records what was not done and why.

## What was built

The `Invoice` aggregate root (`domain/invoice.ts`), its `InvoiceLine` child entity, the `invoice.issued.v1`/`payment.received.v1` fact builders, the seven domain errors, the two-aggregate issue transaction (`InvoiceIssueHandler`), the `INV-######` allocator (a copy of Fulfillment's despatch allocator), the write/read Drizzle repositories, the two NATS responders (`billing.invoice.issue`, `billing.invoice.list`), the migration adding `invoice_number_sequences` and `uq_invoices_order_reference`/`idx_invoices_status_invoice_date`, the four inherited findings from `review_billing_credit_simulator.md` (N1, N2, N3, N5), and the gated `apps/orders` discount fix (row 5, approved).

## Files touched

### `apps/billing` — new

- `src/domain/invoice.ts`, `invoice-line.ts`, `invoice-snapshot.ts`, `invoice-events.ts`, `invoice-errors.ts`
- `src/domain/invoice.spec.ts`, `invoice-events.spec.ts`
- `src/application/ports/invoice-repository.port.ts`, `invoice-read.port.ts`, `invoice-number-allocator.port.ts`
- `src/application/invoice-application-errors.ts`, `invoice-issue.handler.ts`, `invoice-issue.handler.spec.ts`
- `src/application/commands/invoice.commands.ts`, `invoice.command-handlers.ts` (+ spec)
- `src/application/queries/invoice.queries.ts`, `invoice.query-handlers.ts` (+ spec)
- `src/infrastructure/persistence/invoice.mapper.ts`, `invoice.repository.ts`, `invoice-read.repository.ts`, `invoice-number-allocator.ts`
- `src/infrastructure/persistence/invoice.repository.integration.spec.ts`, `invoice-read.repository.integration.spec.ts`, `invoice-number-allocator.spec.ts`, `invoice-number-allocator.integration.spec.ts`
- `src/infrastructure/persistence/schema/invoice-number-sequences.schema.ts`
- `src/presentation/dto/invoice.dto.ts`, `invoice.controller.ts` (+ spec), `rpc-meta.ts`
- `src/billing-consumes-no-facts.spec.ts`
- `src/invoice-issue.integration.spec.ts`, `invoice-issue-race.integration.spec.ts`, `invoice-list.integration.spec.ts`, `invoice-wire.integration.spec.ts`
- `src/test-support/cents-rule-fixture-guard.ts` (+ spec, + `__fixtures__/cents-rule-guard-non-vacuity/fixture.integration.spec.ts`)
- `apps/billing/drizzle/0002_invoice_sequences_and_order_uniqueness.sql` (+ `drizzle/meta/0002_snapshot.json`, `_journal.json` entry)

### `apps/billing` — modified

- `src/app.module.ts` (`InvoiceController`, the two handler sets, five `useFactory` providers)
- `src/domain/index.ts` (barrel, extended)
- `src/infrastructure/persistence/schema/invoices.schema.ts` (`uq_invoices_order_reference`, `idx_invoices_status_invoice_date`)
- `src/infrastructure/persistence/schema/index.ts` (+ the new table)
- `src/infrastructure/persistence/migrations.integration.spec.ts` (table count 7→8, two new index assertions)
- `src/infrastructure/credit/simulator-credit-decision.ts` (+ spec) — N3
- `src/infrastructure/credit/always-approve-credit-decision.ts` — N5
- `src/presentation/credit.controller.ts` (hoisted `parseRpcMeta`/`missingHeadersRpcError` into `rpc-meta.ts`) — F1
- `src/presentation/rpc-error-mapper.ts` (+ spec) — the four added cases
- `src/credit-rejection-parity.integration.spec.ts` — N1 (observed-key parity)
- `src/test-support/credit-integration-harness.ts` → renamed `billing-integration-harness.ts`, extended with `seedInvoice`, `invoicesOf`, `invoiceItemsOf`, `holdRequest`, `issueRequest` (`assertNotCentsRuleAmount`-guarded); the four consuming credit specs updated to the new name

### `apps/orders` — gated on row 5, approved

- `src/application/saga-command-payloads.ts` — `invoice.issue` case gains `discount: order.initialDiscount.amount`
- `src/application/saga-command-payloads.spec.ts` — new file, `BI21`, drives the REAL `orders.create` path (`PlaceOrderHandler` + fakes, never a hand-rolled `Order`)

### Specs

- `specs/shared/test-matrix.md` — `R45`, `R46` rows only, flipped to `DONE`; coverage summary counts updated (`billing_invoicing` 5 rows, 2 green; total 38)
- `specs/billing_invoicing/requirements.md` §3 — `BI1`–`BI22` flipped to `DONE`, verbatim test names

**Packages added: none.** Everything (`@nestjs/cqrs`, `@nestjs/microservices`, `class-validator`, `class-transformer`, `kafkajs`, `nats`, `@nestjs/testing`, `@testcontainers/*`) was already in `apps/billing/package.json` from feature 19 (design.md §13).

## Traceability

Shared `R45`/`R46` and `BI1`–`BI22` are traced verbatim in `specs/shared/test-matrix.md` §6 and `specs/billing_invoicing/requirements.md` §3 respectively — not restated here to avoid a second copy drifting from the first.

## Group A — inherited findings (N1, N3, N5) disposition

- **N3** (`simulator-credit-decision.ts`): a numeral-shape regex (`/^(?:\d+|\d*\.\d+)$/`) now runs on the trimmed `CREDIT_FAILURE_RATE` value before `Number()` ever sees it — `'0x1'`, whitespace-only, `'1e0'`, `'+0.5'`, `'NaN'` all now fail to start; `'0'`, `'1'`, `'0.25'`, `''`, absent are unchanged. Proven by `BI18`.
- **N5** (`always-approve-credit-decision.ts`): header trimmed to the true claim — the port's reference implementation and the provider a future harness may bind via `overrideProvider` — dropping the "for any harness that wants approve-everything behaviour" line that named no real consumer. Comment-only; the class, binding and spec are untouched (`BI20`).
- **N1** (`credit-rejection-parity.integration.spec.ts`): the `R44` parity assertion now compares the over-limit payload's key set against the OBSERVED simulated-rejection payload's key set (a `simulatedRejectionKeys` `let`, populated by the first `it`, read by the second), not a hard-coded literal array (`BI19`).
- **N2** (the `.99` fixture hazard) is closed by `test-support/cents-rule-fixture-guard.ts` — both the runtime `assertNotCentsRuleAmount` (called by the harness's `holdRequest`/`issueRequest`/`seedCreditItem` builders on the COMPUTED total) and the text-scan backstop `findUnguardedCentsRuleLiterals` (money-position-keyed, comment-stripped, scoped to `*.integration.spec.ts`), proven by `BI17`.

Group A5 confirmed: `git diff --stat` over `apps/billing/src/infrastructure/credit/` and `credit-rejection-parity.integration.spec.ts` shows exactly the four files A1–A4 name; `buyer-credit.ts`, `credit-hold.spec.ts` and `credit-hold.handler.ts` are untouched.

## The three armed fact-deletion records (fact-emission rule)

### H8 — `invoice.issued.v1` (live caller: `InvoiceIssueHandler.issue`)

Deleted `invoice.appendFact(event);` from `Invoice.issue` (`domain/invoice.ts`), leaving `void event;` in its place. Ran `apps/billing`'s domain suite (`npx vitest run domain/invoice.spec.ts domain/invoice-events.spec.ts`).

**Result: 3 tests failed**, all with the same shape —
```
FAIL src/domain/invoice-events.spec.ts > invoice-events.spec — BI13 > stamps invoice.issued.v1 with the invoice as aggregateId, the order as correlationId and the request as causationId
AssertionError: expected undefined to be defined
FAIL src/domain/invoice-events.spec.ts > invoice-events.spec — BI13 > one builder, one call site: invoice.issued.v1 is produced only by Invoice.issue
AssertionError: expected [] to have a length of 1 but got +0
FAIL src/domain/invoice.spec.ts > invoice.spec — R45 > creates exactly one issued invoice mirroring the despatched lines with a non-negative total and returns the existing reference emitting no second fact on a repeat
AssertionError: expected [] to have a length of 1 but got +0
```
Restored (`git diff` clean); re-ran green (19/19).

### H9 — `payment.received.v1` (double force: NO live caller in this feature)

Deleted `this.appendFact(event);` from `Invoice.markPaid` (`domain/invoice.ts`), leaving `void event;`. Ran `apps/billing`'s `domain/invoice.spec.ts`.

**Result: 2 tests failed** —
```
FAIL src/domain/invoice.spec.ts > invoice.spec — R46 > allows only the transition from issued to paid, sets paidAt exactly then, and raises on every other transition changing and emitting nothing
AssertionError: expected [] to have a length of 1 but got +0
FAIL src/domain/invoice.spec.ts > invoice.spec — BI14: moves issued to paid setting paidAt in the same step and appending one payment.received.v1, and refuses a second payment, a mismatched amount and a mismatched currency > moves issued to paid, setting paidAt in the same step and appending exactly one payment.received.v1
AssertionError: expected [] to have a length of 1 but got +0
```
Restored (`git diff` clean); re-ran green (17/17). This is the double-force case `requirements.md`'s preamble calls out: `markPaid` has no live caller in this feature (feature 22's), so no integration harness can reach the deletion — only the domain unit test guards it, and it does.

### H10 — R40's suppression, inverted (a missing emission cannot be deleted)

Temporarily edited `DrizzleBuyerCreditRepository.save` (`infrastructure/persistence/buyer-credit.repository.ts`) to record one spurious extra outbox event (`eventType: 'credit.consumed.v1'`) after the legitimate (empty, for `consume`) drain — simulating a regression where `R40`'s `consume` starts emitting a fact it must not. Strengthened `invoice.repository.integration.spec.ts`'s `BI7` test with a DELTA assertion (`outboxCountAfterIssue - outboxCountBeforeIssue`) — a whole-table, unfiltered-by-`aggregateId` count, because the existing `aggregateId`/`eventType`-scoped assertions are keyed to the invoice side and a credit-side spurious row is invisible to them (recorded here as a real finding, not hidden). Ran `invoice.repository.integration.spec.ts` (Testcontainers).

**Result: 1 test failed** —
```
FAIL src/infrastructure/persistence/invoice.repository.integration.spec.ts > DrizzleInvoiceRepository — BI7 (Testcontainers: mysql:8.4.11) > commits the invoice, its lines, the consume ledger entry and the outbox record together, and leaves none of them behind when the transaction rolls back
AssertionError: expected 2 to be 1
 ❯ src/infrastructure/persistence/invoice.repository.integration.spec.ts:128:60
```
Restored `buyer-credit.repository.ts` (`diff` against the pre-edit backup is empty); the strengthened DELTA assertion in `invoice.repository.integration.spec.ts` is KEPT (a genuine improvement, not part of the reverted deletion) and re-ran green.

**Honest caveat on H10's scope.** The task brief asked to "confirm `BI7`/`H4` fail." `H4` (`invoice-issue.integration.spec.ts`'s *emits no fact of any type on every refusal path*) is structurally unable to observe a consume-path regression: none of its four refusal scenarios (`BI3` no credit line, `BI4` currency mismatch, `BI5` no active hold, `BI2` malformed payload) ever reaches `consumeHold` — refusal and consumption are mutually exclusive branches. `BI7`'s now-strengthened DELTA assertion is the guard that actually catches an R40 regression, and it does; `H4` remains a true statement about a different, non-overlapping set of paths.

## Live boot — `BI22`

### J1 — pre-state, recorded before touching anything

`SELECT ... FROM otc_orders.saga_commands WHERE command = 'invoice.issue'`: seven `parked` rows — `ORD-000007`…`ORD-000011` (attempts 60, last_error *"transport failure on subject \"billing.invoice.issue\": no responder is subscribed to this subject"*), `ORD-000018` (attempts 21), `ORD-000022` (attempts 15) — matching design §9's prediction exactly.

`otc_orders.orders`: those seven at `despatched`; `ORD-000001`…`ORD-000005` `completed`; the rest `cancelled`.

`otc_billing.invoices`: five seeded rows (`INV-000001`…`INV-000005`, all `paid`).

`otc_billing.credit_items` for the seven parked orders' credit lines: `ORD-000007/8/9` on `CR-000124` (AldiDe/ALBIONFOODS, limit 500 000, committedExposure 149 394 → availableCredit **350 606**); `ORD-000010/11/18/22` on `CR-000001` (CarrefourEs/IBERFOODS, limit 500 000, committedExposure 249 990 → availableCredit **250 010**).

### J2 — the boot

`SELECT order_reference, COUNT(*) ... HAVING COUNT(*) > 1` on `otc_billing.invoices` returned no rows (B1, before writing the unique index). Migration applied against the live dev database with `pnpm db:migrate` — clean, no `docker compose down -v`. `apps/orders`, `apps/fulfillment`, `apps/billing` built (`pnpm --filter ... build`) and started against the compose stack (`node dist/main.js`, `.env`'s ports/URLs). Billing's boot log confirms `InvoiceController {/}:` registered alongside `CreditController {/}:`.

The seven rows' `next_attempt_at` (already computed from a previous session's backoff schedule, `~05:39:08`–`05:39:19` UTC) had not yet elapsed at the moment all three services came up (`~05:24:2x` UTC) — the sweeper's immediate startup cycle caught them too early and re-parked all seven with the SAME error (attempts 63/63/63/63/63/24/18 → all bumped by exactly one), confirming the responder genuinely was not yet reachable at that instant. This is not a defect: the row's own backoff schedule, set by a prior session, simply had not come due. Waited unattended (no manual intervention on any row) until the sweeper's next 30-second cycle at `05:39:32` UTC.

**Result, all seven, fully unattended:**

```
SELECT order_reference, status FROM otc_orders.saga_commands WHERE command='invoice.issue';
→ ORD-000007  sent  (was: parked, attempts 63 → 64)
  ORD-000008  sent  (was: parked, attempts 63 → 64)
  ORD-000009  sent  (was: parked, attempts 63 → 64)
  ORD-000010  sent  (was: parked, attempts 63 → 64)
  ORD-000011  sent  (was: parked, attempts 63 → 64)
  ORD-000018  sent  (was: parked, attempts 24 → 25)
  ORD-000022  sent  (was: parked, attempts 18 → 19)

SELECT order_reference, status FROM otc_orders.orders WHERE order_reference IN (...the seven...);
→ all seven at status = invoiced

SELECT invoice_reference, order_reference, status FROM otc_billing.invoices WHERE order_reference IN (...);
→ INV-000007 ORD-000011 issued   INV-000008 ORD-000010 issued
  INV-000009 ORD-000008 issued   INV-000010 ORD-000007 issued
  INV-000011 ORD-000009 issued   INV-000012 ORD-000018 issued
  INV-000013 ORD-000022 issued

SELECT order_reference, type, COUNT(*) FROM otc_billing.credit_items WHERE order_reference IN (...) GROUP BY 1, 2;
→ exactly one `hold` and exactly one `consume` per order, zero of any other combination

SELECT COUNT(*) FROM otc_billing.outbox WHERE event_type = 'invoice.issued.v1' AND published_at IS NOT NULL;
→ 13  (the five seeded + the seven unparked + the one control order ORD-000024 — every one accounted for)
```

Billing's and Orders' stdout logs show no error of any kind during the unpark; Orders logs one `"saga-command-dispatcher: command sent"` line per order at `05:39:3x` UTC.

**`availableCredit`, side by side (R40's neutrality, now visible in production data):**

| Credit line | J1 (before touching anything) | After the seven unparked | Delta |
|---|---:|---:|---:|
| `CR-000124` (AldiDe/ALBIONFOODS — `ORD-000007/8/9`) | 350 606 | 350 606 | **0** |
| `CR-000001` (CarrefourEs/IBERFOODS — `ORD-000010/11/18/22`) | 250 010 → 200 012 (after the control order `ORD-000024`'s own, legitimate, unrelated hold of 49 998) | 200 012 | **0** |

`CR-000001`'s baseline moved once, for a reason unrelated to this evidence: the control order (J4) happens to share this same credit line and legitimately placed and consumed its own hold. Isolating that, the four newly-unparked orders on `CR-000001` (`ORD-000010/11/18/22`) changed `availableCredit` by exactly zero — the same "no change" `CR-000124`'s three orders show without any confound.

### J3 — the negative half (the designed end state, not a stall)

Quoting `saga.md` §3.1 step 5: *"The saga now waits for the outside world — no internal timer, no polling."* There is no command owed at `invoiced`, so no new `saga_commands` row is enqueued for any of the seven unparked orders.

**Confirmed, all seven:**
- `SELECT order_reference, COUNT(*) FROM otc_orders.saga_commands WHERE order_reference IN (...) GROUP BY 1;` → exactly **4** rows per order (`stock.reserve`, `credit.hold`, `despatch.create`, `invoice.issue`) — the same four as before the unpark, no fifth row of any kind (no `payment.register`).
- `SELECT order_reference, status FROM otc_orders.orders WHERE status IN ('paid','completed') AND order_reference IN (...);` → **empty**. None of the seven (nor the control order) reached `paid` or `completed`.
- `SELECT COUNT(*) FROM otc_billing.outbox WHERE event_type = 'payment.received.v1';` → **5**, identical to the pre-existing seed count — no new one.
- `SELECT COUNT(*) FROM otc_billing.outbox WHERE event_type = 'credit.released.v1';` → **5**, identical to the pre-existing seed count — no new one.

This is the designed end state, not a stall.

### J4 — the control order

`node scripts/place-order.mjs --qty 2` (2 × PRD-0001, CarrefourEs/IBERFOODS, total **49 998** minor units — not `.99`) placed `ORD-000024`. Within 15 seconds, unattended:

```
SELECT order_reference,status,cancellation_reason FROM otc_orders.orders WHERE order_reference='ORD-000024';
→ ORD-000024 | invoiced | NULL

SELECT command,status,attempts,last_error FROM otc_orders.saga_commands WHERE order_reference='ORD-000024';
→ stock.reserve   | sent | 0 | NULL
  credit.hold      | sent | 0 | NULL
  despatch.create  | sent | 0 | NULL
  invoice.issue    | sent | 0 | NULL

SELECT invoice_reference, order_reference, status FROM otc_billing.invoices WHERE order_reference='ORD-000024';
→ INV-000006 | ORD-000024 | issued
```

This is the first order in this repository observed traversing `placed → stock_reserved → credit_approved → confirmed → despatched → invoiced` unattended, in one continuous run, across all three services.

## Manual verification script for the human

1. `docker compose -f docker-compose.infra.yml ps` — confirm MySQL/Kafka/NATS healthy.
2. `pnpm db:migrate:billing` — confirm `invoice_number_sequences`, `uq_invoices_order_reference`, `idx_invoices_status_invoice_date` exist (`SHOW TABLES` / `SHOW INDEX FROM invoices`).
3. `pnpm --filter @otc/billing build && pnpm --filter @otc/orders build && pnpm --filter @otc/fulfillment build`, then start all three (`node dist/main.js` per app, or `pnpm dev:orders`/`dev:fulfillment`/`dev:billing`).
4. `pnpm saga:watch` — watch the seven previously-parked `invoice.issue` rows clear and their orders reach `invoiced`.
5. `node scripts/place-order.mjs --qty 2` — a fresh control order reaching `invoiced` within seconds.
6. `pnpm --filter @otc/billing test` (unit, fast) and `pnpm --filter @otc/billing test:integration` (Testcontainers, ~10 min) — both green.
7. `pnpm quality` from the repo root.

## What could not be done, and why

None of the tasks in `tasks.md` groups A–J were skipped. The one deviation worth naming: **H10's "confirm `H4` fails"** could not be literally satisfied because `H4`'s four scenarios never reach the consume path — see the honest caveat above. The guard exists and fires (via `BI7`'s strengthened assertion); the specific named-test list in the task brief was not fully realisable as written.

## Hand-over

- **The allocator-family parity guard** (design §7.3, open point 10): three near-identical `*-number-allocator.ts` files (`ORD-`, `DES-`, `INV-`) with no byte-identity guard. Needs the same `WriteModelDb`-style indirection feature 19 applied to the relay. Owner: the next feature that opens the persistence layer, feature 27 at the latest.
- **The `apps/orders` discount seam**: closed in this pass (row 5 approved) — no longer owed.
- **Feature 22's binding lock order** (`BI8`): `credits` → `invoices` → `invoice_number_sequences`. `billing.payment.register` must read the invoice UNLOCKED first (to find its `(retailerCode, companyCode)` pair), then take the `credits` lock, then re-read the invoice `FOR UPDATE`. Locking the invoice first closes a deadlock cycle with this feature.
- **Same-transaction fact ordering** (feature 19 design §9.5) — feature 22 inherits the same "reply built from the domain outcome before commit, returned only after `execute` resolves" discipline this feature and feature 19 both use.
- **`billing.credit.release` still does not exist.** `BuyerCredit.releaseHold` ships since feature 19 with no live caller; feature 22 (payment) and a future cancellation-after-despatch feature are its callers.

---

## Addendum — reviewer round 1 fixes (`progress/review_billing_invoicing.md`, N1/N2/N3/N7)

The reviewer rejected the first pass on two blocking findings (N1, N2) and asked for two cheap non-blocking ones closed (N3, N7). N4–N9 are explicitly carried forward by the reviewer, untouched here. The fact-guard work, the `H4` caveat and the live-boot evidence were independently re-verified by the reviewer and are unchanged.

### N1 — `tasks.md`, 0/60 → 60/60

Ticked every box in `specs/billing_invoicing/tasks.md` groups A–J — all 60 were, in fact, completed. Five boxes were also **reworded** rather than ticked silently over stale text, because the literal wording no longer matched what was built or needed the amendment recorded on the box itself (the reviewer's specific ask for `H10`):

- **B4** — the committed migration SQL was hand-trimmed after `drizzle-kit generate` (the same stale-`meta/0001_snapshot.json` artefact `apps/fulfillment`'s own `0002` migration hit); the box now says so, naming the precedent it copies.
- **F6** — "five `useFactory` providers" is now explained: four new factories plus the read port's clock wiring, which needed no fifth factory because `ListInvoicesHandler` binds the `CLOCK` token `app.module.ts` already provides.
- **H1** — records the N7 amendment (the whole-table outbox delta) and that re-arming H10 against this file now fails it too.
- **H3** — records the N3 (`ledgerOf` on `BI5`) and N2 (the discount-validation case) amendments.
- **H10** — records, on the box itself, that `H4` did not fail and could not (its four scenarios never reach the consume path), and that `H1`'s new N7 guard is what closes the responder-level half instead.

### N2 — BLOCKING — the discount-exceeds-computed-amount refusal now happens before any transaction

**Files:** `apps/billing/src/presentation/dto/invoice.dto.ts` (new `DiscountWithinComputedAmountConstraint` / `@DiscountWithinComputedAmount()` custom `class-validator` decorator on `InvoiceIssueRequestDto.discount`, comparing against `Σ unitPrice × units` over `lines`); `apps/billing/src/presentation/invoice.controller.spec.ts` (new unit case); `apps/billing/src/invoice-issue.integration.spec.ts` (extended `BI2` case).

The check runs inside the SAME `validate(dto, { whitelist: true })` call the controller already performs before it ever constructs `IssueInvoiceCommand` — so a refused request never reaches `CommandBus.execute`, never opens `UnitOfWork.execute`, never takes the `credits` row lock and never calls `invoiceNumbers.next(tx)` (the service's hottest, and by design §5.4 deliberately-last-taken, lock).

**New test names:**
- `apps/billing/src/presentation/invoice.controller.spec.ts` › *refuses a discount that exceeds the computed amount before dispatching to the command bus* — asserts `code: 'VALIDATION_FAILED'` **and** `commandExecute` (the `CommandBus.execute` mock) was never called. The property under test is deliberately not the error code alone: `IssueInvoiceCommand`'s only handler delegates straight into `InvoiceIssueHandler.issue`, the sole caller of `unitOfWork.execute`, so "the mock was never called" is direct proof no transaction was ever opened.
- `apps/billing/src/invoice-issue.integration.spec.ts` › the `BI2` case, extended with a `discount: 2_001` against a `2 × 1_000` line list — asserts `VALIDATION_FAILED`, no invoice, no ledger entry, no fact, **and** that `invoice_number_sequences`'s counter row is byte-identical before and after the request (read via `harness.db.select().from(invoiceNumberSequences)`). The counter's immutability shows nothing was written, but cannot distinguish a pre-transaction rejection from an opened-and-rolled-back one (plain rows roll back with everything else); the actual proof that rejection happens before dispatch is the unit case in presentation/invoice.controller.spec.ts, which asserts the command bus was never called. The empirical disproof: removed `@DiscountWithinComputedAmount()` from the DTO, seeded a real hold so the request would clear the `activeHold` gate and genuinely reach `invoiceNumbers.next(tx)`, and the file still reported `Tests 7 passed (7)` — the counter stays unchanged even with a real transaction.

**Armed-deletion proof (unit level):** removed `@DiscountWithinComputedAmount()` from the DTO field, re-ran `presentation/invoice.controller.spec.ts`.

```
FAIL src/presentation/invoice.controller.spec.ts > InvoiceController — validation and error mapping, never throws > refuses a discount that exceeds the computed amount before dispatching to the command bus
AssertionError: expected undefined to match object { code: 'VALIDATION_FAILED' }

- Expected:
{
  "code": "VALIDATION_FAILED",
}

+ Received:
undefined

 ❯ src/presentation/invoice.controller.spec.ts:133:20
```

Restored (`diff` against the pre-edit backup empty); re-ran green (8/8).

### N3 — non-blocking — `BI5`'s "appends no ledger entry" clause now asserted

**File:** `apps/billing/src/invoice-issue.integration.spec.ts`, the `BI5` case.

**New assertion (same `it`, not a new test — the reviewer's fix is one line inside the existing case):** `expect(await harness.ledgerOf(orderReference)).toHaveLength(2);` — the order's two pre-seeded rows (hold + release) are re-read after the refusal and must still be exactly two, proving `consumeHold` was never reached. Confirmed green as part of the file's full re-run (see below).

### N7 — non-blocking — `H1`'s outbox assertion widened to a whole-table delta

**File:** `apps/billing/src/invoice-issue.integration.spec.ts`, the `H1/R45` happy-path case.

Added `outboxCountBefore`/`outboxCountAfter` — `harness.db.select().from(outbox)`, taken immediately before the `billing.invoice.issue` request and immediately after its reply — asserting the delta is exactly `1`, mirroring `BI7`'s repository-level guard. This closes the hole the reviewer named: the pre-existing `correlationId`-scoped assertion could not see a stray fact written under a *different* `correlationId` (exactly what H10's spurious `credit.consumed.v1` event carries — the credit line's own id, not the order's).

**Re-verification (not merely trusted from the original H10 pass):** re-applied H10's spurious-outbox-record edit to `DrizzleBuyerCreditRepository.save` and re-ran `invoice-issue.integration.spec.ts` in full.

```
FAIL src/invoice-issue.integration.spec.ts > billing.invoice.issue — R45 integration half, BI2–BI6, BI9 (...) > H1/R45 — one invoices row, its invoice_items, one consume entry of exactly the hold amount, one invoice.issued.v1 outbox record whose envelope carries the order as correlationId and the request as causationId, and a reply with created: true
AssertionError: expected 2 to be 1
 ❯ src/invoice-issue.integration.spec.ts:115:50
```

`H1` now fails alongside `BI7` — the suppression guard is closed at both layers. Restored (`diff` against the pre-edit backup empty); the full 7-case file re-ran green.

### Suites re-run after all four fixes

- `pnpm --filter @otc/billing test` (unit): 25 files, 111 tests (was 110 — the one new N2 unit case), green.
- `pnpm --filter @otc/billing test:integration` (Testcontainers): re-run in full; result recorded in the close-out below.
- `pnpm quality` (root): re-run in full; result recorded in the close-out below.

No file outside `apps/billing/src/{presentation/dto/invoice.dto.ts, presentation/invoice.controller.spec.ts, invoice-issue.integration.spec.ts}` and `specs/billing_invoicing/tasks.md` was touched for this round. `specs/shared/`, `feature_list.json` and `specs/billing_invoicing/requirements.md` were left exactly as they were.
