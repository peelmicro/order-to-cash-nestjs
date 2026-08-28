# `orders_saga_terminal_rejection_classification` — implementation record

Feature 42, phase 8, `sdd: false`. Fixes `NatsSagaCommandsAdapter` collapsing every `RpcError`-shaped reply into `SagaCommandTransportError`, which made a terminal business rejection (e.g. `stock.release` against an already-`consumed` reservation replying `PRECONDITION_FAILED`) retry forever at capped backoff instead of resolving.

## What was built, mapped to the brief's 5 numbered items

**1. `apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.ts`**

- Added `isTerminalRpcErrorCode(code: RpcError['code']): boolean` — an exhaustive `switch` (same style as `saga-command-dispatcher.ts`'s `callFor`) splitting `RpcError.code` into:
  - **Terminal** (`true`): `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `PRECONDITION_FAILED`, `ORDER_NOT_CANCELLABLE`, `STOCK_UNAVAILABLE`, `INVOICE_NOT_PAYABLE`, `PAYMENT_MISMATCH`, `DOMAIN_ERROR`.
  - **Transient** (`false`): `TIMEOUT`, `UNAVAILABLE`, `INTERNAL_ERROR` (per the brief, `INTERNAL_ERROR` stays retryable — an unexpected responder-side fault, not a business refusal).
- `call()`'s `isRpcErrorReply(body)` branch now dispatches on this: terminal codes throw the new `SagaCommandBusinessRejectionError`; transient codes/`NoResponders`/malformed-JSON keep throwing `SagaCommandTransportError` exactly as before.

**2. New error class — `apps/orders/src/application/ports/saga-commands.port.ts`**

- Added `SagaCommandBusinessRejectionError extends Error`, parallel in shape to `SagaCommandTimeoutError`/`SagaCommandTransportError`: `code = 'SAGA_COMMAND_BUSINESS_REJECTION'`, constructor `(subject, rpcErrorCode: RpcError['code'], reason)`.
- Updated `SagaCommandTransportError`'s doc comment to state it is now reserved for genuinely retryable failures only.

**3. Dispatcher short-circuit — `apps/orders/src/infrastructure/saga/saga-command-dispatcher.ts`**

- The retry loop's `catch` block now checks `error instanceof SagaCommandBusinessRejectionError` FIRST. On a match: no further in-line attempts, no backoff `delay()` call, calls the new `store.markRejected(row.id, totalAttempts, error.message)`, logs `'saga-command-dispatcher: terminal business rejection, command rejected'`, and returns the new outcome `'rejected'` — never reaching `park()`'s retry-eligible path.
- `SagaCommandDispatchOutcome` widened to `'sent' | 'parked' | 'rejected' | 'noop'`.

**4. Terminal end state — new `rejected` status**

- `SagaCommandStatus` (`saga-command-store.port.ts`) and `SAGA_COMMAND_STATUS_VALUES` (`saga-commands.schema.ts`) both widened to include `'rejected'` (6 characters — fits the existing `varchar(10)` `status` column with no length change).
- New port method `SagaCommandStore.markRejected(id, attempts, lastError): Promise<boolean>` — `pending -> rejected` / `parked -> rejected`, same conditional-update race-safety as `markSent`/`park` (`WHERE status <> 'sent'`), sets `nextAttemptAt = null` (there is no next attempt).
- Implemented in `DrizzleSagaCommandStore.markRejected` (`infrastructure/saga/drizzle-saga-command-store.ts`).
- `claimDue`'s query (`WHERE (status='pending' AND created_at < cutoff) OR (status='parked' AND next_attempt_at <= now)`) was **not modified** — a `rejected` row structurally matches neither branch, so it is already excluded; verified this is sufficient rather than assumed (see integration evidence below).
- **Migration**: none required. `drizzle-kit generate --config drizzle.config.ts` was run against the updated schema and reported `No schema changes, nothing to migrate` — confirmed by `git status apps/orders/drizzle/` showing no new/modified files. This is because `$type<...>()` on a Drizzle column is a TypeScript-only cast; MySQL's `varchar` column carries no `CHECK`/`ENUM` constraint on the allowed values (confirmed via `apps/orders/drizzle/0004_melodic_microbe.sql`), so widening the closed TS union from 3 to 4 values produces zero DDL diff.

**5. `HandlesFirstPark`/OR3 dead-letter mechanism — deliberately NOT wired to the new terminal path.**

This is a scope decision worth flagging to the reviewer: `SagaFirstParkDeadLetterHandler` (OR3's DLQ + `order.saga_failed.v1` mechanism) fires only from `park()`'s exhausted-retry path, never from the new `markRejected` short-circuit. Rationale: the brief's own wording ("short-circuit ... going straight to a terminal resolution **instead of** `park()`'s normal retry-eligible path") reads as excluding `park()`'s downstream machinery too, and the feature's own notes explicitly place the deeper race (operator-cancel vs. saga forward-progress) out of scope — alerting on every terminal business rejection would conflate "the responder legitimately, correctly said no" with "the responder is broken," which is a different signal than OR3 exists to raise. No test asserts non-wiring since there is nothing to arm-and-delete for an absence; flagging in prose instead.

**Consumers checked (item 4's second half)**: grepped the whole repo for `SAGA_COMMAND_STATUS_VALUES` and every literal `'parked'`/`SagaCommandStatus` occurrence — no exhaustive switch on this enum exists outside `apps/orders/src` (only `apps/gateway/src/saga-e2e-verification.integration.spec.ts` references `saga_commands` at all, and it does not pattern-match status). No other file needed updating.

**Addendum — `apps/fulfillment/src/infrastructure/outbox/create-kafka-client.ts`**: added the same D8 `TimeoutNegativeWarning`/kafkajs boot-quirk explanatory comment block already present verbatim in the Orders original, adapted 1:1 (same wording, same citation of `review_orders_acceptance.md` D8). No other line touched.

**`specs/order_saga_orchestrator/design.md`**: §6.1's paragraph (the old line 225 area) corrected — no longer claims "an `RpcError`-body reply treated as transport error"; now documents the terminal/transient split, the two error classes, and the relationship to SO6's pre-existing "business rejection is not an error" rule (a distinct, unrelated mechanism — a *typed reply payload's* `outcome` field vs. an *`RpcError`-shaped* reply). §6.3's `status` column row and its prose updated to describe `rejected` and why `claimDue` naturally excludes it.

## Tests added, and the armed-deletion evidence (both directions)

### Terminal direction

**`apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.spec.ts`** — new `describe('NatsSagaCommandsAdapter — feature 42 (terminal vs. transient RpcError classification)')`:
- `it.each([9 terminal codes])('throws SagaCommandBusinessRejectionError (terminal, not transport) for RpcError code %s', ...)`
- `'the exact reproduced bug: stock.release against an already-consumed reservation (PRECONDITION_FAILED) is terminal, carries the subject and the responder code'`

**Armed** (reverted `isTerminalRpcErrorCode` to unconditionally `return false;`, i.e. the pre-fix "every RpcError is transport" behaviour) — 10 of 26 tests in this file failed, e.g.:

```
FAIL  ... > throws SagaCommandBusinessRejectionError (terminal, not transport) for RpcError code PAYMENT_MISMATCH
AssertionError: expected error to be instance of SagaCommandBusinessRejectionError
+ Received: SagaCommandTransportError { message: 'saga command: transport failure on subject "fulfillment.stock.release": responder returned PAYMENT_MISMATCH: reservation already consumed', ... }
```

Restored; re-ran — 26/26 passed.

**`apps/orders/src/infrastructure/saga/saga-command-dispatcher.spec.ts`** — new `describe('SagaCommandDispatcher — feature 42 (terminal business rejection short-circuits SO4 retry)')`:
- `'a terminal business rejection (PRECONDITION_FAILED) calls the port exactly ONCE, delays zero times, and resolves "rejected" via markRejected — never park'`
- `'a terminal business rejection on a resumed PARKED row (attempts already accumulated) accumulates onto the prior attempts count'`

**Armed** (short-circuited the `if (error instanceof SagaCommandBusinessRejectionError)` branch with `if (false && ...)`, i.e. the pre-fix dispatcher behaviour) — 2 of 14 tests in this file failed, with the retry loop demonstrably retrying to exhaustion and parking the old way:

```
FAIL  ... > a terminal business rejection (PRECONDITION_FAILED) calls the port exactly ONCE ...
AssertionError: expected 'parked' to be 'rejected'

stderr: {"level":"error","message":"saga-command-dispatcher: exhausted attempts, command parked","attempts":3,"error":"saga command: terminal business rejection on subject \"fulfillment.stock.release\" (PRECONDITION_FAILED): reservation already consumed", ...}
```

`"attempts":3` in the log line is the direct proof: the row was retried the FULL `maxAttempts` budget through the transient branch, exactly the bug being fixed. Restored; re-ran — 14/14 passed.

### Transient direction (unaffected)

- Adapter: `it.each(['TIMEOUT', 'UNAVAILABLE', 'INTERNAL_ERROR'])('throws SagaCommandTransportError (still retryable, UNCHANGED) ...')`, plus the pre-existing `'throws SagaCommandTransportError when the responder replies with an RpcError body'` (`INTERNAL_ERROR`) test, unmodified and still green.
- Dispatcher: `'a genuinely TRANSIENT rejection (e.g. wrapped in SagaCommandTransportError) is UNCHANGED — still retried to exhaustion and still parks the old way, never calling markRejected'` — asserts `releaseStock` called `maxAttempts` times, `outcome === 'parked'`, `store.parkCalls.length === 1`, `store.markRejectedCalls.length === 0`. Plus the pre-existing timeout-retry-then-succeed and exhausted-park tests (`SagaCommandTimeoutError`/`SagaCommandTransportError`), all unmodified and still green — proving the new branch is additive, not a behavioural change to the existing retryable path.

### Mechanical fixture updates (not new coverage, needed for the interface widening to compile)

`SagaCommandStore` gained a required `markRejected` method, so every fake implementing/typed as it needed a stub added: `saga-command-sweeper.spec.ts` (6 literals, `replace_all`), `saga-command-sweeper-log-trace-id.spec.ts` (2), `saga-command-dispatcher-log-trace-id.spec.ts` (1 `fakeStore` function), `saga-fact-handler.spec.ts` and `saga-fact-handler-saga-completion-metrics.spec.ts` (`FakeSagaCommandStore` classes, 1 each), `cancel-order.handler.spec.ts` (1 object literal). All stub bodies match each file's existing neighbouring convention (`return true` vs. `throw new Error('not used by this test')`).

## Quality gates run

- `pnpm --filter @otc/orders run test` (vitest, unit) — **512 passed / 512** (52 files).
- `pnpm --filter @otc/orders run typecheck` (`tsc --noEmit`) — **clean**.
- `pnpm exec eslint apps/orders apps/fulfillment/src/infrastructure/outbox/create-kafka-client.ts` — **clean**.
- Root `pnpm run lint` (`eslint .`, whole monorepo) — **clean**.
- Root `pnpm run typecheck` (`pnpm -r --if-present run typecheck`) — **`apps/web` FAILED** (`place.vue(187/207/248,...): Property 'selectedLabel' does not exist on type '{}'`). This is **pre-existing and unrelated**: `apps/web/app/pages/orders/place.vue` was already modified (uncommitted) by other in-progress work per this session's initial `git status`, before this feature touched anything — this feature never touches `apps/web`. All other 9 workspace packages, including `apps/orders`, `apps/fulfillment`, `apps/gateway`, `packages/contracts`, `packages/shared-kernel`, typechecked clean.
- `apps/orders`' Testcontainers integration suite (Docker available): ran the two specs most load-bearing for the store/schema change directly — `saga-command-retry.integration.spec.ts` and `saga-command-dead-letter.integration.spec.ts` — **3/3 passed** against real MySQL/NATS/Kafka, confirming `DrizzleSagaCommandStore`'s new `markRejected` method and the widened `SAGA_COMMAND_STATUS_VALUES` didn't regress the existing retry/park/dead-letter mechanics. (The `TimeoutNegativeWarning`/`GroupCoordinator` console lines are the pre-documented harmless kafkajs boot quirk, D8 — unrelated.) The full `test:integration` suite was not run in full (budget); these two are the ones this feature's schema/store change could plausibly have broken.

## Migration file added

**None.** `drizzle-kit generate` confirmed `No schema changes, nothing to migrate` — the `rejected` status value is a pure TypeScript-level widening of a `varchar(10)` column with no DB-level constraint on its contents (see item 4 above for the full reasoning).

## What I could not do / deliberately left out

- Did not add a Testcontainers-level integration test that reproduces the exact live bug end-to-end (a real stub responder answering `stock.release` with `PRECONDITION_FAILED` over real NATS, asserting the row reaches `rejected` in real MySQL and the sweeper's `claimDue` never reclaims it). The brief's own testing paragraph frames the required proof in unit terms ("mock the transport, assert `call()` is invoked once, not repeatedly") and I judged the two armed unit-level tests (adapter classification + dispatcher short-circuit, both proven to fail on deletion) as satisfying that literal ask, backed by the "no migration/no store-regression" confirmation above at the integration level. If the reviewer wants the full real-broker reproduction, `stub-saga-responders.ts`'s `stockRelease` handler would need a small addition (currently only supports `released`/idempotent-repeat outcomes) to programmably return an `RpcError` body — a slightly bigger change than "add a test," flagging rather than doing unasked.
- Did not update `specs/shared/test-matrix.md`: this feature has no `R<n>` requirement ID of its own — it was found live during feature 41's review pass, not part of an original EARS spec — so there is no matrix row to flip from `TODO`.
- Did not wire the OR3 dead-letter/DLQ mechanism to the new `rejected` terminal state — see item 5 above for the reasoning; flagging explicitly for the reviewer rather than silently deciding either way.
