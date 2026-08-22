# `billing_credit` — Requirements (assessment #7)

> **The normative requirements for this feature are `R37` – `R41` in [`specs/shared/requirements.md`](../shared/requirements.md) §5**, elaborated by [`specs/shared/domain-model.md`](../shared/domain-model.md) §5.1 (the `BuyerCredit` aggregate, the `CreditLedgerEntry` child entity, the derived quantities, invariants **B1** – **B5**), [`specs/shared/saga.md`](../shared/saga.md) §2 (the command vocabulary and its idempotency keys), §3.1 steps 2/3 and 6, §4.2 – §4.3 (the `CreditRejected` compensation and why **no** credit is released on that path), §5 (the consumption map) and §6 (the redelivery table) and [`specs/shared/asyncapi.yaml`](../shared/asyncapi.yaml) (the `billing.credit.hold` / `billing.credit.list` request/reply schemas and the `credit.approved.v1` / `credit.rejected.v1` / `credit.released.v1` payloads). They are **not restated here** — this file adds only the local requirements (`BC<n>`) for gaps the shared spec leaves to each assessment, and the traceability for them.
>
> **`R42` – `R44` are NOT this feature's.** They are the credit-check simulator (feature 20, `billing_credit_simulator`) and stay `TODO` in the shared matrix. This feature owns the **port** they sit behind and the structural guarantee `R44` demands — `BC12` – `BC14` below — so that feature 20 is a *binding* change, not a redesign.
>
> **`R40` is delivered but not driven.** The `consume` ledger entry belongs to invoice issue (feature 21). This feature ships `BuyerCredit.consumeHold` with its domain unit tests and **no caller**, exactly as feature 17 shipped `StockItem.consume` for feature 18. The `R40` matrix row is flipped here because its named test is a domain-unit test this feature writes and greens; nothing about invoicing is claimed.
>
> **`R41` is half-delivered, and the missing half is a contract gap, not an omission.** `releaseHold` is shipped and unit-tested for both reasons (`invoice_paid`, `order_cancelled`). Its `invoice_paid` caller is Billing-internal and arrives with feature 22; its `order_cancelled` caller would be an `orders.cancel` unwind — and **`asyncapi.yaml` defines no `billing.credit.release` subject** even though `requestOrdersCancel`'s own description says the responder "unwinds acquisitions in reverse order of acquisition — credit hold first, then stock reservation". Recorded as a promotion candidate in §3 with an owner.
>
> Related shared requirements this feature composes with but does not own: `R13`/`R14`/`R15` (the outbox, the relay, the partition key — Billing's copies are proven against them here, the rows stay owned by feature 14), `R17`/`R18` (the idempotent-consumer pattern — copied, not exercised: Billing consumes no fact in this feature), `R29` (the orchestrator's retry and its `(orderReference, operation)` responder contract — the Billing side of it is `BC7`), `R12` (`causationId` chains — `BC1`), `R27`/`R28` (the compensation this feature's `credit.rejected.v1` triggers, owned by feature 16 and already green).

## 1. Local requirements — `BC<n>`

These are genuine gaps: things `R37` – `R41` presume but do not pin down, which this assessment must make testable. `BC15` – `BC17` are the **structural** work this feature owns by prior ruling (the third outbox-relay copy and the two inherited `apps/seed` findings); they are requirements, not chores, because each is verifiable by a named test.

### 1.1 Wire contract of the two responders

**BC1.** WHEN Billing emits a fact in response to a `billing.credit.hold` command, THE SYSTEM SHALL set the fact's `correlationId` from the request's `x-correlation-id` header and its `causationId` from the request's `x-request-id` header (`R12`); IF either header is absent or is not a valid `UniqueId`, THEN THE SYSTEM SHALL reply `RpcError` `VALIDATION_FAILED`, SHALL append no ledger entry and SHALL emit no fact. `billing.credit.list` requires neither header.

**BC2.** THE SYSTEM SHALL accept `billing.credit.hold` and `billing.credit.list` as **bare JSON** payloads matching their AsyncAPI request schemas — no framework packet envelope around them — and SHALL reply with a bare JSON success payload or a bare JSON `RpcError`, exactly as `asyncapi.yaml` documents the reply channels; a responder method never resolves with anything else and never rejects.

### 1.2 Resolving the credit line — the two contract violations

**BC3.** IF a `billing.credit.hold` command names a `(retailerCode, companyCode)` pair for which **no** credit line exists, THEN THE SYSTEM SHALL reply `RpcError` `NOT_FOUND` naming the pair, SHALL append no ledger entry and SHALL emit **no** fact, and SHALL NOT create a credit line on demand — a credit line is master data, and a fact with no aggregate has no `aggregateId` to carry (domain-model.md §7.1). *(The same ruling feature 17 made for a `stock.reserve` naming no stocked product: a contract violation parks the saga command loudly for a human, it does not become a business rejection that cancels an order.)*

**BC4.** IF a `billing.credit.hold` command names a currency other than the resolved credit line's currency, THEN THE SYSTEM SHALL reply `RpcError` `VALIDATION_FAILED`, SHALL append no ledger entry and SHALL emit **no** fact — an order is single-currency by **M2**/**O1** and a credit line's currency is its retailer's, so a mismatch is a defective message, not a statement about the buyer's credit, and the three `reason` values of `credit.rejected.v1` stay closed (`R44`). *(This resolves the currency branch of `R39`; the shared `R39` is amended in the same pass — see §3.)*

### 1.3 Deriving `availableCredit` from an append-only ledger — the crux

**BC5.** THE SYSTEM SHALL derive a credit line's available credit **only** from its `credits` row and its append-only ledger, as

```
committedExposure(line)  = Σ amount WHERE type = 'hold'  −  Σ amount WHERE type = 'release'
availableCredit(line)    = creditLimit − committedExposure(line)
```

and SHALL persist **no** materialised, cached or derived available-credit, active-hold or open-exposure column anywhere. A `consume` entry appears in neither term, which is *why* invoice issue is numerically neutral (`R40`) — a structural consequence of the formula, not a rule applied on top of it.

**BC6.** THE SYSTEM SHALL derive the per-order split reported by `billing.credit.list` as

```
exposure(order)       = Σ hold(order) − Σ release(order)          -- ≥ 0 by B5
openExposure(order)   = min( Σ consume(order), exposure(order) )
activeHold(order)     = exposure(order) − openExposure(order)
```

and SHALL satisfy, for every credit line and at every instant, `Σ activeHold(order) + Σ openExposure(order) = creditLimit − availableCredit`, so the `CreditView`'s three amounts can never tell a different story than `BC5`'s two-term sum.

**BC7.** WHILE a `hold` ledger entry already exists for the request's `orderReference` on the resolved credit line — **whatever its net exposure is now**, including an order whose hold has since been released — THE SYSTEM SHALL reply to `billing.credit.hold` with `outcome: already_held` carrying the amount of that recorded `hold` entry as `heldAmount` and the line's **current** `availableCredit`, SHALL append no ledger entry and SHALL emit no fact (invariant **B4**, saga.md §6 layer 3, `R29`'s responder half). The idempotency key is `(orderReference, hold)`; `x-request-id` is **not** the key.

**BC8.** IF a `billing.credit.hold` command is re-issued for an order whose previous hold was **rejected**, THEN THE SYSTEM SHALL re-evaluate the request from scratch — a rejection records nothing (**B1**), so there is nothing for `BC7` to recognise — and MAY therefore emit a second `credit.rejected.v1` with a distinct `eventId`; THE SYSTEM SHALL rely for safety on the orchestrator's three idempotency layers and on the `(order_id, command)`-idempotent `enqueue` landed as `FS1`, and SHALL NOT invent a fourth ledger entry type to record refusals.

**BC9.** WHEN executing `billing.credit.hold`, THE SYSTEM SHALL acquire an exclusive row lock on the resolved `credits` row **before** reading any `credit_items` row and before evaluating anything, and SHALL perform every read and every write of that line's ledger inside that same transaction, so that IF two `billing.credit.hold` commands for different orders compete against one credit line concurrently, THEN their combined recorded holds never exceed `creditLimit` and neither transaction deadlocks (exactly one row is ever locked, so no lock-ordering cycle can form).

### 1.4 The three ledger operations

**BC10.** WHEN a `credit.hold` is approved, THE SYSTEM SHALL append exactly one `hold` entry and exactly one `credit.approved.v1` **in the same transaction** (`R38`, `R13`), and the fact's `availableCreditAfter` SHALL equal `availableCredit` recomputed from the ledger *including* the entry just appended — never the pre-hold value, never a value carried from the request.

**BC11.** WHEN `releaseHold` is invoked for an order, THE SYSTEM SHALL append exactly one `release` entry for that order's **outstanding exposure** and emit exactly one `credit.released.v1` carrying that amount and the caller-supplied reason (`invoice_paid` | `order_cancelled`); WHILE the order has no outstanding exposure — never held, or already released — THE SYSTEM SHALL append nothing and emit nothing and report the no-op; and THE SYSTEM SHALL never append a `release` that would drive `exposure(order)` below zero (**B5**), raising a domain error instead.

**BC12.** WHEN `consumeHold` is invoked for an order holding an active hold, THE SYSTEM SHALL append exactly one `consume` entry of the same amount, SHALL emit **no** fact, and SHALL leave `availableCredit` numerically unchanged (`R40`); IF it is invoked for an order with no active hold, THEN THE SYSTEM SHALL raise a domain error and append nothing.

### 1.5 The credit-decision port — feature 20's seam, fixed now

**BC13.** THE SYSTEM SHALL consult the credit-decision port **only after** the aggregate has determined, from `BC5`, that the requested amount fits within the available credit, so that a bound adapter can turn an otherwise-approvable hold into a refusal but can **never** turn an over-limit hold into an approval — `R44`'s "SHALL NOT allow the simulator to bypass `R37`", enforced by evaluation order rather than by discipline.

**BC14.** THE SYSTEM SHALL forbid the credit-decision port from returning the reason `over_limit` — `over_limit` is the aggregate's word and only the aggregate may say it — and SHALL build `credit.rejected.v1`, the outbox record and the RPC reply through **one** code path for every refusal, so that a genuine over-limit refusal and an adapter refusal differ in exactly one field (`reason`) and in nothing else (`R44`).

**BC15.** WHERE no credit-check simulator is bound, THE SYSTEM SHALL bind an adapter that approves every request it is asked about, and THE SYSTEM SHALL make substituting feature 20's simulator a change to **provider wiring only** — no change to any domain, application or presentation file.

### 1.6 The facts leave through Billing's own outbox

**BC16.** THE SYSTEM SHALL write `credit.approved.v1` and `credit.rejected.v1` (and, when driven, `credit.released.v1`) as outbox records in the **same transaction** as the ledger entries they describe (`R13`), and SHALL publish them to `otc.billing.facts.v1` **only** through Billing's own outbox relay, keyed by `correlationId` (`R14`, `R15`) — no responder, handler or aggregate publishes directly.

### 1.7 The structural work this feature owns

**BC17.** THE SYSTEM SHALL hold every write model's copy of the outbox-relay family byte-identical to the canonical copy after banner-stripping, SHALL keep the canonical copy free of any service name and of any import outside a declared portable whitelist, and SHALL require the family from every application that owns a MySQL `outbox` schema — the same instrument, and the same three cases, `OI12` already applies to the idempotent-consumer pair. *(Deferred at feature 17 §8.3 to "the third copy"; this feature creates it.)*

**BC18.** THE SYSTEM SHALL compare only executable SQL when guarding the three write models' `outbox` / `processed_events` definitions (`OI11`), ignoring comment text entirely, so that a migration's prose can never be constrained by, nor accidentally satisfy, the parity guard. *(Inherited finding `N1`.)*

**BC19.** THE SYSTEM SHALL verify a freshly seeded database by asserting **exact** counts for reference data and **lower-bound** counts for every table live saga traffic can grow, and SHALL name which kind of assertion failed, so that verification stays meaningful on a long-lived development database. *(Inherited finding `N3`.)*

### 1.8 First boot against the live stack

**BC20.** WHEN the Billing responders first start against a compose stack whose `otc_orders.saga_commands` holds `parked` `credit.hold` rows, THE SYSTEM SHALL answer the sweeper's next re-issue of each row so that, without operator action, each order whose `(retailerCode, companyCode)` pair **has** a credit line gains one `hold` ledger entry, one `credit.approved.v1` in `otc_billing.outbox` stamped published, and advances in Orders through `credit_approved` → `confirmed` → `despatched`, parking at `invoice.issue`; and each order whose pair has **no** credit line stays `stock_reserved` with its `credit.hold` row parked on a `NOT_FOUND` reply (`BC3`). *(Worked out precisely in `design.md` §11; verified live, not by an automated test.)*

## 2. Traceability — local rows

The shared rows `R37` – `R41` already carry named tests in [`specs/shared/test-matrix.md`](../shared/test-matrix.md) §5; this feature's spec files use exactly those names and flip those five rows at close-out (`R42` – `R44` stay `TODO` for feature 20). Local rows:

| Id | Level | Test file › case | Status |
|---|---|---|---|
| **BC1** | unit | `apps/billing/src/presentation/credit.controller.spec.ts` › *replies VALIDATION_FAILED and dispatches nothing when x-correlation-id or x-request-id is missing or malformed on billing.credit.hold* | DONE |
| **BC1** | integration | `apps/billing/src/credit-hold.integration.spec.ts` › *stamps correlationId from x-correlation-id and causationId from x-request-id on the emitted credit.approved.v1* | DONE |
| **BC2** | integration | `apps/billing/src/credit-wire.integration.spec.ts` › *answers a bare-JSON request from a raw nats client with a bare-JSON reply on billing.credit.hold and billing.credit.list, and a bare-JSON RpcError on a validation failure* | DONE |
| **BC3** | integration | `apps/billing/src/credit-hold.integration.spec.ts` › *replies NOT_FOUND naming the pair, writes no ledger entry and emits no fact when no credit line exists for the retailer and company* | DONE |
| **BC4** | integration | `apps/billing/src/credit-hold.integration.spec.ts` › *replies VALIDATION_FAILED, writes no ledger entry and emits no fact when the requested currency differs from the credit line's* | DONE |
| **BC5** | domain unit | `apps/billing/src/domain/buyer-credit.spec.ts` › *derives available credit as the limit minus holds plus releases, so a consume entry moves it by nothing* | DONE |
| **BC6** | domain unit + integration | `apps/billing/src/domain/credit-ledger.spec.ts` › *splits outstanding exposure into active holds and open invoice exposure whose sum always equals the limit minus available credit*; `apps/billing/src/credit-list.integration.spec.ts` › *reports activeHolds, openExposure and availableCredit that reconcile to the credit limit for every listed line* | DONE |
| **BC7** | unit + integration | `apps/billing/src/application/credit-hold.handler.spec.ts` › *already_held short-circuits on a hold entry whose exposure has since been released, calling no port and writing nothing*; `apps/billing/src/credit-hold.integration.spec.ts` › *answers already_held with the recorded held amount and the current available credit, writes no entry and emits no second fact when billing.credit.hold is re-issued for the same order* | DONE |
| **BC8** | integration | `apps/billing/src/credit-hold.integration.spec.ts` › *re-evaluates a previously rejected hold from scratch and writes no ledger entry either time* | DONE |
| **BC9** | integration | `apps/billing/src/credit-hold-race.integration.spec.ts` › *two concurrent holds against one nearly exhausted credit line: exactly one credit.approved.v1, exactly one credit.rejected.v1, committed holds never exceed the limit, no deadlock* | DONE |
| **BC10** | domain unit + integration | `apps/billing/src/domain/credit-hold.spec.ts` › *reports availableCreditAfter recomputed with the appended hold, never the pre-hold value*; `apps/billing/src/credit-hold.integration.spec.ts` › *writes the hold entry and the credit.approved.v1 outbox record in one transaction, and a forced rollback leaves neither* | DONE |
| **BC11** | domain unit | `apps/billing/src/domain/credit-ledger.spec.ts` › *releases the order's outstanding exposure once, reports a no-op on a second release, and refuses a release that would drive exposure below zero* | DONE |
| **BC12** | domain unit | `apps/billing/src/domain/credit-ledger.spec.ts` › *appends a consume entry that leaves available credit unchanged and emits no fact, and refuses to consume an order with no active hold* | DONE |
| **BC13** | unit | `apps/billing/src/application/credit-hold.handler.spec.ts` › *consults the credit-decision port only after the aggregate has found the amount fits, and never for an over-limit request* | DONE |
| **BC14** | domain unit + unit | `apps/billing/src/domain/credit-hold.spec.ts` › *emits a credit.rejected.v1 for an adapter refusal that differs from the over-limit refusal in the reason field and in nothing else*; `apps/billing/src/application/ports/credit-decision.port.spec.ts` › *types the port so that over_limit is not a reason an adapter can return*; `apps/billing/src/application/credit-hold.handler.spec.ts` › *returns rejected with the port's reason and records a credit.rejected.v1 fact when the port refuses a fitting hold* | DONE |
| **BC15** | unit | `apps/billing/src/infrastructure/credit/always-approve-credit-decision.spec.ts` › *approves every request, and is the only file feature 20 replaces to bind the simulator* | DONE |
| **BC16** | integration | `apps/billing/src/infrastructure/outbox/outbox-relay.integration.spec.ts` › *publishes the facts of a credit hold transaction to otc.billing.facts.v1 keyed by correlationId and stamps publishedAt only after acknowledgement* | DONE |
| **BC17** | unit | `apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts` › *holds every write model's copy of the outbox-relay family byte-identical to the canonical copy*; › *keeps the canonical family adoptable verbatim, naming no service and importing nothing service-specific*; › *requires the outbox-relay family from every application that owns a MySQL outbox schema* | DONE |
| **BC18** | unit | `apps/seed/src/outbox-parity.spec.ts` › *ignores SQL comment text when comparing the three write models' outbox and processed_events definitions* | DONE |
| **BC19** | unit | `apps/seed/src/verify.spec.ts` › *accepts a database whose saga-derived tables have grown beyond the fixtures while still rejecting a missing reference row* | DONE |
| **BC20** | live verification | `progress/impl_billing_credit.md` § Live boot — the recorded `SELECT`s and log lines of `design.md` §11 | DONE |

**Shared rows this feature flips** (`specs/shared/test-matrix.md` §5): `R37`, `R38`, `R39`, `R40`, `R41`. The matrix's stack-neutral paths map onto this service as `design.md` §13 lists (`billing/domain/buyer-credit.spec` → `apps/billing/src/domain/buyer-credit.spec.ts`, `billing/domain/credit-hold.spec` → `apps/billing/src/domain/credit-hold.spec.ts`, `billing/domain/credit-ledger.spec` → `apps/billing/src/domain/credit-ledger.spec.ts`). `R42` – `R44` stay `TODO` (feature 20).

## 3. Shared-spec changes and promotion candidates

**Amended in this pass** (recorded in `progress/spec_billing_credit.md`, flagged for conscious approval at the gate):

- **`R39`'s currency branch and the `R39` matrix row.** `R39` obliged a `credit.rejected.v1` for a currency mismatch, but `credit.rejected.v1`'s `reason` is a closed three-value enum with no member for it (`asyncapi.yaml` `CreditRejectedPayload`, and `R44` requires those three to stay closed across the trilogy). The clause was unsatisfiable as written. `requirements.md` §5 now separates *credit decisions* (amount, port) from *contract violations* (currency, unknown pair), and the `R39` matrix row's case name drops the currency clause. `BC3`/`BC4` carry the contract-violation half in this assessment.

**Not edited now — for a later shared pass (feature 38):**

- **A `billing.credit.release` subject is missing from the command vocabulary.** `saga.md` §4.3's generalisation table and `asyncapi.yaml`'s `requestOrdersCancel` description both require an operator cancellation from `credit_approved`/`confirmed` to release the credit hold *before* the stock reservation, but `saga.md` §2 lists no such command and `asyncapi.yaml` defines no such channel. Billing cannot be asked to release credit by anyone outside itself. **Owner:** whoever specifies `orders.cancel`'s unwind — feature 25 `gateway_rest_auth` at the latest; the natural slot is the feature-22 shared pass, since feature 22 is where `releaseHold` first gets a real caller.
- **The correlation carrier** (`FS2`/`FS3`'s promotion candidate, restated because `BC1` depends on it identically): no shared requirement obliges a caller to send `x-correlation-id`/`x-request-id` or a responder to derive `correlationId`/`causationId` from them, yet `R12` is unsatisfiable for Fulfillment- and Billing-emitted facts without it.
- **`BC7`'s reading of `B4`.** `B4` says "at most one **active** hold per `orderReference`. A repeated hold command for an order that already holds is an idempotent success." It does not say what happens once that hold has been released. This assessment answers *any recorded `hold` entry for the order*, matching the identical ruling `FS5` made for `stock.reserve` — a re-acquisition after a compensating release must not happen. Worth one sentence in `domain-model.md` §5.1 so #8/#9 agree.
- **`BC5`'s formula.** `domain-model.md` §5.1 writes `activeHold` and `openExposure` with the qualifiers "applied to holds" / "applied to exposures", which are not computable from an entry's own fields — a `release` row does not say which it unwinds. The two-term identity `availableCredit = creditLimit − Σhold + Σrelease` is exact, needs no such qualifier, and makes `R40`'s neutrality structural. Worth replacing the qualified formula with it.
- **`BC9`'s single-row lock is a stronger guarantee than `domain-model.md` §8 rule 6 needs**, unlike `FS6`'s multi-row protocol, which had to be argued against it. Recorded only so the contrast is visible when rule 6 is revisited.
