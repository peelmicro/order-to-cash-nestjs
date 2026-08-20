# Shared Test Matrix — `R1`–`R61` → named tests

> **Scope.** The **stack-agnostic** traceability matrix of the Order-To-Cash
> trilogy, reused **verbatim** by assessments **#7**, **#8** and **#9**. Every
> EARS requirement of [`requirements.md`](./requirements.md) appears here
> exactly once, mapped to a test level and to a **named** test case that will
> prove it.
>
> Companion documents: [`domain-model.md`](./domain-model.md),
> [`saga.md`](./saga.md), [`asyncapi.yaml`](./asyncapi.yaml),
> [`openapi.yaml`](./openapi.yaml).

---

## The traceability rule

1. **Every requirement has at least one named test.** A requirement with no row
   here is a specification defect, not a testing gap.
2. **Status starts at `TODO` for every row.** The implementer flips a row to
   `DONE` only when the named test exists **and is green** — never when the
   production code merely looks finished.
3. **A feature cannot be marked `done` until every one of its rows is green.**
   This is the gate: the backlog state machine may not advance a feature past
   implementation while any of its rows is still `TODO`. Partial coverage is
   visible as a partly-`TODO` group, never hidden behind a green build.
4. **Renaming a test means editing its row.** The test name in this table is the
   contract; a test whose name no longer matches has broken traceability even if
   it passes.
5. **Ids are stable.** `R<n>` is never renumbered, so #8 and #9 cite the same
   ids against their own test files.

## Test levels

| Level | What it may touch | What it must not touch |
|---|---|---|
| **domain unit** | Aggregates, value objects, state machines, invariants, compensation decisions | No store, no broker, no framework, no clock — time comes from a controllable clock port |
| **integration** | One service against **real** infrastructure: its write model, the fact stream, the RPC transport, the read model | Another service's internals |
| **API** | The composed stack **through the Gateway REST API only** (`openapi.yaml`) | No database, no broker, no service-internal call |
| **web component** | One UI component or composable with its inputs faked | No live backend |
| **e2e** | The whole composed stack driven through the user interface | Nothing is stubbed |

## Test path convention

Paths are written **stack-neutrally**, as `<area>/<layer>/<file>.spec` with no
language extension and no build-tool directory — for example
`orders/domain/order-state-machine.spec`. Each assessment maps them onto its own
conventions in its `design.md`:

| This matrix | Realised as |
|---|---|
| `orders/domain/order.spec` | the Orders service's domain test for the `Order` aggregate |
| `orders/integration/saga-happy-path.spec` | the Orders service's integration test for the happy path |
| `api/payment-idempotency.spec` | a black-box test through the Gateway |
| `web/components/order-timeline.spec` | a component test of the timeline |
| `e2e/compensation-path.spec` | a browser-driven end-to-end test |

The `›` separator introduces the **test case name** inside the file.

## Coverage summary

| Feature | Requirements | Rows | Green |
|---|---|---:|---:|
| 1. `orders_aggregate` | R1 – R10 | 10 | 0 |
| 2. `outbox_and_idempotency` | R11 – R18 | 8 | 0 |
| 3. `order_saga_orchestrator` | R19 – R29 | 11 | 0 |
| 4. `fulfillment_stock` | R30 – R36, R61 | 8 | 0 |
| 5. `billing_credit` | R37 – R44 | 8 | 0 |
| 6. `billing_invoicing` | R45 – R49 | 5 | 0 |
| 7. `projector_read_model` | R50 – R55 | 6 | 0 |
| 8. `observability_reliability` | R56 – R60 | 5 | 0 |
| **Total** | **R1 – R61** | **61** | **0** |

---

## 1. `orders_aggregate` — R1 – R10

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R1** | Every monetary amount is integer minor units plus an ISO 4217 code, everywhere | domain unit + API | `shared-kernel/domain/money.spec` › *represents 1 242,50 € as 124250 minor units and offers no decimal representation*<br>`api/money-representation.spec` › *every monetary field of every response is an integer accompanied by a currency code* | domain unit: **DONE** (`packages/shared-kernel/src/domain/money.spec.ts` › `Money — R1: integer minor units plus an ISO 4217 currency code` › *represents 1 242,50 EUR as 124250 minor units and offers no decimal representation*); API: TODO |
| **R2** | Cross-currency arithmetic is a domain error, never an implicit conversion | domain unit | `shared-kernel/domain/money.spec` › *raises a domain error when EUR and GBP amounts are added, subtracted or compared* | DONE — `packages/shared-kernel/src/domain/money.spec.ts` › `Money — R2: cross-currency arithmetic is a domain error, never an implicit conversion` › *raises a domain error when EUR and GBP amounts are added, subtracted or compared* |
| **R3** | A quantity must be a strictly positive integer | domain unit | `shared-kernel/domain/quantity.spec` › *refuses zero, negative and fractional quantities and creates no value object* | DONE — `packages/shared-kernel/src/domain/quantity.spec.ts` › `Quantity — R3: a quantity must be a strictly positive integer` › *refuses zero, negative and fractional quantities and creates no value object* |
| **R4** | A GLN is 13 digits with a valid GS1 mod-10 check digit | domain unit | `shared-kernel/domain/gln.spec` › *accepts a valid GLN and refuses wrong length, non-digits and a bad check digit* | DONE — `packages/shared-kernel/src/domain/gln.spec.ts` › `GLN — R4: exactly 13 digits with a valid GS1 mod-10 check digit` › *accepts a hand-computed valid GLN (independent oracle)*, *refuses a value that is not exactly 13 digits*, *refuses a value containing non-digit characters*, *refuses a value whose final digit is not the correct GS1 check digit*, *rejects every single-digit mutation of a valid GLN (systematic invalidity)* |
| **R5** | An order always has at least one line (**O1**) | domain unit | `orders/domain/order.spec` › *refuses to create an order with no lines and to remove the last remaining line* | TODO |
| **R6** | Totals are recomputed on every line mutation and may not be negative (**O3**) | domain unit | `orders/domain/order-totals.spec` › *recomputes initialAmount, initialDiscount and totalAmount after each mutation and rejects a negative total* | TODO |
| **R7** | Lines are frozen from `confirmed` onwards (**O4**) | domain unit | `orders/domain/order.spec` › *refuses to add, remove or modify a line once the order is confirmed and leaves every field unchanged* | TODO |
| **R8** | Only edges of Table T-1; `completed` and `cancelled` terminal | domain unit | `orders/domain/order-state-machine.spec` › *walks every legal edge of Table T-1 and reaches cancelled only from placed, stock_reserved, credit_approved and confirmed* | TODO |
| **R9** | An illegal transition raises, changes nothing and appends no event | domain unit | `orders/domain/order-state-machine.spec` › *raises on every (from, to) pair absent from Table T-1 without mutating state or appending an event* | TODO |
| **R10** | Cancellation carries an immutable reason from the closed set (**O6**) | domain unit | `orders/domain/order-cancellation.spec` › *requires a reason from the closed set, records it immutably and carries it on order.cancelled.v1* | TODO |

## 2. `outbox_and_idempotency` — R11 – R18

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R11** | Complete envelope on every fact; `eventType` matches `<aggregate>.<fact>.v<n>` | domain unit | `shared-kernel/domain/event-envelope.spec` › *refuses an envelope with an absent, null or empty field and an eventType that does not match the pattern* | DONE — `packages/shared-kernel/src/domain/event-envelope.spec.ts` › `DomainEventEnvelope — R11: complete envelope, eventType pattern` › *refuses an envelope with an absent, null or empty field*, *refuses an eventType that does not match \<aggregate\>.\<fact\>.v\<n\>* |
| **R12** | `correlationId` = order id; `causationId` = the causing event or command | integration | `orders/integration/outbox-envelope.spec` › *stamps every fact of one order with the order id as correlationId and the causing event id as causationId* | TODO |
| **R13** | Aggregate state and outbox records commit in one transaction, or neither | integration | `orders/integration/outbox-atomicity.spec` › *persists neither the aggregate nor the outbox record and publishes nothing when the transaction fails* | TODO |
| **R14** | Only the relay publishes; unacknowledged records are republished | integration | `orders/integration/outbox-relay.spec` › *stamps a record only after the broker acknowledgement and republishes an unstamped record on the next poll* | TODO |
| **R15** | `correlationId` is the partition key, giving per-order ordering | integration | `orders/integration/fact-partitioning.spec` › *delivers all facts produced by one context about one order to consumers in emission order* | TODO |
| **R16** | Retry with backoff, then `<topic>.dlq` with consumer, attempts and error, then ack | integration | `projector/integration/dead-letter.spec` › *routes a poisoned fact to the dlq topic carrying x-failed-consumer, x-attempts and x-error and acknowledges the original* | TODO |
| **R17** | (`eventId`, consumer) recorded in the same transaction as the effects | integration | `orders/integration/idempotent-consumer.spec` › *records the eventId and consumer name in the same transaction as the state change and the outbox records* | TODO |
| **R18** | A redelivery is acknowledged with no mutation, no fact, no command | integration | `orders/integration/idempotent-consumer.spec` › *acknowledges a redelivered fact without mutating state, emitting a fact or issuing a command* | TODO |

## 3. `order_saga_orchestrator` — R19 – R29

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R19** | `order.placed.v1` + `placed` → issue `stock.reserve`, status unchanged | integration | `orders/integration/saga-happy-path.spec` › *issues stock.reserve for every line on order.placed.v1 and leaves the order in placed* | TODO |
| **R20** | `stock.reserved.v1` + `placed` → `stock_reserved`, issue `credit.hold` | integration | `orders/integration/saga-happy-path.spec` › *moves placed to stock_reserved and issues credit.hold for the order total* | TODO |
| **R21** | `credit.approved.v1` + `stock_reserved` → `credit_approved` → `confirmed`, one `order.confirmed.v1`, issue `despatch.create` | integration | `orders/integration/saga-happy-path.spec` › *moves stock_reserved through credit_approved to confirmed, emits exactly one order.confirmed.v1 and issues despatch.create* | TODO |
| **R22** | `order.despatched.v1` + `confirmed` → `despatched`, issue `invoice.issue` | integration | `orders/integration/saga-happy-path.spec` › *moves confirmed to despatched and issues invoice.issue* | TODO |
| **R23** | `invoice.issued.v1` + `despatched` → `invoiced`, no further command | integration | `orders/integration/saga-happy-path.spec` › *moves despatched to invoiced and issues no further command while awaiting a remittance* | TODO |
| **R24** | `payment.received.v1` → `paid`; `credit.released.v1` → `completed` + one `order.completed.v1` | integration + API | `orders/integration/saga-happy-path.spec` › *moves invoiced to paid then paid to completed and emits exactly one order.completed.v1*<br>`api/order-happy-path.spec` › *an order placed and paid through the Gateway reaches completed with the full timeline* | TODO |
| **R25** | A fact with an unmet precondition changes nothing and is recorded as ignored | integration | `orders/integration/saga-preconditions.spec` › *ignores a fact whose precondition status is unmet and records the observed and expected status* | TODO |
| **R26** | `stock.rejected.v1` + `placed` → cancel `stock_rejected`, **no** release command | integration | `orders/integration/saga-compensation-stock-rejected.spec` › *cancels with reason stock_rejected and issues no stock.release command* | TODO |
| **R27** | `credit.rejected.v1` + `stock_reserved` → issue `stock.release`, stay `stock_reserved` | integration | `orders/integration/saga-compensation-credit-rejected.spec` › *issues stock.release as the first compensation step and leaves the order in stock_reserved* | TODO |
| **R28** | `stock.released.v1` → cancel `credit_rejected`; both steps visible in causal order | integration + e2e | `orders/integration/saga-compensation-credit-rejected.spec` › *cancels with reason credit_rejected only after stock.released.v1 arrives*<br>`e2e/compensation-path.spec` › *a .99 order reaches cancelled with the stock release and the cancellation shown separately in causal order* | TODO |
| **R29** | RPC timeout → retry with backoff, status unchanged, idempotent commands, then DLQ + saga-failure entry | integration | `orders/integration/saga-command-retry.spec` › *retries a timed-out command with backoff without changing the order status, then dead-letters the triggering fact and records a saga-failure entry* | TODO |

## 4. `fulfillment_stock` — R30 – R36, R61

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R30** | `reservedUnits ≤ units` always; a breaking operation is rejected in full (**F1**) | domain unit | `fulfillment/domain/stock-item.spec` › *rejects in full any operation that would push reservedUnits above units and changes no stock item* | TODO |
| **R31** | Availability check answers per line, mutates nothing, emits nothing | integration | `fulfillment/integration/stock-check.spec` › *answers per line without mutating a stock item and without emitting a fact* | TODO |
| **R32** | `stock.reserve` with every line satisfiable → one reservation per line, one `stock.reserved.v1` | domain unit | `fulfillment/domain/reservation.spec` › *creates one reservation per line, increases reservedUnits and emits exactly one stock.reserved.v1* | TODO |
| **R33** | Any short line → nothing reserved, `stock.rejected.v1` naming the shortages (**F3**) | domain unit | `fulfillment/domain/reservation.spec` › *creates no reservation at all and emits stock.rejected.v1 naming requested and available units when one line is short* | TODO |
| **R34** | `stock.release` releases once; an already-released order is a success no-op with no second fact (**F5**) | domain unit + integration | `fulfillment/domain/reservation-release.spec` › *releases the reservations, decreases reservedUnits and emits exactly one stock.released.v1*<br>`fulfillment/integration/stock-release-idempotency.spec` › *answers success and emits no second fact when every reservation is already released* | TODO |
| **R35** | A reservation moves only `reserved → released` or `reserved → consumed`; terminals are terminal (**F4**) | domain unit | `fulfillment/domain/reservation.spec` › *refuses every transition out of released and out of consumed and changes nothing* | TODO |
| **R36** | `despatch.create` consumes the reservations, creates one despatch advice, emits one fact; no reservation → nothing (**F6**, **F7**, **F8**) | domain unit | `fulfillment/domain/despatch-advice.spec` › *consumes the reserved lines, creates one despatch advice despatching exactly the reserved units and emits one order.despatched.v1, and creates nothing when no reservation is held* | TODO |
| **R61** | Replenishment adds on-hand `units` only — reservations, `reservedUnits` and every order untouched, no fact emitted | domain unit + API | `fulfillment/domain/stock-replenishment.spec` › *increases units by the requested quantity, leaves reservedUnits and every reservation unchanged and appends no domain event*<br>`api/stock-replenishment.spec` › *tops up a stock item without emitting a fact, without touching any reservation and without advancing any order* | TODO |

## 5. `billing_credit` — R37 – R44

Rows **R42**–**R44** cover the credit-check **simulator affordance**, not a
credit policy (`requirements.md` §5.1). They are non-negotiable across the
trilogy: they are what makes the compensation path reproducible on demand in the
demo, in the API tests and in the end-to-end tests.

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R37** | Holds + exposure ≤ limit; ledger is append-only (**B1**, **B2**) | domain unit | `billing/domain/buyer-credit.spec` › *keeps active holds plus open exposure within the credit limit and raises on any update or deletion of a ledger entry* | TODO |
| **R38** | Approved hold → one `hold` entry + one `credit.approved.v1` | domain unit | `billing/domain/credit-hold.spec` › *appends a hold entry and emits exactly one credit.approved.v1 carrying the held amount and the resulting available credit* | TODO |
| **R39** | Refused hold → no entry, unchanged credit, `credit.rejected.v1` with a reason | domain unit | `billing/domain/credit-hold.spec` › *appends no ledger entry and emits credit.rejected.v1 with a machine-readable reason when the amount exceeds the limit or the currency differs* | TODO |
| **R40** | Invoice issue converts the hold into exposure, leaving available credit unchanged | domain unit | `billing/domain/credit-ledger.spec` › *appends a consume entry at invoice issue that leaves available credit numerically unchanged and emits no fact* | TODO |
| **R41** | Payment and pre-invoice cancellation release credit with the right reason (**B5**) | domain unit | `billing/domain/credit-ledger.spec` › *releases with reason invoice_paid on payment and with reason order_cancelled on cancellation, restoring available credit without going below zero* | TODO |
| **R42** | Simulator: `totalAmount mod 100 = 99` → reject `simulated_cents_rule` regardless of credit | domain unit | `billing/domain/credit-simulator.spec` › *rejects a total whose minor units end in 99 with reason simulated_cents_rule even when the retailer has ample credit* | TODO |
| **R43** | `CREDIT_FAILURE_RATE` defaults to 0 and an out-of-range value fails startup | domain unit | `billing/domain/credit-simulator.spec` › *defaults the failure rate to zero, rejects a configured proportion when set, and fails to start reporting the offending value when it is outside the closed interval zero to one* | TODO |
| **R44** | Simulated and genuine rejections are indistinguishable downstream except by `reason` | integration | `billing/integration/credit-rejection-parity.spec` › *produces the same fact type, payload shape and compensation path for a simulated and a genuine over-limit rejection, and keeps the over-limit rejection reachable with the simulator bound and the failure rate at zero* | TODO |

## 6. `billing_invoicing` — R45 – R49

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R45** | One invoice per order, lines mirror the despatch, repeat returns the existing reference (**B6**, **B7**) | domain unit | `billing/domain/invoice.spec` › *creates exactly one issued invoice mirroring the despatched lines with a non-negative total and returns the existing reference emitting no second fact on a repeat* | TODO |
| **R46** | Only `issued → paid`; `paidAt` set exactly then (**B8**, **B9**) | domain unit | `billing/domain/invoice.spec` › *allows only the transition from issued to paid, sets paidAt exactly then, and raises on every other transition changing and emitting nothing* | TODO |
| **R47** | Unseen `paymentReference` with matching amount → paid + `payment.received.v1` then `credit.released.v1` in one transaction | integration | `billing/integration/payment-intake.spec` › *records the payment, marks the invoice paid and emits payment.received.v1 followed by credit.released.v1 in that order and in one transaction* | TODO |
| **R48** | Repeated `paymentReference` → original outcome, one payment, no second fact (**B10**) | API | `api/payment-idempotency.spec` › *returns the original outcome and records exactly one payment and one fact when the same paymentReference is registered twice* | TODO |
| **R49** | Mismatched amount or currency, or a second reference against a paid invoice, is rejected with nothing changed | API | `api/payment-rejection.spec` › *rejects a mismatched amount, a mismatched currency and a different reference against an already-paid invoice with a machine-readable code, leaving the invoice and the credit ledger unchanged* | TODO |

## 7. `projector_read_model` — R50 – R55

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R50** | Every fact appends a timeline entry to the `correlationId` document, ordered by `occurredAt` | integration | `projector/integration/timeline-projection.spec` › *appends an entry carrying eventId, eventType, occurredAt and a summary and presents the timeline ordered by occurredAt rather than by arrival* | TODO |
| **R51** | A known `eventId` leaves the document unchanged on redelivery | integration | `projector/integration/timeline-projection.spec` › *leaves the read-model document unchanged when a fact with an already-present eventId is redelivered* | TODO |
| **R52** | An out-of-order fact appends but never regresses the status or overwrites newer references | integration | `projector/integration/out-of-order-facts.spec` › *appends the timeline entry without regressing the document status or overwriting newer references* | TODO |
| **R53** | A fact for an unknown order creates a placeholder, filled in when `order.placed.v1` arrives | integration | `projector/integration/placeholder-document.spec` › *creates a placeholder document keyed by correlationId and fills in the header fields when order.placed.v1 is consumed later* | TODO |
| **R54** | The projector is the only writer; list and detail queries are served from the read model only | integration | `gateway/integration/query-source.spec` › *answers order list and detail queries with every write model disconnected, proving no write-model read and no cross-context join* | TODO |
| **R55** | Update signal reaches subscribers; an unprojected order answers "projection pending", never not-found | API + web component | `api/projection-pending.spec` › *answers projection pending rather than not found for an order id just returned by place-order*<br>`web/components/order-detail-pending.spec` › *renders the waiting state on a projection-pending answer and fills in from the update stream* | TODO |

## 8. `observability_reliability` — R56 – R60

| Id | Requirement (short) | Level | Test file › case | Status |
|---|---|---|---|---|
| **R56** | One trace identifier spans the whole saga end to end | e2e | `e2e/trace-continuity.spec` › *shows a single trace spanning the inbound request, every command, every write-model transaction and every fact publication and consumption for one order* | TODO |
| **R57** | W3C trace context injected on publish and continued on consume, on both transports | integration | `shared-messaging/integration/trace-propagation.spec` › *injects the trace context into fact-stream and RPC messages and continues the trace on consumption instead of starting a new one* | TODO |
| **R58** | Every log line carries `correlationId` and the trace identifier | integration | `shared-observability/integration/log-correlation.spec` › *emits structured records carrying correlationId and traceId on every line produced while handling a request, a command and a fact* | TODO |
| **R59** | Metrics for request latency, consumer latency, saga duration, outbox lag and DLQ depth | integration | `shared-observability/integration/metrics-exposure.spec` › *exposes request latency per endpoint, fact-processing latency per consumer, saga completion time, outbox lag and dead-letter depth per topic* | TODO |
| **R60** | Readiness fails on an unreachable dependency while liveness stays up | API | `api/health-probes.spec` › *reports not-ready on readiness while liveness remains unaffected when the write model, the fact stream or the RPC transport is unreachable* | TODO |

---

## Verification

- **61 rows, ids `R1`–`R61`, contiguous and unique.** Verified by count against
  the eight feature groups above and against `requirements.md`.
- Every row names a **file** and a **case**; no row says "covered by the suite".
- The four cross-cutting demonstrations a reviewer will look for are reachable
  from this table alone:

  | Demonstration | Rows |
  |---|---|
  | Happy path end to end | R19 – R24 |
  | Compensation, both paths, with the stock visibly released | R26, R27, R28, R33, R34, R42 |
  | Effectively-once processing under at-least-once delivery | R16, R17, R18, R25, R29, R48, R51 |
  | One trace and honest health across both brokers | R56, R57, R58, R59, R60 |
