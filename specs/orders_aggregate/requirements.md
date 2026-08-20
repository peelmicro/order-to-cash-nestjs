# `orders_aggregate` — Requirements

> **Feature 13, phase 8, `"sdd": true`.** The `Order` aggregate, its child `OrderLine`, its invariants and its full status state machine, as **pure domain code** — no store, no broker, no framework.

## 1. Requirements implemented from the shared specification

This feature implements the shared EARS range **`R1` – `R10`** — [`specs/shared/requirements.md`](../shared/requirements.md) §1 `orders_aggregate`.

Those ten requirements are **not restated here**. `specs/shared/requirements.md` is the single authority for their wording, and it is reused verbatim by assessments #8 (.NET) and #9 (FastAPI); a copy in this file would drift the moment either document is touched. Read them there, and read the invariants they cite (`O1`–`O8`, `M1`–`M4`) in [`specs/shared/domain-model.md`](../shared/domain-model.md) §3.

| Shared id | One-line reminder (authority is the shared file) | Realised in this feature by |
|---|---|---|
| **R1** | Money is integer minor units + ISO 4217 code | `Money` (already green in `shared-kernel`); every amount on the aggregate is a `Money` |
| **R2** | Cross-currency arithmetic is a domain error | `Money` (already green); the aggregate never bypasses it |
| **R3** | `Quantity` is a strictly positive integer | `Quantity` (already green); `OrderLine.quantity` |
| **R4** | `GLN` is 13 digits with a valid GS1 check digit | `GLN` (already green); `buyerGln` / `supplierGln` |
| **R5** | No empty orders (**O1**) | `Order.place()`, `Order.removeLine()` |
| **R6** | Totals recomputed on every line mutation, never negative (**O3**) | `computeOrderTotals()` + the validate-then-commit mutators |
| **R7** | Lines frozen from `confirmed` onwards (**O4**) | the `LINES_MUTABLE_IN` status set guard |
| **R8** | Only edges of Table T-1; `completed` / `cancelled` terminal (**O5**, **O7**) | `ORDER_TRANSITIONS` (Table T-1 as data) |
| **R9** | An illegal transition raises, changes nothing, appends no event | `OrderTransitionNotAllowedError` + validate-then-commit |
| **R10** | Cancellation carries an immutable reason from the closed set (**O6**) | `Order.cancel(reason, …)` |

R1 – R4 are already **DONE** at domain-unit level in `packages/shared-kernel` (see `specs/shared/test-matrix.md` §1). This feature must not re-prove them; it must **use** the value objects rather than raw numbers or strings, which is asserted structurally by the type signatures listed in `design.md` §4.

## 2. Feature-local requirements

These state behaviour the shared specification genuinely leaves open, discovered while reading `domain-model.md` §3 against `packages/shared-kernel/src` and `apps/orders/src/infrastructure/persistence/schema/`. Each one is recorded with its rationale in [`progress/spec_orders_aggregate.md`](../../progress/spec_orders_aggregate.md) §3 (open-points table).

**Id namespace.** Local ids are prefixed `OA` deliberately: the shared range `R1`–`R61` is frozen and contiguous, ids are never renumbered, and #8/#9 cite the same numbers. `OA<n>` cannot collide with `R<n>`, and its traceability lives in §3 of this file rather than in `specs/shared/test-matrix.md`, which stays the trilogy contract. Any `OA` that proves to be genuinely stack-agnostic is a **promotion candidate** for the shared spec at feature 38 (`final_checkpoint`), not before.

**OA1.** IF an order line is added, modified or supplied at creation whose `unitPrice` currency or whose `lineDiscount` currency differs from the order's currency, THEN THE SYSTEM SHALL raise a domain error identifying the order, the offending line and both currency codes, SHALL leave every field of the order unchanged, and SHALL NOT allow a currency-mismatch error raised by the `Money` value object to escape the aggregate boundary in its place (invariant **O2**, which no shared `R<n>` states).

**OA2.** WHEN an order status transition succeeds, THE SYSTEM SHALL append exactly one domain event if — and only if — Table T-1 of `domain-model.md` §3.3 names a fact emitted by Orders for that edge (`order.placed.v1`, `order.confirmed.v1`, `order.completed.v1`, `order.cancelled.v1`), and SHALL append no domain event for an edge whose "Fact emitted by Orders" cell is empty (`placed → stock_reserved`, `stock_reserved → credit_approved`, `confirmed → despatched`, `despatched → invoiced`, `invoiced → paid`).

**OA3.** WHEN an order is reconstituted from persisted state, THE SYSTEM SHALL append no domain event, SHALL leave the uncommitted-event collection empty, SHALL recompute `initialAmount`, `initialDiscount` and `totalAmount` from the reconstituted lines rather than accept stored totals, and SHALL raise a domain error if the reconstituted state has no lines, carries a status outside the closed status set, carries a cancellation reason while the status is not `cancelled`, or carries no cancellation reason while the status is `cancelled`.

**OA4.** IF an order is cancelled with a reason that Table T-1 does not pair with the order's current status — `stock_rejected` from any status other than `placed`, or `credit_rejected` from any status other than `stock_reserved` — THEN THE SYSTEM SHALL raise a domain error, SHALL leave the status and every other field unchanged and SHALL append no domain event; `operator_cancelled` remains legal from `placed`, `stock_reserved`, `credit_approved` and `confirmed`.

**OA5.** THE SYSTEM SHALL expose the order's lines only as a value that cannot be used to mutate the aggregate, such that mutating the returned collection or any element of it changes neither the order's lines nor its totals (the structural half of invariants **O3** and **O4**, whose enforcement `R6` and `R7` describe only behaviourally).

## 3. Local traceability

Shared `R5`–`R10` are traced in [`specs/shared/test-matrix.md`](../shared/test-matrix.md) §1 and the implementer flips those rows to `DONE`. The test **case names** in that matrix are the contract: the implementer names the Vitest cases exactly as the matrix names them (matrix rule 4).

The local requirements are traced here, and start `TODO` for the same reason.

| Id | Level | Test file › case | Status |
|---|---|---|---|
| **OA1** | domain unit | `apps/orders/src/domain/order-totals.spec.ts` › *refuses a line whose price or discount currency differs from the order currency, with an order-level error and no partial mutation* | DONE — `Order — OA1` › *refuses a line whose price or discount currency differs from the order currency, with an order-level error and no partial mutation* |
| **OA2** | domain unit | `apps/orders/src/domain/order-events.spec.ts` › *emits exactly one fact on the four Table T-1 edges that name one and no fact at all on the five internal edges* | DONE — `Order — OA2` › *emits exactly one fact on the four Table T-1 edges that name one and no fact at all on the five internal edges* |
| **OA3** | domain unit | `apps/orders/src/domain/order.spec.ts` › *reconstitutes without emitting an event, recomputes the totals from the lines and refuses inconsistent persisted state* | DONE — `Order.reconstitute — OA3` › *reconstitutes without emitting an event, recomputes the totals from the lines and refuses inconsistent persisted state* |
| **OA4** | domain unit | `apps/orders/src/domain/order-cancellation.spec.ts` › *refuses a cancellation reason that Table T-1 does not pair with the current status and changes nothing* | DONE — `Order.cancel — OA4` › *refuses a cancellation reason that Table T-1 does not pair with the current status and changes nothing* |
| **OA5** | domain unit | `apps/orders/src/domain/order.spec.ts` › *returns lines that cannot be used to mutate the order or its totals* | DONE — `Order.lines — OA5` › *returns lines that cannot be used to mutate the order or its totals* |

## 4. Acceptance (from `feature_list.json`)

The backlog's five acceptance bullets map onto the requirements above, with no bullet left unowned:

| Acceptance bullet | Requirement |
|---|---|
| every legal transition allowed, every illegal one throws | R8, R9 |
| no empty orders, no line mutation after confirmed | R5, R7, OA5 |
| totals always consistent with lines | R6, OA1, OA3 |
| cancelled requires a reason | R10, OA4 |
| pure domain unit tests, zero framework imports | enforced by the ESLint `no-restricted-imports` rule on `apps/*/src/domain/**`, plus the test-level rule of `specs/shared/test-matrix.md` |

## 5. Promotion candidates for `specs/shared/`

**Accepted at the approval gate of 2026-08-20 on this condition.** Two of the five local requirements below are not really stack-specific: they are readings of the shared model that #8 (.NET) and #9 (FastAPI) would have to make too, and those assessments read **only** `specs/shared/`. Left local, they would produce three implementations that genuinely differ in behaviour — the one outcome the trilogy exists to rule out. They are therefore recorded here as **promotion candidates**, to be raised at feature 38 (`final_checkpoint`), which is the only feature allowed to renumber or extend the frozen shared range. Nothing in `specs/shared/` is edited by this feature.

| Local id | What it says | What promotion would change in `specs/shared/` |
|---|---|---|
| **OA4** — reason ↔ status pairing (open point 9) | `stock_rejected` may cancel only from `placed`, `credit_rejected` only from `stock_reserved`, `operator_cancelled` from all four cancellable statuses | Extend `R10` (or add one new `R<n>` after the frozen range) so the closed reason set is additionally **paired** with the source status, and make the pairing explicit in `domain-model.md` §3.3 Table T-1 — today it is only implied by the T-1 "Trigger" cells, which is a reading, not a rule. Add the matching row to `test-matrix.md`. |
| **OA1** — single-currency invariant at the aggregate boundary (open point 11) | Every line's `unitPrice`/`lineDiscount` currency must equal the order currency, and the aggregate must raise its **own** error rather than let a value-object currency-mismatch error escape | Give invariant **O2** of `domain-model.md` §3.2 a requirement id of its own — the §9 invariant map currently skips both **O2** and **O8** — stating the rejection *and* that the error is raised at the aggregate boundary with an order-identifying code. Add the matching row to `test-matrix.md`. |

`OA2`, `OA3` and `OA5` are **not** proposed for promotion: OA2 is the resolution of an internal tension between **O8** and Table T-1 that the shared documents can settle in place if they are ever clarified, and OA3/OA5 are about reconstitution and collection immutability — mechanisms whose faithful expression differs enough between TypeScript, C# and Python that a shared wording would either be vacuous or prescribe a stack.
