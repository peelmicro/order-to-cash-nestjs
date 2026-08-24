# `billing_remittance_intake` (feature 22, phase 10, `sdd: false`) — implementation record

> Written by the implementer. No spec triple-doc exists for this feature; the acceptance is `specs/shared/requirements.md` R47–R49 plus `feature_list.json`'s three acceptance bullets. Traces R47–R49 to named, green tests; records the four armed-deletion results (fact-emission rule, `CLAUDE.md`); records the live-cycle evidence against the compose stack; records what was not done and why. This closes the order-to-cash cycle and Phase 10.

## What was built

The `billing.payment.register` NATS responder — the sole live caller of `Invoice.markPaid` and `BuyerCredit.releaseHold`, both delivered uncalled by features 21/19-20. A plain-class transactional handler (`PaymentRegisterHandler`) following `InvoiceIssueHandler`'s exact shape: an R48 fast path outside any transaction, then inside one `UnitOfWork.execute` — the credit line locked first (BI8, extended), the target invoice's own row locked second, an R48 authority re-read under that lock, `Invoice.markPaid` (which raises all three of R49's refusals itself — currency mismatch, amount mismatch, already-paid), `BuyerCredit.releaseHold(reason: 'invoice_paid')`, then `invoices.markPaid` persisted **before** `credits.save` so `payment.received.v1`'s outbox row is assigned a lower `seq` than `credit.released.v1`'s — R47's ordering, made structural by call order rather than incidental.

No new domain code: `Invoice.markPaid` and `BuyerCredit.releaseHold` were correct and fully unit-tested by features 21/19; I did not change their behaviour. The `payments` table (with its `payment_reference` UNIQUE constraint) already existed from the original schema migration (`0000_brown_hammerhead.sql`) — no migration was needed, and I verified this before writing any code (`grep payments apps/billing/drizzle/*.sql`).

**`apps/orders` needed no change.** `apps/orders/src/application/saga-steps.ts` and `domain/order-transitions.ts` already wire `payment.received.v1` (precondition `invoiced` → `order.markPaid`) and `credit.released.v1` (precondition `paid` → `order.complete`, emitting `order.completed.v1`) — built ahead of time as part of the saga's foundation, not something feature 22 had to add. Confirmed live: see "Live-cycle evidence" below. Per the brief's gate, I did not touch `apps/orders`.

## Files touched

### `apps/billing` — new

- `src/application/commands/payment.commands.ts` — `RegisterPaymentCommand`
- `src/application/commands/payment.command-handlers.ts` — `RegisterPaymentHandler` (`@CommandHandler`) + `PAYMENT_COMMAND_HANDLERS`
- `src/application/payment-register.handler.ts` — the plain transactional class
- `src/application/payment-register.handler.spec.ts` — unit, fakes, armed deletions
- `src/presentation/dto/payment.dto.ts` — `PaymentRegisterRequestDto` + the `AtLeastOneInvoiceIdentifier` cross-field constraint
- `src/payment-register.integration.spec.ts` — Testcontainers, R47/R48/R49 + NOT_FOUND + wire + the cross-invoice constraint backstop

### `apps/billing` — modified

- `src/application/ports/invoice-repository.port.ts` — extended (not replaced) with `findById`, `findByInvoiceReference`, `lockById`, `findPaymentByReference`, `findPaymentByInvoiceId`, `markPaid`, plus the `PaymentRecordSnapshot`/`PaymentRecordInput` supporting types. Per design.md §14's own anticipation: "persisting a `payments` row... are 22's additions to the same aggregate and the same repository file" — the port and its Drizzle adapter, not a new `PaymentRepository`.
- `src/infrastructure/persistence/invoice.repository.ts` — the six new methods; the `payments` INSERT is wrapped with the SAME duplicate-key idiom `infrastructure/messaging/processed-events.repository.ts` established (`ER_DUP_ENTRY` → a typed refusal, not a raw driver error)
- `src/infrastructure/persistence/invoice.mapper.ts` — `toPaymentRecordSnapshot`/`toPaymentTableRow`
- `src/application/invoice-application-errors.ts` — two new errors: `InvoiceNotFoundError` (identity resolution miss), `PaymentReferenceConflictError` (the belt-and-braces DB-constraint backstop)
- `src/presentation/rpc-error-mapper.ts` (+ spec) — the two new cases mapped (`NOT_FOUND`, `CONFLICT`); R49's three domain errors (`InvoiceAlreadyPaidError`, `InvoicePaymentAmountMismatchError`, `InvoicePaymentCurrencyMismatchError`) were **already** mapped by feature 21's design.md §4.3, "declared here so the vocabulary is complete on delivery" — nothing new needed for them, confirmed by reuse in my tests
- `src/presentation/invoice.controller.ts` (+ spec) — `registerPayment` method + `PAYMENT_REGISTER_SUBJECT`, on the SAME controller class as `issue`/`list` (not a third controller — see "Design choice" below)
- `src/app.module.ts` — `PaymentRegisterHandler` provider (`useFactory`, explicit `inject`), `...PAYMENT_COMMAND_HANDLERS`
- `src/test-support/billing-integration-harness.ts` — `paymentsOf`, `paymentRequest` (guarded by `assertNotCentsRuleAmount`, N2's convention extended to this subject)
- `src/application/invoice-issue.handler.spec.ts` — its hand-built `InvoiceRepository` fake gained six throwing stubs for the port's new methods (mechanical, to keep the file compiling against the extended interface)

### Specs

- `specs/shared/test-matrix.md` — R47, R48, R49 rows only, flipped to `DONE`; the coverage summary's `billing_invoicing` row updated 2 → 5 green. Nothing else touched.

**Packages added: none.** Everything needed (`@nestjs/cqrs`, `class-validator`, `class-transformer`, `nats`, `@testcontainers/*`) was already in `apps/billing/package.json`.

## Design choice recorded: one controller, not three

`billing_invoicing`'s design.md argued a separate `InvoiceController`/`CreditController` split because they answer genuinely different aggregates. `billing.payment.register`'s primary written aggregate **is** `Invoice` — the same one `billing.invoice.issue` answers for — so I added `registerPayment` as a third method on the existing `InvoiceController` rather than a new controller class. If a reviewer judges the invoicing precedent should extend all the way to "one subject, one controller," that is a one-file mechanical split (`payment.controller.ts`), flagged here rather than silently assumed.

## Traceability

| Req | Proven by |
|---|---|
| **R47** (unseen `paymentReference`, matching amount+currency → paid + `payment.received.v1` then `credit.released.v1`, same transaction) | Unit ordering half (armed, see below): `apps/billing/src/application/payment-register.handler.spec.ts` › `PaymentRegisterHandler — R47, the happy path` › *locks the credit line before the invoice row (BI8), calls Invoice.markPaid and BuyerCredit.releaseHold, persists the invoice BEFORE the credit line, and replies accepted*. Integration half: `apps/billing/src/payment-register.integration.spec.ts` › *H1/R47 — records the payment, moves the invoice to paid with paidAt set, appends a release entry, and emits payment.received.v1 THEN credit.released.v1 in that order in the outbox, returning availableCredit to exactly where it started* |
| **R48** (idempotent by `paymentReference`, original outcome, no second payment/fact) | Unit: *the fast path answers duplicate WITHOUT opening a transaction at all*; *the authority re-read under the invoice lock answers duplicate and writes NOTHING new, closing the race the fast path leaves open* (armed). Integration: *R48 — a sequential repeat...*, *R48 — two concurrent requests...* (`Promise.all`, exactly one payment row, one fact pair, no deadlock). The constraint half: *the belt-and-braces backstop: the SAME paymentReference reused across two DIFFERENT invoices is caught by the payments.payment_reference UNIQUE constraint, leaving exactly one payment committed* |
| **R49** (amount/currency mismatch, or a different `paymentReference` against a `paid` invoice → reject, nothing changed, no fact) | Unit, proving nothing was even ATTEMPTED (not merely nothing written): `PaymentRegisterHandler — R49, refusals write nothing` › all three cases. Wire mapping: `rpc-error-mapper.spec.ts`. Integration, proving nothing changed at the DB: `payment-register.integration.spec.ts` › the three R49 cases |

## The armed-deletion records (fact-emission rule)

All four probes below were run against `apps/billing/src/application/payment-register.handler.spec.ts` (10 tests). Each deletion was made, the suite run, the failure captured verbatim, then the file restored and the suite re-run green (confirmed: 129/129 unit tests green after every restore).

### Probe 1 — `Invoice.markPaid(...)` call deleted (the live-caller half of `payment.received.v1`)

Removed the `invoice.markPaid({...}, ctx);` call from `payment-register.handler.ts`, replacing it with a comment.

**Result: 4 tests failed.**

```
FAIL PaymentRegisterHandler — R47, the happy path > locks the credit line before the invoice row (BI8)...
AssertionError: expected { outcome: 'accepted', …(4) } to match object { outcome: 'accepted', …(3) }
  "invoiceStatus": "issued"   (expected "paid")

FAIL PaymentRegisterHandler — R49, refusals write nothing > a DIFFERENT paymentReference against an already-paid invoice raises InvoiceAlreadyPaidError and writes nothing
AssertionError: promise resolved "{ outcome: 'accepted', …(5) }" instead of rejecting

FAIL PaymentRegisterHandler — R49, refusals write nothing > an amount mismatch raises InvoicePaymentAmountMismatchError and writes nothing — the credit line is never touched
AssertionError: promise resolved "{ outcome: 'accepted', …(4) }" instead of rejecting

FAIL PaymentRegisterHandler — R49, refusals write nothing > a currency mismatch raises InvoicePaymentCurrencyMismatchError and writes nothing
AssertionError: promise resolved "{ outcome: 'accepted', …(4) }" instead of rejecting
```

Restored; re-ran green (10/10).

### Probe 2 — `BuyerCredit.releaseHold(...)` call deleted (the live-caller half of `credit.released.v1`)

Removed the `credit.releaseHold({...}, ctx, () => UniqueId.generate());` call.

**Result: 1 test failed.**

```
FAIL PaymentRegisterHandler — R47, the happy path > locks the credit line before the invoice row (BI8)...
AssertionError: expected [] to deeply equal [ 'credit.released.v1' ]
  - [ "credit.released.v1" ]
  + []
```

Restored; re-ran green (10/10).

### Probe 3 — the `invoices.markPaid` / `credits.save` call order swapped (R47's ordering)

Swapped the two `await` statements so `credits.save` ran before `invoices.markPaid`.

**Result: 1 test failed.**

```
FAIL PaymentRegisterHandler — R47, the happy path > locks the credit line before the invoice row (BI8)...
AssertionError: expected 3 to be greater than 4
 (creditsSaveIdx=3, markPaidIdx=4 — credits.save now ran FIRST)
```

Restored; re-ran green (10/10).

### Probe 4 — the R48 duplicate short-circuit removed (a deliberate SUPPRESSION, not an emission)

Removed the `if (paidBy && paidBy.paymentReference === request.paymentReference) { return replyFromDuplicate(...); }` early return under the invoice lock, leaving the code fall through unconditionally to `invoice.markPaid(...)`.

**Result: 1 test failed**, and — notably — it failed by *throwing*, not by a silent double-write, which is itself evidence the aggregate's own B8 guard is a second line of defence behind the suppression:

```
FAIL PaymentRegisterHandler — R48, idempotent by paymentReference > the authority re-read under the invoice lock answers duplicate and writes NOTHING new, closing the race the fast path leaves open
InvoiceAlreadyPaidError: invoice INV-000001 is already paid (invariant B8)
 ❯ Invoice.markPaid src/domain/invoice.ts:271:13
 ❯ src/application/payment-register.handler.ts:143:15
```

Restored; re-ran green (10/10).

## Test suites — final state

- `pnpm --filter @otc/billing test` (unit, `pnpm quality`'s fast gate): **129/129 passed**, 26 test files.
- `pnpm --filter @otc/billing test:integration` (Testcontainers, full suite — mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1): **63/63 passed**, 18 test files (my new `payment-register.integration.spec.ts` contributes 9 of the 63; the other 54 are the pre-existing suite, confirming no regression).
- `pnpm exec eslint apps/billing/src`: clean.
- `pnpm --filter @otc/billing typecheck`: clean.
- `pnpm quality` (repo-wide: lint + typecheck + test across all 10 workspace packages): **green** — `apps/gateway` 1/1, `apps/projector` 1/1, `apps/notifications` 1/1, `packages/contracts` 22/22, `packages/shared-kernel` 68/68, `apps/fulfillment` 75/75, `apps/billing` 129/129, `apps/seed` 119/119, `apps/orders` 392/392.
- `./init.sh`: not re-run in this session (no environment change was made — no new package, no migration, no `.env.example` edit); the repo-wide `pnpm quality` pass above is the equivalent evidence for this feature's footprint.

## Live-cycle evidence against the compose stack

Infra (`docker compose -f docker-compose.infra.yml`) was already up. I built and started `apps/billing` and `apps/orders` (`pnpm --filter @otc/billing build && start`, same for `orders`) to demonstrate the full cross-service cycle, then stopped both afterward — they were not running before this session and are not running after it.

**Pre-state** (`SELECT order_reference, status FROM otc_orders.orders`): eleven orders `invoiced` — `ORD-000007`, `-008`, `-009`, `-010`, `-011`, `-018`, `-022`, `-024`, `-025`, `-026`, `-027` (N12: the brief said "ten"; the live database actually held eleven — corrected here per the reviewer's N12). Per the brief, `INV-000009` (`ORD-000008`) and `INV-000011` (`ORD-000009`) carry known-wrong totals (`49998` vs the order's actual net of `49698`) and were deliberately avoided rather than "fixed."

**Chosen target: `INV-000012` / `ORD-000018`** (`CarrefourEs`/`IBERFOODS`, `49998` EUR, credit line `available_credit` before = `50618`).

A raw `nats` bare-JSON request (mirroring `billing-integration-harness.ts`'s `requestBare`, matching the wire feature 21 established) was sent to `billing.payment.register` with `x-correlation-id` set to **the order's own id** (`3e1bb362-3ba9-433c-868c-8667204c67b3`) — per `asyncapi.yaml`'s `RpcHeaders.x-correlation-id`: *"The order id when the request concerns a known order"*, the same convention `invoice.issue`'s handler already relies on:

```
→ billing.payment.register {"invoiceReference":"INV-000012","paymentReference":"PAY-LIVE-1787545723823","amount":{"amount":49998,"currency":"EUR"},"valueDate":"2026-08-24T04:28:43.823Z","source":"test"}
← reply: {
  "outcome": "accepted",
  "paymentReference": "PAY-LIVE-1787545723823",
  "invoiceReference": "INV-000012",
  "orderReference": "ORD-000018",
  "invoiceStatus": "paid",
  "paidAt": "2026-08-24T04:28:43.853Z"
}
```

**Observed, after:**

| Where | Before | After |
|---|---|---|
| `otc_billing.invoices` (`INV-000012`) | `status='issued'`, `paid_at=NULL` | `status='paid'`, `paid_at='2026-08-24 04:28:44'` |
| `otc_billing.payments` | 0 rows for this invoice | 1 row: `PAY-LIVE-…`, `amount=49998`, `currency=EUR`, `source=test` |
| `otc_billing.credit_items` (order `ORD-000018`) | `hold 49998`, `consume 49998` | + `release 49998` |
| `available_credit` (`CarrefourEs`/`IBERFOODS`) | `50618` | `100616` — exactly `+49998`, the ledger identity `exposure = Σhold − Σrelease` returning the line to precisely where it started before the hold |
| `otc_billing.outbox` (correlation = the order id) | `credit.approved.v1` (seq 224), `invoice.issued.v1` (seq 237) | **+ `payment.received.v1` (seq 249) THEN `credit.released.v1` (seq 250)**, both `published_at` stamped — R47's ordering, live |
| `otc_orders.orders` (`ORD-000018`) | `invoiced` | **`completed`** |

The order crossed `invoiced → paid → completed` unattended, driven entirely by `apps/orders`' pre-existing (unmodified) saga-step wiring consuming `payment.received.v1` then `credit.released.v1` — closing the order-to-cash cycle end to end for the first time in this repository.

### A recorded mistake in my own live-verification script, not a product defect

My first attempt (against `INV-000010`/`ORD-000007`) used a freshly-generated random UUID as `x-correlation-id` instead of the order's own id. Billing's write succeeded correctly (invoice paid, payment recorded, credit released, both facts emitted in order — all verified in the DB) — Billing has no way to validate a caller-supplied correlation id against Orders' write model (`domain-model.md` §1's boundary rule forbids it reading it). `apps/orders`' own defensive layer caught the mismatch cleanly: `otc_orders.saga_ignored_facts` recorded both facts with `marker='unknown_order'`, logged and ignored, no crash, no corruption — exactly the behaviour `saga.md` §6's dedup/precondition layers are built for, applied to a caller error rather than a redelivery. `ORD-000007` is left permanently at `invoiced` as a result (its invoice IS genuinely paid at the Billing side) — an artifact of my own test script, left as found rather than "fixed," since fixing it would mean re-emitting a fact under a fabricated correlation id, which is not something Billing (or I) should ever do. Recorded here for an honest paper trail; the CORRECT immediate retry against `ORD-000018` above is the evidence that answers the brief's requirement.

## What was not done, and why

- **No migration.** The `payments` table (with its `payment_reference` UNIQUE constraint — R48's DB-level backstop) already existed in `0000_brown_hammerhead.sql`. Verified before writing any code.
- **No `packages/contracts` regeneration.** `PaymentRegisterRequestPayload`/`PaymentRegisterReplyPayload`/`PaymentReceivedPayload`/`CreditReleasedPayload` were already generated (feature 21's spec pass anticipated this feature's wire shape in full).
- **`apps/orders` untouched**, per the gate — confirmed unnecessary rather than merely unattempted (see "Live-cycle evidence").
- **The Gateway's "Register payment" HTTP endpoint** (features 25/29) does not exist yet, so R48/R49's sketch `Level: API` in `test-matrix.md` is answered one layer down, at the NATS/RPC responder this feature actually builds — noted explicitly in the matrix's updated rows rather than silently claiming API-level coverage that does not exist.
- **The `PaymentReferenceConflictError`/`CONFLICT` belt-and-braces path** has a genuine integration test (two different invoices, same `paymentReference`, concurrent) but no unit-level test of the raw `ER_DUP_ENTRY` → typed-error conversion in isolation (would need a fake MySQL driver error, which the existing `processed-events.repository.ts` precedent this idiom copies also does not unit-test in isolation) — the integration test is the stronger, load-bearing proof for this genuinely rare edge case.

---

## Addendum — reviewer's N11 fixed (post-approval, before commit)

The reviewer approved feature 22 first pass (0 blocking defects) but required one fix before commit: **N11**, `progress/review_billing_remittance_intake.md`. Full detail there; summarised here for this file's own record.

### The bug

`payment-register.handler.ts`'s step-0 fast path resolved an existing payment **by `paymentReference` alone** and never compared the resolved invoice against the invoice the request actually named. Registering a `paymentReference` already recorded against `INV-000001` while naming `INV-000002` returned a **success-shaped** `duplicate` reply carrying `INV-000001`'s identity — `INV-000002` stayed unpaid with no signal that anything was wrong. The reviewer's probe also established the defect's real shape: the SAME logical condition (one `paymentReference`, two different invoices) already answered `CONFLICT` when the two requests raced (the DB-constraint backstop), so the same condition produced two different answers depending purely on timing.

### The fix

`apps/billing/src/application/payment-register.handler.ts`: added `identityMatchesInvoice(request, invoice)` — compares whichever of `request.invoiceId`/`request.invoiceReference` the caller supplied against the invoice `findPaymentByReference` actually resolved. On a mismatch, the fast path now throws the SAME `PaymentReferenceConflictError` the concurrent path's `payments.payment_reference` UNIQUE-constraint catch already throws, **before opening any transaction or taking any lock** — the genuine-redelivery case (same reference, same invoice) is untouched, still fast-path-only.

### Files changed (this addendum only)

- `apps/billing/src/application/payment-register.handler.ts` — `identityMatchesInvoice` helper + the fast-path branch now compares invoice identity before returning `duplicate`
- `apps/billing/src/application/payment-register.handler.spec.ts` — one new unit test (below), `OTHER_INVOICE_REF` constant, `PaymentReferenceConflictError` import
- `apps/billing/src/payment-register.integration.spec.ts` — one new integration test proving the sequential/concurrent **equivalence**; the pre-existing "belt-and-braces backstop" test strengthened to assert the loser's code is `CONFLICT` specifically (not merely "not accepted"), with its comment corrected to state honestly that a duplicate-shaped success for a genuinely different invoice is no longer reachable by either route (before the fix, the comment's claim that this was "impossible" was itself wrong — N11's exact bug, reachable via the slower of the two racing requests observing an already-committed state)
- `progress/impl_billing_remittance_intake.md` — this addendum; N12 fixed in place ("ten orders" → "eleven orders", matching the eleven references actually listed)

### New tests

- **Unit** (`apps/billing/src/application/payment-register.handler.spec.ts`, describe `PaymentRegisterHandler — R48, idempotent by paymentReference`): *the fast path raises PaymentReferenceConflictError, opening no transaction, when the recorded paymentReference belongs to a DIFFERENT invoice than the one named (N11)*. Asserts the rejection type, `unitOfWork.executeCalls === 0`, `lockById` never called, `markPaidCalls`/`saveCalls` both empty — the identical "no transaction, no lock" property the genuine-redelivery test above it asserts.
- **Integration** (`apps/billing/src/payment-register.integration.spec.ts`): *N11 — the sequential and concurrent forms of the SAME cross-invoice paymentReference reuse return the SAME CONFLICT answer*. Drives the identical condition twice — once with the second request awaited only after the first fully commits (no race), once with both requests fired via `Promise.all` (raced) — and asserts `concurrentLoser.code === sequentialLoser.code` and `concurrentLoser.details.code === sequentialLoser.details.code`: the equivalence property the reviewer named as the thing actually missing, not merely that the sequential form returns `CONFLICT` in isolation.

### Armed-deletion record

Removed the `if (!identityMatchesInvoice(request, paidInvoice)) { throw new PaymentReferenceConflictError(...); }` branch from `payment-register.handler.ts` (replaced with `void` no-ops on the now-unused symbols so the file still compiles), leaving the fast path fall straight through to `return replyFromDuplicate(paidInvoice, existingPayment);` unconditionally — reproducing N11's exact original bug.

Ran `apps/billing`'s unit suite scoped to `src/application/payment-register.handler.spec.ts`.

**Result: 1 test failed** —

```
FAIL src/application/payment-register.handler.spec.ts > PaymentRegisterHandler — R48, idempotent by paymentReference > the fast path raises PaymentReferenceConflictError, opening no transaction, when the recorded paymentReference belongs to a DIFFERENT invoice than the one named (N11)
AssertionError: promise resolved "{ outcome: 'duplicate', …(5) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "invoiceReference": "INV-000001",
+   "invoiceStatus": "paid",
+   "orderReference": "ORD-000001",
+   "outcome": "duplicate",
+   "paidAt": "2026-08-24T10:00:00.000Z",
+   "paymentReference": "PAY-000001",
  }
 ❯ src/application/payment-register.handler.spec.ts:332:6
```

The failure reproduces the reviewer's own probe output almost verbatim (`outcome: 'duplicate'` naming `INV-000001` while the request named `INV-000002`/`OTHER_INVOICE_REF`). Restored (`diff` against the pre-edit backup empty); re-ran green (11/11).

### Suites, final state (post-N11)

- `pnpm --filter @otc/billing test`: **130/130 passed** (was 129; +1 for the N11 unit test), 26 files, lint and typecheck both clean.
- `pnpm --filter @otc/billing test:integration`: **64/64 passed** (was 63; +1 for the N11 equivalence test), 18 test files, 0 regressions.

