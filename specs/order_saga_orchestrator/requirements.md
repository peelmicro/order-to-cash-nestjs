# `order_saga_orchestrator` — Requirements (assessment #7)

> **The normative requirements for this feature are `R19` – `R29` in [`specs/shared/requirements.md`](../shared/requirements.md) §3**, elaborated by [`specs/shared/saga.md`](../shared/saga.md) (the happy-path step table §3.1, both compensation paths §4, the per-fact redelivery table §6, the failure-handling table §7). They are **not restated here** — this file adds only the local requirements (`SO<n>`) for gaps the shared spec leaves to each assessment, and the traceability for them.
>
> Related shared requirements this feature composes with but does not own: `R17`/`R18` (the idempotent consumer, feature 14, already `DONE`), `R16` (consumer retry → DLQ, deferred to feature 27 by the ratified open point 16 of `outbox_and_idempotency`), `R12` (`causationId` chains).

## 1. Local requirements — `SO<n>`

These are genuine gaps: things `R19` – `R29` presume but do not pin down, which this assessment must make testable. None of them contradicts a shared requirement.

**SO1.** WHEN the orchestrator starts with no committed offsets for its consumer group, THE SYSTEM SHALL consume each of the three fact topics from the earliest offset, so that facts published before the orchestrator first existed are processed rather than skipped.

**SO2.** WHEN the orchestrator receives one of the three facts it produces itself (`order.confirmed.v1`, `order.completed.v1`, `order.cancelled.v1`), THE SYSTEM SHALL acknowledge it without dispatching any command, without opening a transaction, without writing a `processed_events` record and without loading any aggregate (saga.md §5: consuming them would be a loop).

**SO3.** WHEN a saga step both changes the order status and owes a follow-up command, THE SYSTEM SHALL commit the status change, the `processed_events` record, the outbox records and a durable **pending-command record** in one transaction, and SHALL issue the command only after that transaction has committed; IF the process crashes between the commit and the command issue — including before the in-process event→command dispatch hop has run — THEN THE SYSTEM SHALL issue the command from the pending-command record on a later sweep, without re-consuming the fact; the durable pending-command record, not the in-process hop, is the delivery guarantee.

**SO4.** WHEN a command issued over the RPC transport times out or returns a transport error, THE SYSTEM SHALL retry it in line at most `SAGA_COMMAND_MAX_ATTEMPTS` times (default 3) with exponential backoff starting at `SAGA_COMMAND_BACKOFF_MS` (default 500 ms), each attempt bounded by `SAGA_COMMAND_TIMEOUT_MS` (default 5 000 ms), while leaving the order status unchanged (refines `R29`'s "configured maximum" with this assessment's concrete policy).

**SO5.** IF the in-line attempts of SO4 are exhausted, THEN THE SYSTEM SHALL mark the command **parked** — durably, with the attempt count, the last error and the next retry time — SHALL log a structured saga-failure entry carrying the `correlationId`, and SHALL leave the order in its last legal status; WHILE a command is parked, THE SYSTEM SHALL re-attempt it on a sweep interval with capped exponential backoff, indefinitely, so that the saga resumes without operator action once the responder becomes available. *(Interim stand-in for `R29`'s dead-letter clause until feature 27 — see the open-points table and the amended `R29` matrix row.)*

**SO6.** WHEN a command reply reports a **business rejection** (`rejected` outcome from `stock.reserve` or `credit.hold`), THE SYSTEM SHALL mark the command sent, SHALL NOT retry it, SHALL change no aggregate state, and SHALL await the corresponding rejection **fact** to take the compensation path (saga.md §2: a command's response never advances the saga; §7: a rejection is a domain outcome, not a failure).

**SO7.** WHEN `stock.released.v1` is received for an order in status `stock_reserved`, THE SYSTEM SHALL map the fact's `reason` to the cancellation reason (`credit_rejected` → `credit_rejected`, `order_cancelled` → `operator_cancelled`) and SHALL pass a `compensationSteps` array built from the observed compensating fact (`step: stock_released`, its `eventId`, `eventType`, `occurredAt`) into the cancellation, so the unwinding is auditable in the emitted `order.cancelled.v1` (`R28`; `orders_aggregate` design §4.5 — the aggregate never observes the compensating fact, the orchestrator supplies it).

**SO8.** IF a consumed fact's `correlationId` matches no order in the write model, THEN THE SYSTEM SHALL record the fact as ignored with an `unknown_order` marker, SHALL acknowledge it, and SHALL NOT throw — a fact can never legitimately precede its own order's row, because `order.placed.v1` commits with the order in one transaction before it is published (`R13`), so an unknown order is cross-environment residue, not an ordering problem.

## 2. Traceability — local rows

The shared rows `R19` – `R29` already carry named tests in [`specs/shared/test-matrix.md`](../shared/test-matrix.md) §3; the design's spec files use exactly those names. Local rows:

| Req | Level | Named test | Status |
|---|---|---|---|
| **SO1** | integration | `apps/orders/src/saga-consumption.integration.spec.ts` › *consumes a fact published before the consumer group ever subscribed (fromBeginning: true)* | DONE |
| **SO2** | unit | `apps/orders/src/application/saga-steps.spec.ts` › *maps the three self-produced facts to skip* | DONE |
| **SO3** | integration | `apps/orders/src/saga-command-retry.integration.spec.ts` › *SO3 — the crash-window composition: a pending row committed with NO in-memory hop is still issued by a sweeper cycle* | DONE |
| **SO3** (fast path) | unit | `apps/orders/src/application/sagas/order.sagas.spec.ts` › *maps each dispatch-owed event to its Issue command and survives a stream error (no-termination guard)* | DONE |
| **SO4** | unit | `apps/orders/src/infrastructure/saga/saga-command-dispatcher.spec.ts` › *retries a timed-out command up to maxAttempts, with the configured backoff schedule, then sends on the last attempt* | DONE |
| **SO5** | integration | `apps/orders/src/saga-command-retry.integration.spec.ts` › *parks a command after exhausted attempts, keeps the order in its last legal status, and resumes to the next status when a responder appears* | DONE |
| **SO6** | integration | `apps/orders/src/saga-compensation-credit-rejected.integration.spec.ts` › *does not retry a business-rejected credit.hold and advances only on the credit.rejected.v1 fact* | DONE |
| **SO7** | integration | `apps/orders/src/saga-compensation-credit-rejected.integration.spec.ts` › *release-then-cancel in causal order, with one stock_released compensation step built from the observed fact (R27, R28, SO7)* | DONE |
| **SO8** | integration | `apps/orders/src/saga-preconditions.integration.spec.ts` › *SO8 — a fact whose correlationId matches no order is recorded ignored with the unknown_order marker and acknowledged (no throw)* | DONE |

## 3. Promotion candidates — for `specs/shared/`

| Candidate | Why it may belong in the trilogy contract | Proposed action |
|---|---|---|
| **Commit-before-issue ordering** (the SO3 half that is not the pending-command mechanism): every status transition is durably committed **before** the command it owes is issued, which is what makes an "early" fact — one arriving before its precondition status is committed — impossible by construction (design §4.4). | saga.md §3.1 implies it ("Move the order to `stock_reserved`, **then** ask for a credit hold") and §6's redelivery table silently relies on it: ignoring an unmet-precondition fact is only lossless if the fact can never be early on first delivery. #8 and #9 could order these the other way and break §6 without violating any written rule. | Add one normative paragraph to saga.md §6 "Ordering guarantees" naming commit-before-issue as a rule, not an implication. Flagged at the gate; not edited unilaterally in this pass. |
| **Where `R25`'s "record the fact as ignored" lives** | `R25` requires a record with observed and expected status but names no medium. This assessment records it durably (design §5.4); #8/#9 might log only, and the shared matrix test would then assert different things per assessment. | Leave stack-specific for now; revisit if #8's spec pass disagrees. Recorded here so the trilogy comparison is conscious. |

## 4. What the shared matrix already covers

`R19` – `R28` rows: unchanged, named tests adopted verbatim by the design. `R29`'s row is **amended** (stack-agnostically) to split its two clauses: the retry/backoff/status-unchanged clause is proven by this feature, the dead-letter clause by feature 27 — the same ratified-deferral shape as `R16`. `R24`'s API-level test belongs to features 25/31 and stays `TODO` in that half. Both amendments are flagged in the open-points table for the human gate.
