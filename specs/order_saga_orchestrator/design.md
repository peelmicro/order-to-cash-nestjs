# `order_saga_orchestrator` — Design (NestJS / TypeScript, assessment #7)

> **Stack-specific.** This file is where the NestJS, kafkajs-via-`@nestjs/microservices`, `nats`, Drizzle and Testcontainers detail lives. Nothing here belongs in `specs/shared/`; assessments #8 and #9 write their own equivalent against the same `R19` – `R29`.
>
> Authorities: [`specs/shared/saga.md`](../shared/saga.md) (the whole document — step table, both compensation paths, §6 idempotency layers and redelivery table, §7 failure handling), [`specs/shared/requirements.md`](../shared/requirements.md) §3, [`specs/shared/asyncapi.yaml`](../shared/asyncapi.yaml) (fact payloads consumed, RPC request/reply payloads issued), [`specs/orders_aggregate/design.md`](../orders_aggregate/design.md) §4.5 (the command methods this feature drives, OA4, `compensationSteps`), [`specs/outbox_and_idempotency/design.md`](../outbox_and_idempotency/design.md) §4 (UnitOfWork), §6 (the idempotent-consumer pattern this feature MUST reuse — the Orders copy already exists and is canonical).

## 1. Scope

**In scope.** The saga orchestrator inside `apps/orders`: three `@EventPattern` Kafka consumers (one per fact topic), the declarative saga step table, the `@nestjs/cqrs` composition (per-fact commands on the `CommandBus`, dispatch-owed events on the `EventBus`, the `OrderSagas` `@Saga` class, per-command `Issue…Command`s — §5.5, §9), the generic fact handler that composes the existing `IdempotentConsumer` with the aggregate's command methods, the five outbound NATS saga commands with bounded retry, the durable pending/parked command mechanism (`saga_commands`) and its sweeper, the durable ignored-fact record (`saga_ignored_facts`), one Orders-only migration, and the unit + integration tests (stub NATS responders standing in for Fulfillment and Billing).

**Out of scope, and owned elsewhere.**

| Not here | Owned by |
|---|---|
| The `stock.reserve` / `stock.release` / `despatch.create` responders | features 17–18 `fulfillment_*` |
| The `credit.hold` / `invoice.issue` / `payment.register` responders and the simulator | features 19–22 `billing_*` |
| Consumer retry-to-DLQ, `<topic>.dlq` publication, dead-letter headers, metrics, OTel | feature 27 `observability_reliability` (§6.5 records the seam) |
| The projector's timeline and notifications | features 24, 23 |
| The operator cancellation flow (`orders.cancel`, releasing credit + stock from `credit_approved`/`confirmed`) | feature 25 gateway + a later orchestrator extension; §4.3 notes the one row it will add |
| Any Fulfillment/Billing code, any second copy of the idempotent-consumer pattern | features 17–22 |

**Domain layer: untouched.** Not one file under `apps/orders/src/domain/` changes. The aggregate's command methods (`markStockReserved`, `approveCredit`, `confirm`, `markDespatched`, `markInvoiced`, `markPaid`, `complete`, `cancel`) are exactly the surface saga.md §3–§4 needs — that was the point of feature 13.

## 2. Where everything lives

```
apps/orders/src/
  application/
    saga-steps.ts                        the 13-fact step table as data (§4) — pure, framework-free
    saga-steps.spec.ts                   every fact × every status, pure unit tests
    saga-fact-handler.ts                 the ONE generic transactional unit: dedup → precondition → aggregate → owed-command enqueue (§5), returns what it enqueued
    saga-fact-handler.spec.ts            unit tests with fakes (unknown order, ignored, duplicate, skip)
    commands/
      saga-fact.commands.ts              the ten Handle<Fact>FactCommand classes + the factCommandFor(eventType) map (§3.3)
      saga-fact.handlers.ts              ten @CommandHandler wrappers, one per fact command → SagaFactHandler → post-commit EventBus publish (§5.1, §5.5)
      saga-fact.handlers.spec.ts         unit: delegation; publishes the dispatch-owed event only on processed-with-enqueue; nothing on duplicate/ignored
      saga-dispatch.commands.ts          the five Issue<Command>Command classes (§5.5)
      saga-dispatch.handlers.ts          five @CommandHandler wrappers → SagaCommandDispatcher (§6.2)
      saga-dispatch.handlers.spec.ts     unit: each Issue command claims and dispatches its (orderId, command) pending row
    events/
      saga-dispatch.events.ts            the five dispatch-owed application events (§5.5)
    sagas/
      order.sagas.ts                     OrderSagas — the @Saga class: five ofType streams, event in → Issue command out (§5.5)
      order.sagas.spec.ts                unit: the stream mapping, and the no-termination-on-stream-error guard
    ports/
      saga-commands.port.ts              SAGA_COMMANDS token + the five typed command calls + timeout/transport errors (§6.1)
      saga-command-store.port.ts         SAGA_COMMAND_STORE token + enqueue/claim/markSent/park (§6.3)
  infrastructure/
    messaging/
      nats-saga-commands.adapter.ts      NatsConnection.request per subject, per-call timeout — same shape as nats-stock-availability.adapter.ts
      nats-saga-commands.adapter.spec.ts unit: timeout, no-responders, RpcError reply, business rejection pass-through
    saga/
      saga-command-dispatcher.ts         in-line issue with SO4's retry policy; marks sent/parked (§6.2)
      saga-command-dispatcher.spec.ts    unit with fake port + fake clock
      saga-command-sweeper.service.ts    @Injectable self-scheduling setTimeout loop (OutboxRelayService pattern) (§6.4)
      saga-command-sweeper.spec.ts       unit: no overlap, claim → dispatch → reschedule
      drizzle-saga-command-store.ts      saga_commands adapter: enqueue (in caller's tx), claim FOR UPDATE SKIP LOCKED, markSent, park
      saga-ignored-facts.repository.ts   the R25 durable record, written in the caller's tx (§5.4)
    persistence/schema/
      saga-commands.schema.ts            NEW (§7)
      saga-ignored-facts.schema.ts       NEW (§7)
  presentation/
    saga-facts.controller.ts             three @EventPattern handlers, one per topic address; envelope parse; skip-map; awaited CommandBus dispatch (§3.3)
    saga-facts.controller.spec.ts        unit: routing to the mapped fact command, self-fact skip without any dispatch (SO2), malformed envelope policy
  test-support / infrastructure/messaging/test-support/
    stub-saga-responders.ts              stub NATS responders for the five saga subjects (§8) — imported only by integration specs
  saga-happy-path.integration.spec.ts        R19–R24 (matrix names verbatim)
  saga-preconditions.integration.spec.ts     R25, SO8, the §6 redelivery sweep
  saga-compensation-stock-rejected.integration.spec.ts   R26
  saga-compensation-credit-rejected.integration.spec.ts  R27, R28, SO6, SO7
  saga-command-retry.integration.spec.ts     R29 (retry clause), SO3, SO4, SO5
  saga-consumption.integration.spec.ts       SO1

apps/orders/drizzle/0003_<name>.sql        Orders-only migration: saga_commands + saga_ignored_facts (§7)
```

Wiring follows the established conventions, extended for cqrs: `app.module.ts` imports `CqrsModule.forRoot()`; the fifteen `@CommandHandler` classes and `OrderSagas` are registered as **class providers** (decorator discovery requires the class itself) with **explicit `@Inject(TOKEN)`** on every constructor parameter (the CLAUDE.md DI rule — cqrs handlers get constructor-injected ports); everything else (ports, adapters, dispatcher, store, sweeper) stays plain classes provided via `useFactory` + `inject: [...]`; `tsc-watch` dev script untouched.

## 3. Consumption — how facts reach the orchestrator

### 3.1 Transport: `@nestjs/microservices` Kafka, confirmed

Feature 14's row-18 ruling — *raw kafkajs for the relay's producer, `@EventPattern` for consumers* — is **confirmed**, with the reasoning re-checked rather than inherited: the producer needed explicit control of the partition key, idempotent-producer flags and the acknowledgement point; a consumer needs none of that. It needs per-message delivery with headers and value, a consumer group, and at-least-once semantics — exactly what the Nest Kafka server (kafkajs underneath, already a dependency) provides. Raw kafkajs would buy nothing except a hand-rolled lifecycle.

`main.ts` gains a second `connectMicroservice` alongside the existing NATS one:

```ts
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.KAFKA,
  options: {
    client: { clientId: 'otc-orders-saga', brokers: kafkaConfig.brokers },
    consumer: { groupId: 'orders.saga', sessionTimeout: 30000 },
    subscribe: { fromBeginning: true },   // SO1
    run: { partitionsConsumedConcurrently: 1 },
  },
});
```

- **Consumer group `orders.saga`** — deliberately identical to the `ConsumerName` used in `processed_events`, so the broker-side identity and the dedup-ledger identity of "the orchestrator" are the same string. Client id `otc-orders-saga`, distinct from the relay producer's `otc-orders`.
- **`fromBeginning: true`** (SO1): a first boot with no committed offsets must read the facts already in the topics — this is what makes the live-stack behaviour of §8.2 happen at all, and what makes replay-from-zero (saga.md §6 layer 2) a supported operation rather than an accident.
- **Three `@EventPattern`s, one per topic address** (`otc.orders.facts.v1`, `otc.fulfillment.facts.v1`, `otc.billing.facts.v1`), because the topics are per-service, not per-event. Each handler parses the envelope and dispatches on `envelope.eventType` through the step table. Topic constants extend `kafka.config.ts`, guarded the same way `ORDERS_FACTS_TOPIC` already is (`kafka.config.spec.ts` reads `asyncapi.yaml` as text and asserts equality — the two new channel addresses join that spec).
- **Error semantics — the one thing the implementer must verify, not assume.** The design requires: handler resolves ⇒ offset commit; handler throws ⇒ **no** commit, redelivery from the last committed offset (at-least-once, absorbed by saga.md §6). Nest's Kafka server has historically varied in whether an `@EventPattern` rejection propagates to kafkajs or is swallowed; if the installed `@nestjs/microservices` version swallows it, the handler wraps its rejection in `KafkaRetriableException` (a first-class Nest construct for exactly this) so the runner retries. This is task E3's explicit verification step, proven by an integration test that kills the DB mid-handler and asserts redelivery.

### 3.2 Ordering and partitions

The topics have 6 partitions, keyed by `correlationId = orderId`. Consequences the design leans on:

- **All facts of one order from one producing context arrive in emission order** on one partition. With `partitionsConsumedConcurrently: 1` the partition is processed serially, preserving per-order ordering; since the NATS dispatch happens off the consumer thread (next bullet), a slow responder for order A no longer delays a fact for order B.
- **Nothing is assumed across topics.** Every handler checks its precondition (saga.md §6 layer 2). §4.4 argues why a fact can never be *early* on first delivery, which is what makes the R25 ignore rule lossless.
- **The NATS retry budget no longer sits on the consumer thread.** The `@EventPattern` handler awaits only the **transactional unit** (the fact `CommandHandler`, §5.1) before the offset commits; the NATS issue with its SO4 retries (§6.2, worst case ≈16.5 s) runs on the post-commit `EventBus`→`@Saga`→`Issue…Command` hop (§5.5), off the consumer's await chain. kafkajs heartbeats between messages, not during a slow handler, so the transactional unit must still stay comfortably under `sessionTimeout` (30 s) — trivially true for DB-only work — and the 16.5 s worst case now delays neither the partition nor the group. The budget arithmetic stays documented in `saga-command-dispatcher.ts`'s header comment because the sweeper cycle (§6.4) still serialises dispatches and any tuning of attempts/timeout must re-check the cycle length.

### 3.3 Envelope handling

A small `parseFactEnvelope(value: Buffer | string): Envelope` (in the controller file's module scope) validates the seven required envelope fields against the generated `Envelope` type from `@otc/contracts` and narrows `eventType`. A malformed value — unparseable JSON or missing required fields — cannot be deduped (no trustworthy `eventId`) and cannot be parked (no `correlationId`): it is logged as a structured error with the raw offset coordinates and **acknowledged**. A malformed fact is a producer bug that redelivery cannot fix; feature 27's DLQ is the eventual home for it, and this policy is recorded in the open-points table rather than silently chosen.

A well-formed envelope is then routed through `factCommandFor(eventType)` (module-scope map in `saga-fact.commands.ts`): the three self-produced facts map to nothing and are acknowledged immediately — no `CommandBus` dispatch, no transaction, no dedup row (SO2) — and each of the ten consumed facts maps to its explicit command class (`HandleOrderPlacedFactCommand`, `HandleStockReservedFactCommand`, `HandleStockRejectedFactCommand`, `HandleCreditApprovedFactCommand`, `HandleCreditRejectedFactCommand`, `HandleStockReleasedFactCommand`, `HandleOrderDespatchedFactCommand`, `HandleInvoiceIssuedFactCommand`, `HandlePaymentReceivedFactCommand`, `HandleCreditReleasedFactCommand`), each carrying the parsed envelope. The controller `await`s `commandBus.execute(command)` — the command handler is the entire transactional unit of §5.1, so resolution means the transaction committed and rejection propagates to the §3.1 no-commit-⇒-redeliver semantics unchanged.

## 4. The step table as code

### 4.1 The table

`saga-steps.ts` is a declarative map from `eventType` to a step definition — the direct transcription of saga.md §3.1/§4 plus the consumption map §5. Pure data + pure functions, unit-tested exhaustively (every fact × every one of the 9 statuses).

```ts
export type SagaStep =
  | { kind: 'skip' }                                                    // self-produced facts
  | { kind: 'advance'; precondition: OrderStatus;
      apply: (order: Order, ctx: TransitionContext, fact: Envelope) => void;
      commandAfter?: SagaCommandKind }                                  // owed command, enqueued in-tx
  | { kind: 'cancel'; precondition: OrderStatus;
      reason: (fact: Envelope) => CancellationReason;
      compensationSteps: (fact: Envelope) => readonly CompensationStep[] };
```

| Fact consumed | Kind | Precondition | Aggregate call(s) | Command enqueued after commit | On precondition mismatch |
|---|---|---|---|---|---|
| `order.placed.v1` | advance | `placed` | *(none — status unchanged, R19)* | `stock.reserve` | ignored (R25) |
| `stock.reserved.v1` | advance | `placed` | `markStockReserved(ctx)` | `credit.hold` | ignored |
| `stock.rejected.v1` | cancel | `placed` | `cancel('stock_rejected', ctx, [])` | **none — normatively none (R26)** | ignored; **critically, still no release command** (saga.md §6) |
| `credit.approved.v1` | advance | `stock_reserved` | `approveCredit(ctx)` then `confirm(ctx)` — one load/save, one `order.confirmed.v1` (R21) | `despatch.create` | ignored |
| `credit.rejected.v1` | advance | `stock_reserved` | *(none — status unchanged, R27)* | `stock.release` | ignored |
| `stock.released.v1` | cancel | `stock_reserved` | `cancel(mapReason(fact), ctx, stepsFrom(fact))` (SO7, R28) | none | ignored |
| `order.despatched.v1` | advance | `confirmed` | `markDespatched(ctx)` | `invoice.issue` | ignored |
| `invoice.issued.v1` | advance | `despatched` | `markInvoiced(ctx)` | **none — the saga now waits for the outside world (R23)** | ignored |
| `payment.received.v1` | advance | `invoiced` | `markPaid(ctx)` | none | ignored |
| `credit.released.v1` | advance | `paid` | `complete(ctx)` — emits `order.completed.v1` (R24) | none | ignored |
| `order.confirmed.v1` | skip | — | — | — | — |
| `order.completed.v1` | skip | — | — | — | — |
| `order.cancelled.v1` | skip | — | — | — | — |

`ctx` is the aggregate's `TransitionContext`: `occurredAt` = the **fact's** `occurredAt` (the moment it became true in the domain, not the consumption time), `causationId` = the fact's `eventId` — so every fact this feature makes the aggregate emit chains correctly for `R12`, matching the causal-chain table of `outbox_and_idempotency` design §3.5.

### 4.2 The wrong-precondition rule (R25)

`kind: 'advance' | 'cancel'` steps compare `order.status` to `precondition` **by equality** — no ranges, no "or later", exactly the shared spec's wording. On mismatch: no aggregate mutation, no command enqueued, no fact emitted; a `saga_ignored_facts` row (§5.4) is written with observed and expected status, in the same transaction as the dedup record, and the message is acknowledged. Every row of saga.md §6's per-fact redelivery table falls out of this one rule plus the dedup layer, and `saga-preconditions.integration.spec.ts` sweeps that table literally — each of the ten consumed facts redelivered against its post-processing status.

### 4.3 The two compensation paths — different by design

- **Path A, `stock.rejected.v1`** (`placed` → `cancelled`): `cancel('stock_rejected', ctx, [])`. The empty `compensationSteps` is normative (R26, saga.md §4.1 — reservation is all-or-nothing, nothing was acquired), and the step table has **no** `commandAfter`: the test asserts not just the cancellation but the *absence* of any `stock.release` enqueue, including on redelivery against `cancelled`.
- **Path B, `credit.rejected.v1` → `stock.released.v1`** (release **then** cancel, R27/R28): the `credit.rejected.v1` step changes **no** status — the order stays `stock_reserved`, the safe resumable state saga.md §4.3 argues for — and enqueues `stock.release`. Cancellation happens only when `stock.released.v1` arrives, with `compensationSteps = [{ step: 'stock_released', eventId, eventType, occurredAt, summary }]` built from the observed fact (SO7): the aggregate cannot know which compensating facts ran; the orchestrator observed them and passes them in (`orders_aggregate` design §4.5). "Pending compensation is a credit rejection" (R28) is resolved by the **fact's own `reason` field** (`StockReleasedPayload.reason`), not by any saga-instance record — there is none; the saga state is the order status. `mapReason`: `credit_rejected` → `credit_rejected`, `order_cancelled` → `operator_cancelled` (both legal from `stock_reserved` per OA4). The operator flow that would *initiate* a release is feature 25's; this table is merely already able to finish it.

### 4.4 Why ignoring an unmet-precondition fact loses nothing — the argument, stated once

R25's "ignore" would be dangerous if a fact could arrive **early** — before its precondition status is committed — because ignore + dedup would then permanently swallow it. It cannot, for two composed reasons:

1. **Commit-before-issue (SO3).** A command is enqueued in the same transaction as the status change that precedes it and issued only after commit. So `credit.hold` is never in flight before `stock_reserved` is durable, hence `credit.approved.v1` can never be observed before its precondition exists. The same holds for every command→fact edge.
2. **Per-partition ordering within one producing context.** The only trigger not caused by an orchestrator command is `payment.received.v1` (an operator can register a remittance the moment the invoice exists, possibly before the orchestrator has processed `invoice.issued.v1`) — but Billing emits `invoice.issued.v1` and `payment.received.v1` on the **same partition in that order**, and the consumer processes a partition serially, so `markInvoiced` always lands before `markPaid` is attempted. Likewise `credit.released.v1` follows `payment.received.v1` in one Billing transaction, same partition (saga.md §6 "Ordering guarantees").

Therefore every unmet precondition on **first** delivery is impossible, and every unmet precondition in practice is a **stale** redelivery — exactly the case saga.md §6 declares safe to ignore. This argument is a promotion candidate (requirements §3): #8/#9 could violate (1) without breaking any written shared rule.

## 5. The handler — composing the existing pieces

### 5.1 One generic handler, ten specific rows

`SagaFactHandler.handle(envelope: Envelope): Promise<SagaFactResult>` — the only transactional code path; the ten `@CommandHandler` wrappers in `saga-fact.handlers.ts` are one-line delegations to it (explicit commands per the cqrs ruling, zero duplicated orchestration logic). Flow:

1. `steps[envelope.eventType]` — absent or `kind: 'skip'` ⇒ return without any I/O (SO2).
2. `idempotency.runOnce(envelope.eventId, 'orders.saga', work)` — **the existing `IdempotentConsumer`, unmodified**, dedup-insert-first exactly as `outbox_and_idempotency` design §6 built and proved it. `duplicate` ⇒ return (R18).
3. Inside `work(tx)`:
   - `orders.findById(UniqueId.from(envelope.correlationId), tx)` — `null` ⇒ write `saga_ignored_facts` row with marker `unknown_order` (SO8) and return; the dedup record stands (a fact cannot precede its own order's row in this database — R13 committed them together — so nothing can arrive later that needed this event).
   - Precondition mismatch ⇒ `saga_ignored_facts` row with observed/expected status (R25), return.
   - Otherwise: apply the aggregate call(s), `orders.save(order, tx)` (aggregate row + outbox rows, the feature-14 transactional save), and if the step owes a command, `commandStore.enqueue(tx, …)` — the pending-command row of §6.3, same transaction (SO3).
4. `handle` returns `{ outcome: 'processed' | 'duplicate' | 'ignored', enqueued?: SagaCommandKind }`. When the wrapping `@CommandHandler` sees `processed` **with** an enqueued command — and only then, i.e. strictly after the transaction committed — it publishes the matching dispatch-owed application event on the in-process `EventBus` (§5.5); the `OrderSagas` stream turns that into the `Issue…Command` whose handler performs the actual NATS issue (§6.2), outside any transaction.

One transaction therefore contains: dedup record + aggregate change + outbox records + pending-command record. That is R17 plus SO3 in one sentence, and it reuses the exact composition sketch `outbox_and_idempotency` design §6.2 wrote for this feature in advance.

### 5.2 Why the command is issued after commit, not inside the transaction

Issuing inside `work` would hold the order row lock and the dedup index lock across up to ~16.5 s of NATS retries, and — worse — would put the command on the wire before its causal state is durable, re-opening the early-fact race §4.4 closes. Issuing after commit opens a crash window (committed, never issued — which now includes a crash before the in-process `EventBus`→`@Saga` hop runs); the pending-command row closes it: the sweeper (§6.4) re-issues any `pending` row older than a grace period. Re-issue is safe because every command is idempotent by `(orderReference, operation)` (saga.md §6 layer 3 — `already_reserved`, `already_held`, `created: false`, `already_released` replies exist for exactly this).

### 5.3 What "every step recorded" means here (acceptance criterion)

Progressions are recorded as facts via the outbox (the projector's timeline consumes them, feature 24); ignored facts as `saga_ignored_facts` rows (durable, queryable, asserted by the R25 test); command attempts, parks and resumptions as `saga_commands` rows plus structured JSON logs carrying `correlationId`, `eventId`, `command`, `attempts`, `error`. Nothing in the saga's behaviour is observable only in memory.

### 5.4 The ignored-fact record

`saga-ignored-facts.repository.ts` inserts, in the caller's transaction: `event_id`, `event_type`, `order_id` (nullable — unknown-order case), `correlation_id`, `observed_status` (nullable), `expected_status` (nullable), `marker` (`precondition_unmet` | `unknown_order`), `recorded_at`. A durable record — not a log line — because R25's matrix test must assert the observed and expected status were *recorded*, and because "why did the saga ignore this?" is an operations question the database should answer. The write is idempotent under the dedup layer (it only ever happens inside a first-delivery `runOnce`).

### 5.5 The cqrs composition — the in-memory hop is the fast path, the table is the guarantee

The gate's ruling on open point 3 (progress file) rejects the "in-memory bus vs durable saga" dichotomy as false: both layers exist and are composed so that correctness never depends on the in-memory one.

- **Dispatch-owed application events** (`application/events/saga-dispatch.events.ts`, plain framework-free classes carrying `orderId` + `correlationId`): `OrderPlacedFactRecorded`, `OrderMarkedStockReserved`, `CreditRejectionRecorded`, `OrderConfirmed`, `OrderMarkedDespatched` — one per step-table row with a `commandAfter`, published by the fact `@CommandHandler` strictly after commit (§5.1 step 4). The aggregate's own domain events are `DomainEventEnvelope` values that already travel via the outbox (features 13–14); the `EventBus` carries these thin application events instead — the in-process currency the saga stream maps, keeping `domain/` untouched.
- **`OrderSagas`** (`application/sagas/order.sagas.ts`) — the `@nestjs/cqrs` `@Saga` construct: one `@Saga()` method merging five `ofType` streams, each a pure `map` from event to command: `OrderPlacedFactRecorded → IssueStockReserveCommand`, `OrderMarkedStockReserved → IssueCreditHoldCommand`, `CreditRejectionRecorded → IssueStockReleaseCommand`, `OrderConfirmed → IssueDespatchCreateCommand`, `OrderMarkedDespatched → IssueInvoiceIssueCommand`. The stream is wrapped defensively (`catchError` re-subscribing per element) because a cqrs saga stream that errors terminates its subscription silently — and even that failure mode is absorbed by the sweeper (below). `order.sagas.spec.ts` proves the mapping (event in → command out, all five streams) and the no-termination guard, with a plain RxJS `Subject`, no Nest runtime.
- **The five `Issue…Command`s** (`saga-dispatch.commands.ts`) and their `@CommandHandler`s (`saga-dispatch.handlers.ts`): each handler delegates to `SagaCommandDispatcher.dispatch(orderId, command)`, which claims the `(order_id, command)` **pending** row and runs §6.2's retry policy — `pending → sent` on any resolved reply (business rejections included, SO6), park on exhaustion (SO5). A stale hop (row already `sent` or claimed) is a silent no-op: the unique key and claim semantics make double-dispatch harmless on top of the responders' own idempotency (saga.md §6 layer 3).
- **The composition guarantee, stated once.** The in-memory `EventBus`/`@Saga` hop is the **fast path** — normal latency, zero polling. The durable `saga_commands` row (enqueued inside the fact's transaction, SO3) plus the sweeper (§6.4) is the **guarantee**: a crash between commit and the hop, a dropped RxJS subscription, or any other loss of the in-process signal leaves a `pending` row that the sweeper re-issues after `SAGA_PENDING_GRACE_MS`. This is the answer to "is an in-memory bus safe in a distributed saga": yes, **iff** it is only ever an optimisation over a durable queue that would deliver the same command anyway — and that trade-off belongs in the README's trade-offs section when it is written.
- **Wiring**: `CqrsModule.forRoot()` in `app.module.ts`; handlers and `OrderSagas` as class providers with explicit `@Inject(TOKEN)` constructors (§2). The sweeper does **not** go through the `CommandBus` — it calls the dispatcher directly, so the guarantee has no dependency on the in-memory layer it exists to back up.

## 6. Command issuing — ports, retry, parked, sweeper

### 6.1 The port and the NATS adapter

`saga-commands.port.ts` declares one method per saga command, typed end-to-end by `@otc/contracts` (`StockReserveRequestPayload`/`StockReserveReplyPayload` and siblings — all already generated and exported):

```ts
export interface SagaCommandsPort {
  reserveStock(req: StockReserveRequestPayload): Promise<StockReserveReplyPayload>;
  releaseStock(req: StockReleaseRequestPayload): Promise<StockReleaseReplyPayload>;
  createDespatch(req: DespatchCreateRequestPayload): Promise<DespatchCreateReplyPayload>;
  holdCredit(req: CreditHoldRequestPayload): Promise<CreditHoldReplyPayload>;
  issueInvoice(req: InvoiceIssueRequestPayload): Promise<InvoiceIssueReplyPayload>;
}
```

`nats-saga-commands.adapter.ts` reuses feature 15's machinery verbatim in shape: the shared outbound `NatsConnection` (the `NATS_CONNECTION` provider already in `app.module.ts`), `JSONCodec`, per-call `{ timeout }`, the same `NatsRequestClient` narrow surface so unit tests need no broker, the same error taxonomy (`SagaCommandTimeoutError` on `ErrorCode.Timeout`, `SagaCommandTransportError` on `NoResponders` and everything else, an `RpcError`-body reply treated as transport error). Subjects are the AsyncAPI addresses: `fulfillment.stock.reserve`, `fulfillment.stock.release`, `fulfillment.despatch.create`, `billing.credit.hold`, `billing.invoice.issue` — constants guarded by the same read-the-spec-as-text unit test style as the topic constants. Outbound NATS-direct (not `ClientProxy`) is the recorded feature-15 asymmetry: an outbound RPC needs explicit per-call timeout control; `@nestjs/microservices` NATS stays inbound-only.

**A business rejection is not an error** (SO6): `outcome: 'rejected'` from `stock.reserve` or `credit.hold` resolves normally, the dispatcher marks the command `sent`, and nothing else happens — the responder has emitted (or will emit, via its outbox) the rejection **fact**, and only that fact moves the saga (saga.md §2's "single most important rule"). The idempotent-repeat outcomes (`already_reserved`, `already_held`, `already_released`, `created: false`) are likewise plain successes.

### 6.2 The in-line retry policy (SO4) — concrete numbers

| Setting | Default | Meaning |
|---|---|---|
| `SAGA_COMMAND_TIMEOUT_MS` | `5000` | Per-attempt NATS request budget (mirrors `STOCK_CHECK_TIMEOUT_MS`) |
| `SAGA_COMMAND_MAX_ATTEMPTS` | `3` | In-line attempts before parking |
| `SAGA_COMMAND_BACKOFF_MS` | `500` | Base delay; exponential ×2 between attempts (500 ms, 1 000 ms) |

The dispatcher is invoked from exactly two places: the `Issue…Command` handlers (the fast path, §5.5) and the sweeper (the guarantee, §6.4). Worst-case in-line occupation: 3 × 5 000 + 500 + 1 000 = **16.5 s** — since §5.5 this runs off the Kafka consumer's await chain, so it bounds the dispatch/sweep cycle, not the partition (§3.2). Retries happen through the `Clock` port-style delay abstraction so unit tests run instantly with a fake. The order status is never touched while retrying (R29) — the state change was committed *before* the first attempt, and no retry path re-opens a transaction.

### 6.3 The `saga_commands` store — pending, sent, parked

The step's owed command is enqueued **inside the fact's transaction** as a row:

| Column | Notes |
|---|---|
| `id` | `char(36)`, domain-generated |
| `order_id` / `order_reference` | correlation and the idempotency key half |
| `command` | `varchar(30)`: `stock.reserve` \| `stock.release` \| `despatch.create` \| `credit.hold` \| `invoice.issue` |
| `payload` | `json` — the full typed request payload, built from the loaded aggregate at enqueue time (lines are immutable from `confirmed`, totals are aggregate-consistent, so snapshotting is safe and the sweeper never needs to re-derive) |
| `triggering_event_id` | the fact that owed this command — the causal link, and the join key for feature 27's eventual dead-lettering |
| `status` | `pending` → `sent` \| `parked` (→ `sent`) |
| `attempts`, `last_error`, `next_attempt_at` | park bookkeeping (§6.4) |
| `created_at`, `updated_at`, `sent_at` | audit |
| unique `(order_id, command)` | mirrors the RPC idempotency key `(orderReference, operation)`; a step can never owe the same command twice |

The dispatcher (in-line path) claims the row, calls the port with the SO4 policy, then `markSent` on any resolved reply or `park(attempts, error, nextAttemptAt)` on exhaustion. `sent` means "delivered a reply" — never "the saga advanced"; advancement is the fact's job alone.

### 6.4 Parked is not dead — the sweeper (SO5), and what it deliberately is not

**The problem being solved.** R29 says exhausted retries route the triggering fact to the dead-letter topic — but DLQ machinery is feature 27's, and this feature runs for weeks against responders that do not exist (§8). Silently dropping exhausted commands would strand every order at its first step; blocking the partition forever would strand every *other* order too, plus a restart loop. The design must make "the responder is down/absent" a **visible, self-recovering** state.

**The mechanism.** `SagaCommandSweeperService` — an `@Injectable` self-scheduling `setTimeout` chain, structurally identical to `OutboxRelayService` (next cycle scheduled only when the previous settles; graceful shutdown awaits the in-flight cycle; enabled flag for scaled-out deployments). Each cycle, in one short transaction: claim with `FOR UPDATE SKIP LOCKED` every row where `status = 'pending' AND created_at < now − SAGA_PENDING_GRACE_MS` (the SO3 crash window) or `status = 'parked' AND next_attempt_at <= now`; then, outside the transaction, dispatch each through the same dispatcher — called directly, never via the `CommandBus`: the sweeper is the durability backstop and must not depend on the in-memory layer (§5.5). Park schedule: `next_attempt_at = now + min(30 s × 2^parkCycles, 15 min)`, **indefinitely** — the same no-give-up stance the outbox relay takes for publication, and for the same reason: giving up requires a place to give up *to*, and that place is feature 27's. Every park and every failed sweep attempt logs structured JSON (`correlationId`, `command`, `attempts`, `last_error`), so the stall is loud; every success logs the resumption.

| Setting | Default |
|---|---|
| `SAGA_SWEEPER_ENABLED` | `true` |
| `SAGA_SWEEPER_INTERVAL_MS` | `30000` |
| `SAGA_PENDING_GRACE_MS` | `10000` |
| `SAGA_PARK_RETRY_CAP_MS` | `900000` (15 min) |

**Why this rather than the alternatives.** (a) *Not-acking the fact and letting Kafka redeliver*: blocks the whole partition (every order hashing to it), fights the session timeout, and turns "Billing is down" into consumer-group churn. (b) *Publishing to the existing `.dlq` topics now*: the topics exist (feature 5) but the headers, redrive tooling and consumer-retry semantics are feature 27's whole acceptance surface; doing half of it here would pre-empt that spec with an undesigned fragment. (c) *A status-derived nudge with no table*: recoverable but not observable — no attempt counts, no last error, nothing to `SELECT`. The table + sweeper is the smallest design that is both.

**The honest divergence, stated for the gate:** until feature 27, an exhausted command **parks and keeps retrying on a capped schedule** instead of dead-lettering the triggering fact. The fact was acked and deduped; recovery does not need it again, because the pending/parked row carries everything (SO3). The amended R29 matrix row splits accordingly; feature 27's seam is: on park, additionally publish the triggering fact (by `triggering_event_id`, recoverable from the outbox of the producing service or the topic itself) to `<topic>.dlq` with `DeadLetterHeaders`, and add the saga-failure timeline entry. Nothing in this section needs to change shape for that — 27 subscribes to the park event, it does not replace the table.

### 6.5 Seam summary for feature 27

1. Wrap the fact handler's rejection path with attempts/backoff/DLQ (the `IdempotentConsumer` caller seam recorded in `outbox_and_idempotency` §7 — unchanged here).
2. Attach DLQ publication + timeline saga-failure entry to the park transition (§6.4).
3. Metrics: parked-command count and oldest-parked age join outbox lag as the R59 gauges; both are one `SELECT` on `saga_commands`.

## 7. The migration — Orders only, no cross-database coordination

`apps/orders/drizzle/0003_<name>.sql`, generated by `drizzle-kit` from the two new schema files. The orchestrator lives only in Orders, so — unlike feature 14 — **no** Fulfillment/Billing mirror, no parity-guard involvement (`outbox-parity.spec.ts` matches only `outbox`/`processed_events` statements and is untouched; a task asserts it still passes). `processed_events` and `outbox` are not altered. The migration runs on a warm database (both tables are new; no NOT-NULL-on-existing-rows hazard), so no recreate procedure is required — but the live-stack walkthrough of §8.2 recommends one anyway for a clean demo baseline.

## 8. The stub reality — testing and living without Fulfillment and Billing

### 8.1 Integration tests: stub NATS responders (feature 15's precedent, extended)

`stub-saga-responders.ts` follows `stub-stock-check-responder.ts` exactly: plain `nats` subscriptions on the five subjects, started per-test with programmable behaviour, imported **only** from integration specs. Crucially, the stubs must also stand in for the responders' *outbox side*: in the real system `stock.reserved.v1` etc. arrive because Fulfillment/Billing commit and relay them. The test harness therefore publishes the corresponding fact envelopes directly to the real Kafka topics (via the existing `kafka-test-fixture.ts` producer), keyed by `correlationId`, after the stub replies — making the tests exercise the true loop: command out over real NATS, fact in over real Kafka, aggregate advanced through real MySQL. Scenarios:

- **Happy path** (`saga-happy-path.integration.spec.ts`): place an order through `PlaceOrderHandler`, let the relay publish `order.placed.v1`, drive the saga to `invoiced`, then publish stub `payment.received.v1` + `credit.released.v1` (in order, same key) → `paid` → `completed`, asserting each R19–R24 step: statuses, issued commands (recorded by the stubs), exactly one `order.confirmed.v1` and one `order.completed.v1` in the outbox.
- **Both compensations**: stub `stock.reserve` replying `rejected` + publishing `stock.rejected.v1` (path A: `cancelled`/`stock_rejected`, `compensationSteps: []`, and **no** `stock.release` request ever observed by the stub); stub `credit.hold` replying `rejected` + publishing `credit.rejected.v1`, then asserting the `stock.release` request, publishing `stock.released.v1`, and asserting the cancellation with its one compensation step (path B, R27/R28/SO6/SO7).
- **Redelivery and preconditions**: republish each consumed fact after processing; sweep saga.md §6's table.
- **Retry/parked** (`saga-command-retry.integration.spec.ts`): no responder at all → in-line attempts observed (fake-clock-free: assert attempt count from the parked row), order status unchanged, `saga_commands` row `parked` with error; then start the stub and run a sweeper cycle → command re-issued, fact published, saga resumes (SO5's "resumable without operator action", and the §8.2 story proven in miniature).

All against Testcontainers MySQL (`mysql:8.4.11`) + Kafka (`apache/kafka:4.3.1`, topics created with 6 partitions) + NATS — the pinned images and rules already established. These specs stay in `vitest.integration.config.mts`, outside `pnpm quality`, per the standing decision.

### 8.2 The live compose stack, meanwhile — designed, not discovered

With features 17–22 unbuilt, the running stack has no responder on any of the five subjects. On the orchestrator's **first boot** (`fromBeginning: true`, empty offsets):

1. It consumes the `order.placed.v1` facts already in `otc.orders.facts.v1` — the live-check artifacts `ORD-000007/8/9` from feature 15 (their orders sit in `placed`; the seeded orders' facts were stamped published *by the seed* with the topic never written, so only live-check facts are actually in the topic).
2. Each is processed normally: dedup row, no status change (R19), `stock.reserve` enqueued and dispatched → `NoResponders`/timeout → 3 in-line attempts (~16.5 s each, serially per partition) → **parked**, loudly logged.
3. Steady state: three `parked` rows in `saga_commands`, re-attempted every ≤15 min, each sweep logging the failure. `SELECT * FROM saga_commands WHERE status='parked'` is the operator's view. Orders placed live from now on behave identically — accepted at `placed`, then parked at `stock.reserve`.
4. When feature 17's responder first comes up, the next sweep succeeds unattended: `stock.reserved.v1` (or `stock.rejected.v1`) flows, and the stranded sagas resume — the recovery story is the same mechanism as the crash story, which is the point of §6.4.

If the human prefers a clean slate instead of watching the parked rows resume, the established recreate procedure (`docker compose down -v` → up → migrate → seed) empties both the topics and the tables; either outcome is correct, and the choice is recorded in the progress file rather than left to surprise. `progress/impl_order_saga_orchestrator.md` must document whichever was observed.

## 9. `@nestjs/cqrs` — adopted, by gate ruling (open point 3 overruled)

An earlier revision of this design declined the package, reasoning that its `@Saga`/bus constructs are in-memory while this saga's events are Kafka facts with transactional dedup, its state the order row, its commands crash-surviving `saga_commands` rows. **The human gate overruled that resolution (2026-08-21)**: the Task document mandates the package ("`@nestjs/cqrs` is used within each service"), the assessment's purpose is demonstrating the mandated stack in a real distributed system, and the dichotomy was false — the durable layer and the in-process layer compose, as §5.5 specifies:

1. Kafka delivers the fact → `@EventPattern` controller (§3, unchanged).
2. The controller dispatches an explicit per-fact command on the **`CommandBus`**; its **`CommandHandler`** is the entire transactional unit of §5.1 — dedup-insert-first, precondition check (R25), aggregate transition, durable enqueue of the owed command (commit-before-issue, SO3) — synchronously awaited before the Kafka offset commits. Nothing about the durability design changed.
3. After commit, the handler publishes the dispatch-owed application event on the in-process **`EventBus`**.
4. The **`@Saga`** class `OrderSagas` maps each event to its `Issue…Command`, whose handler performs the NATS issue and the `pending → sent` transition with the SO4 retry policy and the SO6 business-vs-transport split intact.
5. The in-memory hop is the **fast path**; the durable `saga_commands` table + sweeper is the **guarantee** — a crash between commit and the hop is recovered by the sweeper re-issuing `pending` rows (§5.5).

Consequences: `@nestjs/cqrs` (v11, matching the Nest 11 line) joins the workspace catalog (§10); CLAUDE.md now makes the adoption binding for every service's application layer (features 17–25 inherit it), with the `@Saga` construct living here in Orders where the orchestrator is. Feature 15's plain `PlaceOrderHandler` stands as landed; migrating it is not this feature's scope. The composition argument of §5.5 is a README trade-offs entry when the README pass happens.

## 10. Configuration and dependencies

New environment (all in `.env.example` with comments, loaded by plain `load…` functions per the established shape): the §6.2 and §6.4 tables, plus nothing else. `KAFKA_BROKERS`/`NATS_URL` are reused.

**New package: `@nestjs/cqrs` `^11`** — added to the workspace catalog in `pnpm-workspace.yaml` (a commented entry, per the catalog's established style) and referenced from `apps/orders/package.json` as `"catalog:"`, named in the phase commit message's package section per the commit discipline. Everything else (`@nestjs/microservices` Kafka transport, `kafkajs`, `nats`, `@testcontainers/kafka`, the NATS test fixture) already exists.

## 11. Testing approach

| File | Level | Runner | Proves |
|---|---|---|---|
| `application/saga-steps.spec.ts` | unit | `vitest.config.mts` (in `pnpm quality`) | The full table: every fact × every status — action, owed command, ignore, skip (SO2), reason mapping, compensation-steps construction. Pure: `Order` instances built directly, no store/broker |
| `application/saga-fact-handler.spec.ts` | unit | idem | Composition with fakes: duplicate ⇒ nothing; unknown order ⇒ SO8 record; enqueue-in-tx ordering; the returned `SagaFactResult` |
| `application/commands/saga-fact.handlers.spec.ts` | unit | idem | Wrapper behaviour: delegation to `SagaFactHandler`; dispatch-owed event published only on processed-with-enqueue, never on duplicate/ignored (§5.1 step 4) |
| `application/commands/saga-dispatch.handlers.spec.ts` | unit | idem | Each `Issue…Command` claims + dispatches its `(orderId, command)` pending row via the dispatcher fake |
| `application/sagas/order.sagas.spec.ts` | unit | idem | The `@Saga` stream mapping — each of the five events in ⇒ its `Issue…Command` out — and no-termination on a stream error (§5.5), via a plain RxJS `Subject` |
| `infrastructure/saga/saga-command-dispatcher.spec.ts` | unit | idem | SO4 policy with fake port + instant fake delays; business rejection not retried (SO6, unit half) |
| `infrastructure/saga/saga-command-sweeper.spec.ts` | unit | idem | No-overlap self-scheduling, claim → dispatch → reschedule (OutboxRelay spec pattern) |
| `infrastructure/messaging/nats-saga-commands.adapter.spec.ts` | unit | idem | Timeout / no-responders / RpcError taxonomy per subject (feature-15 adapter spec pattern) |
| `presentation/saga-facts.controller.spec.ts` | unit | idem | Envelope parse, topic→handler routing, malformed-envelope policy (§3.3) |
| the six `*.integration.spec.ts` of §2 | integration | `vitest.integration.config.mts` — Testcontainers MySQL + Kafka + NATS | R19–R28, R29 (retry clause), SO1, SO3–SO8, the §6 redelivery sweep, and §3.1's throw-⇒-redeliver verification |

Shared-matrix names are used verbatim (`saga-happy-path`, `saga-preconditions`, `saga-compensation-stock-rejected`, `saga-compensation-credit-rejected`, `saga-command-retry`); local SO rows live in this spec's `requirements.md` §2.

## 12. Out of scope — restated

- **DLQ, consumer retry-to-dead-letter, metrics, tracing**: feature 27, attaching at the §6.5 seams.
- **The responders**: features 17–22. This feature must not grow "temporary" responders in `apps/` — stubs live in test-support and are imported only by specs.
- **Projector timeline and notifications**: features 24 and 23 (the consumption-map columns that are not the orchestrator's).
- **Operator cancellation initiation** (`orders.cancel`, unwinding from `credit_approved`/`confirmed`): feature 25+; §4.3 already handles the terminal `stock.released.v1` row it will produce.
- **`payment.register`**: the gateway/Billing pair (features 22, 25); the orchestrator only ever sees its consequences as facts.
