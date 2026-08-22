# `fulfillment_stock` — Design (NestJS / TypeScript, assessment #7)

> **Stack-specific.** This file is where the NestJS, `@nestjs/cqrs`, `@nestjs/microservices` NATS, Drizzle, MySQL, kafkajs and Testcontainers detail lives. Nothing here belongs in `specs/shared/`; assessments #8 and #9 write their own equivalent against the same `R30` – `R36`, `R61`.
>
> Authorities: [`specs/shared/domain-model.md`](../shared/domain-model.md) §4 (`StockItem`, `Reservation`, **F1** – **F5**, the lifecycle §4.2), §7.1 (the envelope), §8 (cross-cutting rules — rule 6 is argued against **F3** in §4.2 below); [`specs/shared/saga.md`](../shared/saga.md) §2 (command vocabulary), §4.1 (the intentional race), §6 layer 3; [`specs/shared/asyncapi.yaml`](../shared/asyncapi.yaml) (`stockCheck`/`stockReserve`/`stockRelease`/`stockList`/`stockReplenish` channels, `RpcHeaders`, `RpcError`, `StockReserved`/`StockRejected`/`StockReleased` messages, `fulfillmentFacts` topic); [`specs/outbox_and_idempotency/design.md`](../outbox_and_idempotency/design.md) §4 – §6 (the `UnitOfWork`, repository-drains-aggregate, recorder, relay, idempotent-consumer pattern and the OI12 parity guard — all of which this feature **copies**, never re-designs); [`specs/order_saga_orchestrator/design.md`](../order_saga_orchestrator/design.md) §5.5/§6 (the orchestrator that calls these responders, and the `saga_commands` row this feature makes idempotent).
>
> Inherited advisories resolved here: `progress/review_order_saga_orchestrator.md` **D1** (idempotent `enqueue`) → §10.1; `review_orders_acceptance.md` **N4** (`test-support` build exclude replicated) → §12; the phase-6 decision that **F1** is not a DB `CHECK` (`apps/fulfillment/.../stock.schema.ts` header) → §3.1. Left to their owners: D2 (dispatcher `Date.now()`), D4 (`0002_snapshot.json.prevId`), D5 (`-server` group suffix), D6 (`@Optional()` loggers) — none is touched by this feature, and §10 says so.

## 1. Scope

**In scope.**

- The **`StockItem` aggregate** and its `Reservation` child entity, pure domain: `reserve`, `release`, `consume`, `replenish`, the reservation state machine, **F1**/**F2**/**F4**/**F5** enforced in the aggregate; the order-scoped domain service that makes reservation **all-or-nothing across lines** (**F3**) and builds the three facts (§3).
- The **five NATS responders** — `fulfillment.stock.check`, `.reserve`, `.release`, `.list`, `.replenish` — as `@MessagePattern(subject, Transport.NATS)` handlers dispatching on the `@nestjs/cqrs` `QueryBus` (check, list) and `CommandBus` (reserve, release, replenish), request/reply exactly per `asyncapi.yaml`, replies always bare JSON (§5, §6).
- **Responder idempotency** by `orderReference` (saga.md §6 layer 3): a re-issued `stock.reserve` returns `already_reserved`; a `stock.release` for an already-released or never-reserved order is a success no-op (§4.5).
- The **authoritative reservation transaction**: deterministic `SELECT … FOR UPDATE` ordering across multi-line orders, and the honest statement that a check-then-reserve rejection is a designed outcome (§4).
- The **Fulfillment copies** of the outbox writer, relay, Kafka publisher and the idempotent-consumer pattern, the rule that governs copying, and what is (and is not) parity-guarded (§8, §9).
- **Two bounded Orders-side changes** that the first real responder forces: the D1 idempotent `enqueue` and the `x-correlation-id`/`x-request-id` request headers (§10).
- The **designed first boot** against the live compose stack: what the three parked orders do when a responder finally answers (§11).

**Out of scope, and owned elsewhere.**

| Not here | Owned by |
|---|---|
| `despatch.create`, the `DespatchAdvice` aggregate, `order.despatched.v1`, the `despatches`/`despatch_items` tables' runtime | feature 18 `fulfillment_despatch` (this feature leaves `consume()` ready for it) |
| Billing responders (`credit.hold`, `invoice.issue`, `payment.register`) and the simulator | features 19–22 |
| Consumer retry-to-DLQ, metrics, OTel trace propagation, `traceparent` on RPC headers, Terminus health | feature 27 |
| The Gateway's `GET /stock` and `POST /stock/replenish` (callers of `stock.list`/`stock.replenish`) and the `R61` API test | feature 25 |
| Advisories D2, D4, D5, D6 of the feature-16 review | a `test_maintainer` pass / the next Orders-touching feature |
| A parity guard over the **relay** copies (the idempotent-consumer pair is already guarded by OI12) | deferred to feature 19 with a stated precondition — §8.3 |

## 2. Where everything lives

```
apps/fulfillment/src/
  domain/
    stock-item.ts                          StockItem aggregate root (§3.1): reserve / release / consume / replenish, F1/F2/F4/F5
    reservation.ts                         Reservation child entity + ReservationStatus + legal transitions (§3.2)
    stock-item-snapshot.ts                 the plain snapshot shape the mapper reconstitutes from (mirrors order-snapshot.ts)
    order-stock-reservation.ts             pure domain service: all-or-nothing reserve/release across the order's StockItems, builds the facts (§3.3)
    stock-events.ts                        stockReservedEvent / stockRejectedEvent / stockReleasedEvent builders (§3.3)
    stock-errors.ts                        DomainError subclasses with stable codes (§3.4)
    index.ts                               barrel
    *.spec.ts                              pure unit tests — no framework, no DB, no clock
  application/
    ports/
      clock.port.ts                        CLOCK + Clock { now(): Date }                       (copy of Orders', identical)
      unit-of-work.port.ts                 UNIT_OF_WORK + TransactionContext + UnitOfWork       (copy of Orders', identical)
      consumer-name.ts                     the closed set of Fulfillment consumer names — EMPTY today (§9)
      fact-publisher.port.ts               FACT_PUBLISHER + PublishableFact + FactPublisher     (copy of Orders', identical)
      stock-item-repository.port.ts        STOCK_ITEM_REPOSITORY: lockForOrder / findReservationsByOrder / saveAll (§5.2)
      stock-read.port.ts                   STOCK_READ: availability / list — non-locking reads for the QueryBus (§5.2)
    queries/
      stock.queries.ts                     CheckStockQuery, ListStockQuery
      stock.query-handlers.ts              two @QueryHandler classes (explicit @Inject)
      stock.query-handlers.spec.ts
    commands/
      stock.commands.ts                    ReserveStockCommand, ReleaseStockCommand, ReplenishStockCommand (carry correlation/request ids)
      stock.command-handlers.ts            three @CommandHandler classes — each the whole transactional unit (§5.3)
      stock.command-handlers.spec.ts       unit, with fakes
    stock-reservation.handler.ts           the reserve/release transactional flow as a plain class the @CommandHandlers delegate to (§5.3)
    stock-reservation.handler.spec.ts
  infrastructure/
    persistence/
      drizzle-unit-of-work.ts              DrizzleUnitOfWork + asDrizzleTx — the ONE unwrap (copy of Orders', FulfillmentDb/FulfillmentTx)
      stock-item.repository.ts             DrizzleStockItemRepository: FOR UPDATE loads in index order, saveAll = upsert + outbox drain (§7)
      stock-item.mapper.ts                 rows <-> StockItem (snapshot in, snapshot out)
      stock-read.repository.ts             DrizzleStockReadRepository: check + paged list, plain SELECTs (§7)
      stock-item.repository.integration.spec.ts
      stock-read.repository.integration.spec.ts
      schema/                              UNCHANGED — stock, reservations, despatches, despatch_items, outbox, processed_events (phase 6 + feature 14)
    outbox/
      outbox-recorder.ts                   copy of Orders' (§8)
      outbox-envelope-mapper.ts            copy of Orders'
      outbox-relay.ts                      copy of Orders' — `FulfillmentDb` in place of `OrdersDb` (§8.3)
      outbox-relay.service.ts              copy of Orders'
      outbox-relay.config.ts               copy of Orders'
      kafka-fact-publisher.ts              copy of Orders' — default topic FULFILLMENT_FACTS_TOPIC
      kafka.config.ts                      FULFILLMENT_FACTS_TOPIC + loadKafkaConfig (clientId default `otc-fulfillment`)
      kafka.config.spec.ts                 read-the-spec-as-text guard for the topic (same instrument as Orders')
      create-kafka-client.ts               copy of Orders'
      outbox-relay.spec.ts                 OI6 no-overlap (copy of Orders' unit test)
      outbox-relay.integration.spec.ts     FS16 — MySQL + Kafka
      test-support/kafka-test-fixture.ts   copy of Orders'
    messaging/
      idempotent-consumer.ts               VERBATIM copy of the canonical, banner per OI12 (§9)
      processed-events.repository.ts       VERBATIM copy of the canonical, banner per OI12
      nats.config.ts                       loadNatsConfig (copy of Orders' — NATS_URL)
      bare-json-nats.serializer.ts         BareJsonNatsSerializer — replies are the bare payload (§6.3)
      bare-json-nats.deserializer.ts       BareJsonNatsDeserializer — a bare request with a reply subject is a request, not an event (§6.3)
      bare-json-nats.spec.ts               unit: both directions, RpcError on `err`
      test-support/nats-test-fixture.ts    copy of Orders'
    system-clock.ts                        copy of Orders'
  presentation/
    stock.controller.ts                    the five @MessagePattern(…, Transport.NATS) responders (§6.1)
    stock.controller.spec.ts
    dto/stock.dto.ts                       class-validator DTOs implementing the five @otc/contracts request payloads (§6.2)
    rpc-error-mapper.ts                    Fulfillment's own mapping (domain + application errors -> RpcError) (§6.4)
    rpc-error-mapper.spec.ts
    app.controller.ts                      existing health payload, unchanged
  app.module.ts                            CqrsModule.forRoot(), class-provider handlers with explicit @Inject, useFactory for everything else
  main.ts                                  hybrid: HTTP + ONE NATS microservice with the bare-JSON (de)serializers; NO Kafka consumer transport (§9)
  stock-check.integration.spec.ts          R31 (matrix name)
  stock-reserve.integration.spec.ts        R32/R33 integration halves, FS3, FS5
  stock-reserve-race.integration.spec.ts   FS6, FS7 — the acceptance criterion "check-then-reserve race covered by an integration test"
  stock-release-idempotency.integration.spec.ts   R34 (matrix name), FS9, FS10
  stock-replenish.integration.spec.ts      FS14
  stock-list.integration.spec.ts           FS15
  stock-wire.integration.spec.ts           FS4
  test-support/stock-integration-harness.ts   boots the real AppModule graph against Testcontainers MySQL + NATS + Kafka

apps/orders/src/                            §10 — bounded
  application/ports/saga-command-store.port.ts        enqueue returns EnqueueOutcome
  infrastructure/saga/drizzle-saga-command-store.ts   INSERT … ON DUPLICATE KEY UPDATE id = id
  application/saga-fact-handler.ts                    'already_owed' still reports `enqueued`
  application/ports/saga-commands.port.ts             each method gains `meta: SagaCommandMeta`
  infrastructure/messaging/nats-saga-commands.adapter.ts   sends x-correlation-id / x-request-id headers
  infrastructure/saga/saga-command-dispatcher.ts      passes { correlationId: row.orderId, requestId: row.id }
  (+ their existing spec files, extended — never a new Orders behaviour beyond FS1/FS2)
```

**No migration.** Every table this feature writes exists since phase 6 (`stock`, `reservations`) and feature 14 (`outbox`, `processed_events`). `apps/fulfillment/drizzle/` is untouched, which also means `apps/seed/src/outbox-parity.spec.ts` (OI11) has nothing new to compare — a task asserts it still passes.

**Layering.** `domain/` imports only `@otc/shared-kernel` and `import type` from `@otc/contracts` (the precedent `apps/orders/src/domain/order-events.ts` set; the ESLint domain-purity rule allows it). Ports live in `application/`; every adapter in `infrastructure/`; the only NestJS-decorated classes are the controller, the five cqrs handlers and `OutboxRelayService` — all with explicit `@Inject(TOKEN)` on every constructor parameter. Plain classes (repositories, the relay, the reservation handler) are wired with `useFactory` + `inject: [...]`, exactly as `apps/orders/src/app.module.ts` does.

## 3. The domain

### 3.1 `StockItem` — the aggregate root

```ts
// apps/fulfillment/src/domain/stock-item.ts
export interface StockContext {                       // time + causation in, nothing pulled — same shape as Orders' TransitionContext
  readonly occurredAt: Date;
  readonly causationId: UniqueId;
}

export class StockItem extends AggregateRoot<StockItem> {
  static reconstitute(snapshot: StockItemSnapshot): StockItem;   // rows -> aggregate; validates F1 on the way in (InvalidStockItemSnapshotError)
  get companyCode(): string; get productCode(): string;
  get units(): number; get reservedUnits(): number; get lowStockThreshold(): number;
  get availableUnits(): number;                                   // units - reservedUnits, derived, never stored (asyncapi StockView)
  get reservations(): readonly ReservationView[];                 // the reservations LOADED with this item (§7: scoped to the order being handled)

  /** Pure availability question — no mutation, no event (R31). */
  canReserve(units: Quantity): boolean;
  /** Creates ONE reservation in status `reserved` and adds `units` to reservedUnits. Throws InsufficientStockError if it would break F1 (R30). Emits nothing — the ORDER-scoped fact is the domain service's (§3.3). */
  reserve(input: { reservationId: UniqueId; orderReference: OrderNumber; retailerCode: string; units: Quantity }): Reservation;
  /** Moves this item's `reserved` reservations of `orderReference` to `released`, subtracts their units from reservedUnits. Returns the released reservations — an EMPTY array when none was `reserved` (F5, idempotent). Throws ReservationTerminalError if any of the order's reservations on this item is `consumed` (F4, FS10). Emits nothing. */
  release(orderReference: OrderNumber): readonly Reservation[];
  /** Moves this item's `reserved` reservations of `orderReference` to `consumed`, subtracts their units from BOTH units and reservedUnits (domain-model.md §4.2 row 4). Returns them; empty when none was reserved. Throws ReservationTerminalError on a `released` one. Emits nothing — order.despatched.v1 is feature 18's DespatchAdvice fact (FS11). */
  consume(orderReference: OrderNumber): readonly Reservation[];
  /** units += quantity. Appends NO domain event (R61). The only operation that can never move the item closer to breaking F1. */
  replenish(quantity: Quantity): void;
  /** Appends an order-scoped fact built by order-stock-reservation.ts. Refuses (FactAggregateMismatchError) unless `event.aggregateId.equals(this.id)` — the one guard that keeps this method from being a generic "emit anything" hole. */
  recordOrderFact(event: DomainEventEnvelope): void;

  toSnapshot(): StockItemSnapshot;
}
```

**Invariant F1 lives here, not in the schema — and that was decided in phase 6.** `apps/fulfillment/src/infrastructure/persistence/schema/stock.schema.ts`'s header records why there is deliberately no `CHECK (reserved_units <= units)`: a CHECK would fire on legitimate intermediate states inside one transaction (consume decrements `units` and `reserved_units` together but not necessarily in one SQL statement), and it would duplicate logic that must exist in the aggregate anyway to produce a `stock.rejected.v1` *fact* rather than a raw driver error. This feature honours that decision: `reserve` throws `InsufficientStockError` when `units − reservedUnits < requested`, `reconstitute` refuses a snapshot with `reservedUnits > units` or a negative counter, and nothing in infrastructure ever writes the counters except through `toSnapshot()` of an aggregate that has already enforced them. `R30`'s test is a domain unit test for exactly that reason.

**F2 is maintained by construction.** `reservedUnits` is never assigned from outside: every mutation of the counter happens inside `reserve`/`release`/`consume` together with the reservation it describes, and `saveAll` writes both in one transaction (`FS12`). Reconstitution trusts the stored counter (it is the authoritative cache) and loads only the reservations of the order being handled — loading *every* reservation of a popular item on every command would make the aggregate's memory footprint grow with history for no invariant's benefit. The consequence is stated plainly: the aggregate cannot *recompute* F2 from what it holds; it *preserves* it. The integration test of `FS12` checks the stored equality after every committed operation, which is where a drift would actually be visible.

### 3.2 `Reservation` — the child entity and its state machine

```ts
// apps/fulfillment/src/domain/reservation.ts
export const RESERVATION_STATUSES = ['reserved', 'released', 'consumed'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export class Reservation extends Entity<Reservation> {
  static create(input: { id: UniqueId; orderReference: OrderNumber; companyCode: string; retailerCode: string; productCode: string; units: Quantity }): Reservation;  // status = reserved
  static reconstitute(snapshot: ReservationSnapshot): Reservation;
  get orderReference(): OrderNumber; get units(): Quantity; get status(): ReservationStatus; /* + the three codes */
  /** reserved -> released; anything else throws ReservationTerminalError and changes nothing (F4, R35). */
  release(): void;
  /** reserved -> consumed; anything else throws ReservationTerminalError and changes nothing (F4, R35). */
  consume(): void;
}
```

The legal-transition table is the two edges of domain-model.md §4.2 and nothing else; `released → *` and `consumed → *` throw. The `Reservation` is reachable only through its `StockItem` (a `ReservationView` is what `StockItem.reservations` exposes — the same frozen-view discipline `OrderLineView` uses), so nobody can move a reservation without the owning item's counter moving with it.

### 3.3 The order-scoped operation — a pure domain service, and the three facts

**Why a service and not a method.** An order's lines name different products, and a `StockItem` is one `(companyCode, productCode)`. **F3** ("either every line of the order is reserved, or none is") is therefore a rule *across* aggregates, and `R32`/`R33` ask for **exactly one** fact per order — not one per item. The rule needs a home that sees all the items at once; that home is a pure function in `domain/`, not the application handler (the handler would then own a domain invariant, which is the layering mistake the repository-drains-aggregate pattern exists to prevent).

```ts
// apps/fulfillment/src/domain/order-stock-reservation.ts
export interface ReserveOrderInput {
  readonly orderReference: OrderNumber; readonly companyCode: string; readonly retailerCode: string;
  readonly lines: readonly { productCode: string; units: Quantity }[];
  readonly correlationId: UniqueId;                    // the order id, from x-correlation-id (FS3)
}
export type ReserveOrderOutcome =
  | { kind: 'reserved'; reservations: readonly ReservationRef[]; carrier: StockItem }
  | { kind: 'rejected'; shortages: readonly Shortage[]; reason: 'insufficient_stock' | 'unknown_product'; carrier: StockItem | null };

/** ALL-OR-NOTHING (F3): evaluates every line against `items` (keyed by productCode) first; only if every line is satisfiable does it call `reserve` on each item. Unknown productCode => that line is short with available 0 and the reason is unknown_product (FS8). Appends exactly one fact to the carrier (FS13) — stock.reserved.v1 or stock.rejected.v1 — via `carrier.recordOrderFact`. Pure: no I/O, no clock, no ids generated except the reservation ids the caller supplies through `newId`. */
export function reserveOrderStock(items: readonly StockItem[], input: ReserveOrderInput, ctx: StockContext, newId: () => UniqueId): ReserveOrderOutcome;

export type ReleaseOrderOutcome =
  | { kind: 'released'; released: readonly ReservationRef[]; carrier: StockItem }
  | { kind: 'already_released' };                      // nothing was `reserved` on any item — no fact, no counter change (F5, R34, FS9)

/** Calls `release(orderReference)` on every item; if the union of released reservations is non-empty, appends ONE stock.released.v1 (reason from the request) to the carrier = the item of the first released reservation (FS13). Throws ReservationTerminalError through from any item holding a `consumed` reservation of this order (FS10) — nothing is mutated on the other items either, because the handler's transaction rolls back. */
export function releaseOrderStock(items: readonly StockItem[], input: { orderReference: OrderNumber; reason: StockReleasedPayload['reason']; correlationId: UniqueId }, ctx: StockContext): ReleaseOrderOutcome;
```

**The three fact builders** (`stock-events.ts`) mirror `apps/orders/src/domain/order-events.ts` exactly: `createDomainEvent` from `@otc/shared-kernel`, payload types `StockReservedPayload`/`StockRejectedPayload`/`StockReleasedPayload` from `@otc/contracts` (`import type`), the same `Indexed<TPayload>` intersection trick that file documents, `correlationId = input.correlationId` (the order id), `aggregateId = carrier.id`, `causationId`/`occurredAt` from `StockContext`. `retailerCode` is included in all three payloads (optional in the schema, always known here). `stock.rejected.v1`'s `shortages[]` carries `requested` and `available` per short line (`R33`); satisfiable lines are not listed as shortages.

**The carrier, stated once (FS13).** `aggregateId` must be a real aggregate id (domain-model.md §7.1). With one item per line, the fact picks the item of the **first request line that resolves to a known item** (reserve/reject) or of the **first released reservation** (release). This matches the precedent `apps/seed/src/data/sagas.data.ts` already set (`firstStockItemId = stockRowId(companyCode, lines[0].productCode)` for seeded `stock.*` facts), so seeded and live facts look alike to the projector. If *no* line resolves to a known item there is no carrier; the handler then replies `RpcError` `NOT_FOUND` (the order named only products the company does not stock — impossible after a passing `stock.check`, so an RPC error rather than a fact is the honest answer; the orchestrator treats it as transport failure and parks the command for a human, which is the correct outcome for a contract violation — recorded as an open point).

### 3.4 Domain errors

All extend `DomainError` with a stable `code`: `InsufficientStockError` (`INSUFFICIENT_STOCK`, carries `productCode`, `requested`, `available`), `ReservationTerminalError` (`RESERVATION_TERMINAL`, carries the attempted transition), `InvalidStockItemSnapshotError` (`INVALID_STOCK_ITEM_SNAPSHOT`), `FactAggregateMismatchError` (`FACT_AGGREGATE_MISMATCH`), `UnknownReservationError` (`UNKNOWN_RESERVATION`). `rpc-error-mapper.ts` §6.4 is where these codes become wire codes.

### 3.5 Invariants → where they are enforced

| Invariant | Enforced by | Proven by |
|---|---|---|
| F1 `reservedUnits ≤ units` | `StockItem.reserve` (throws), `StockItem.reconstitute` (refuses) | `R30` domain unit |
| F2 counter = Σ reserved | every counter mutation co-located with its reservation mutation; `saveAll` writes both in one tx | `FS12` unit + integration |
| F3 all-or-nothing per order | `reserveOrderStock` evaluates all lines before mutating any | `R32`/`R33` domain unit, `FS6` integration |
| F4 terminal states | `Reservation.release/consume` throw from `released`/`consumed` | `R35` domain unit, `FS10` |
| F5 release is a no-op once released | `StockItem.release` returns `[]`, `releaseOrderStock` emits nothing | `R34` domain unit + integration, `FS9` |

## 4. The check-then-reserve race, honestly

### 4.1 `stock.check` is a read that holds nothing

`CheckStockQuery` runs a plain `SELECT units, reserved_units FROM stock WHERE company_code = ? AND product_code IN (…)` — **no** `FOR UPDATE`, **no** transaction, no reservation row, no counter change, no outbox row (`R31`). Its reply says *"at the moment of this read, each line was / was not satisfiable"*; `StockCheckReplyPayload.available`'s own description already says *"it is not a promise, and it is not a reservation"*. Orders calls it **before** persisting the order (saga.md §3.1 step 0) so an obviously unfulfillable order is refused synchronously with a `STOCK_UNAVAILABLE` reply instead of being accepted and cancelled a second later. That is its whole job.

### 4.2 `stock.reserve` is the authoritative claim — and F3 wins over §8 rule 6

Between the check and the reserve, any number of other orders may have reserved the same units. The reserve is therefore the **only** place availability is decided, and it decides under a lock. When it finds the units gone it emits `stock.rejected.v1` and the saga takes Path A (saga.md §4.1: *"The race is real and intentional … That is precisely why the saga exists"*). **This is not a bug to paper over**: no "re-check and retry" loop, no soft-hold at check time, no reservation TTL. `FS7`'s integration test makes a check succeed, lets another order take the units, and asserts the later reserve is rejected cleanly — the designed outcome, observable in the timeline.

**The tension with domain-model.md §8 rule 6** (*"One transaction mutates exactly one aggregate instance plus its outbox records"*) is real and is resolved in favour of **F3**, because F3 is a normative invariant in the same document and rule 6 is a cross-cutting default. One `stock.reserve` transaction mutates **one `StockItem` per distinct product of the order** (plus their reservation rows plus one outbox row). What makes that safe is the lock protocol below, which makes the N-item transaction behave like a single serialisable claim over exactly those N rows. Flagged at the gate and listed as a promotion candidate (requirements §3) so #8/#9 inherit the ruling rather than the contradiction.

### 4.3 The lock protocol for `stock.reserve`

Inside one `UnitOfWork.execute`, in this order, nothing else:

```sql
-- 1. claim the stock rows — ONE statement, index order, exclusive
SELECT * FROM stock
 WHERE company_code = :company AND product_code IN (:distinct product codes of the request)
 ORDER BY company_code, product_code
 FOR UPDATE;

-- 2. the order's existing reservations (responder idempotency, FS5) — a LOCKING read, after the stock locks
SELECT * FROM reservations WHERE order_reference = :ref FOR UPDATE;

-- 3. domain: reserveOrderStock(items, input, ctx)  -- pure, decides reserved|rejected

-- 4. reserved: INSERT reservations (one per line), UPDATE stock SET reserved_units = :new WHERE id = :id (per item),
--    INSERT outbox (one row: stock.reserved.v1)
--    rejected: UPDATE nothing on stock/reservations, INSERT outbox (one row: stock.rejected.v1)
-- COMMIT
```

- **Why one statement with `ORDER BY` on the unique index.** InnoDB takes the row locks in the order it scans `uq_stock_company_product (company_code, product_code)`, which is ascending `(company_code, product_code)` regardless of the order the `IN` list was written in. Two concurrent multi-line reserves therefore always request their overlapping locks in the **same global order** — the classic deadlock shape (A locks P1 then wants P2, B locks P2 then wants P1) cannot form. The `ORDER BY` makes the intent explicit and survives a planner change; the `Map` the repository returns is keyed by `productCode` so the domain service never depends on row order. Distinct product codes are locked once even if the order repeats a product on two lines (the service sums the lines' units per product for the availability check and still creates one reservation per line).
- **Why the reservations read comes second and is locking.** Two `stock.reserve` for the **same** order (the orchestrator's sweeper re-issuing a row whose reply was lost) must not both reserve. Because both first block on the same stock rows, the second runs step 2 only after the first has committed, and `FOR UPDATE` makes that read a current read rather than a repeatable-read snapshot taken earlier — it sees the first's committed rows and answers `already_reserved` (`FS5`). Without the lock ordering "stock first", the idempotency check would be racy by construction.
- **Why the transaction is short.** It contains four statements and a pure function. No NATS, no Kafka, no clock read beyond `clock.now()` once; the reply is sent after commit, the fact leaves through the relay. The open-lock window is milliseconds, which is what makes the hot-item contention of a demo acceptable.
- **Isolation level.** MySQL's default `REPEATABLE READ` is kept; the protocol relies only on `FOR UPDATE` current reads, which behave identically under `READ COMMITTED`. Nothing is tuned per connection.

### 4.4 The lock protocol for `stock.release`

Release has the inverse problem: it knows the `orderReference` but not the products until it reads the reservations. To keep the **same global order** (stock rows first, always) it performs a cheap non-locking pre-read:

```sql
-- 0. which items? (non-locking, may be stale — that is fine, it only chooses what to lock)
SELECT DISTINCT stock_id FROM reservations WHERE order_reference = :ref;
-- none -> reply already_released with [] (FS9), no transaction needed

-- 1. lock those stock rows, index order (same statement shape as reserve step 1, by id list ordered by (company_code, product_code))
-- 2. the order's reservations, FOR UPDATE (now authoritative)
-- 3. domain: releaseOrderStock(items, input, ctx)
-- 4. released: UPDATE reservations SET status='released' (per row), UPDATE stock SET reserved_units (per item), INSERT outbox (stock.released.v1)
--    already_released: nothing written
-- COMMIT
```

A reservation inserted for this order between step 0 and step 1 is impossible in practice (reservations for an order are created once, under the stock locks, by `stock.reserve`) — but if step 2 ever returned a stock id not locked in step 1, the handler aborts with `ConcurrentReservationChangeError` and lets the orchestrator retry, rather than releasing under a lock it does not hold. That is a defensive branch with a unit test, not an expected path.

### 4.5 Responder idempotency — the keys, stated once

| Command | Idempotency key (saga.md §2) | What a repeat observes | Reply | Fact |
|---|---|---|---|---|
| `stock.reserve` | `orderReference` | any reservation rows for the order (any status) | `already_reserved` + existing `ReservationRef`s | none |
| `stock.release` | `orderReference` | no row `reserved` (all `released`, or none at all) | `already_released` + `released: []` | none |
| `stock.release` | `orderReference` | a row `consumed` | `RpcError` `PRECONDITION_FAILED` | none |
| `stock.replenish` | — (not a saga command; `R61`) | — | applied again | none — **not idempotent by design**: a top-up is a delta, and the Gateway/demo workflow owns "did I already send this" (open point) |
| `stock.check`, `stock.list` | — (reads) | — | — | none |

`x-request-id` is **not** the idempotency key. saga.md fixes the key as `(orderReference, operation)`, and the repeat case must behave identically whether the retry comes from the in-line policy (same row id) or from an operator re-running the whole saga step with a new row. The header is the *causation* carrier (`FS3`), nothing more.

## 5. The application layer — `@nestjs/cqrs`, binding

### 5.1 Buses and handlers

| Subject | Bus | Message class | Handler | Transactional? |
|---|---|---|---|---|
| `fulfillment.stock.check` | `QueryBus` | `CheckStockQuery { companyCode, lines }` | `CheckStockHandler` → `StockReadPort.availability` | no — one plain SELECT |
| `fulfillment.stock.list` | `QueryBus` | `ListStockQuery { companyCode?, productCode?, belowThreshold?, page, pageSize }` | `ListStockHandler` → `StockReadPort.list` | no |
| `fulfillment.stock.reserve` | `CommandBus` | `ReserveStockCommand { request, correlationId, requestId }` | `ReserveStockHandler` → `StockReservationHandler.reserve` | yes — §4.3 |
| `fulfillment.stock.release` | `CommandBus` | `ReleaseStockCommand { request, correlationId, requestId }` | `ReleaseStockHandler` → `StockReservationHandler.release` | yes — §4.4 |
| `fulfillment.stock.replenish` | `CommandBus` | `ReplenishStockCommand { request }` | `ReplenishStockHandler` | yes — lock the named items (same index-ordered `FOR UPDATE`), `replenish` each, `saveAll`; no outbox row |

The `@QueryHandler`/`@CommandHandler` classes are thin: they own no logic beyond delegation, take every dependency through `@Inject(TOKEN)` (the CLAUDE.md DI rule — the ESLint selector covers `QueryHandler` and `CommandHandler`), and are registered as **class providers** (decorator discovery needs the class). `StockReservationHandler` is a plain class (no decorator, `useFactory`-wired) so its spec can `new` it with fakes — the same split `SagaFactHandler` uses. **No `EventBus`, no `@Saga` here**: the saga orchestrator lives in Orders (CLAUDE.md), and Fulfillment owes no post-commit in-process hop — its post-commit obligation (publish the fact) is the relay's, and durability never depends on the in-memory buses. The `CommandBus` hop is synchronous and awaited by the controller, so "reply after commit" is structural.

### 5.2 Ports

```ts
// stock-item-repository.port.ts
export const STOCK_ITEM_REPOSITORY = Symbol('StockItemRepository');
export interface StockItemRepository {
  /** FOR UPDATE, one statement, ORDER BY (company_code, product_code) (§4.3 step 1). Loads, for each item, ONLY the reservations of `orderReference` (§3.1). Unknown product codes are simply absent from the returned Map. */
  lockForOrder(tx: TransactionContext, companyCode: string, productCodes: readonly string[], orderReference: OrderNumber): Promise<ReadonlyMap<string, StockItem>>;
  /** Non-locking pre-read for release (§4.4 step 0) — returns the distinct stock ids the order's reservations point at. */
  stockIdsOfOrder(orderReference: OrderNumber): Promise<readonly UniqueId[]>;
  /** FOR UPDATE by id list, index-ordered (§4.4 step 1), loading the order's reservations. */
  lockByIdsForOrder(tx: TransactionContext, ids: readonly UniqueId[], orderReference: OrderNumber): Promise<readonly StockItem[]>;
  /** Upserts each item's row and its loaded reservations, then drains EVERY item's pullDomainEvents() into the outbox, all inside `tx` (R13). `tx` required — never opens its own. */
  saveAll(items: readonly StockItem[], tx: TransactionContext): Promise<void>;
}

// stock-read.port.ts — the QueryBus side; never locks, never mutates
export const STOCK_READ = Symbol('StockRead');
export interface StockReadPort {
  availability(companyCode: string, lines: readonly { productCode: string; quantity: number }[]): Promise<StockCheckReplyPayload>;
  list(query: StockListRequestPayload): Promise<StockListReplyPayload>;
}
```

`CLOCK`, `UNIT_OF_WORK`, `FACT_PUBLISHER` and `consumer-name.ts` are verbatim copies of the Orders files at the identical relative paths — the OI12 whitelist (`../../application/ports/unit-of-work.port`, `clock.port`, `consumer-name`) requires those paths to exist in every service that carries the consumer pattern (§9).

### 5.3 The reserve/release transactional unit

```ts
// apps/fulfillment/src/application/stock-reservation.handler.ts  (plain class)
export class StockReservationHandler {
  constructor(unitOfWork: UnitOfWork, stock: StockItemRepository, clock: Clock) {}
  reserve(cmd: ReserveStockCommand): Promise<StockReserveReplyPayload>;   // §4.3; throws NoKnownStockItemError when no line resolves (→ NOT_FOUND, §3.3)
  release(cmd: ReleaseStockCommand): Promise<StockReleaseReplyPayload>;   // §4.4; lets ReservationTerminalError propagate (→ PRECONDITION_FAILED)
}
```

`reserve` flow: `unitOfWork.execute(tx => lockForOrder → if any reservation rows for the order already loaded on any item → build already_reserved from them (no domain call, nothing written) → else reserveOrderStock(...) → saveAll(items) → map outcome to reply)`. The reply is built from the domain outcome **before** commit but returned **after** `execute` resolves, so a rollback can never have produced a success reply. `ctx = { occurredAt: clock.now(), causationId: cmd.requestId }` (`FS3`, `R12`). Business rejection (`rejected`) is a resolved reply, never a throw — saga.md §7: a rejection is a domain outcome.

## 6. Presentation — the five responders

### 6.1 The controller

```ts
@Controller()
export class StockController {
  constructor(@Inject(QueryBus) private readonly queries: QueryBus, @Inject(CommandBus) private readonly commands: CommandBus) {}

  @MessagePattern('fulfillment.stock.check', Transport.NATS)     check(@Payload() p: unknown): Promise<StockCheckReplyPayload | RpcError>;
  @MessagePattern('fulfillment.stock.reserve', Transport.NATS)   reserve(@Payload() p: unknown, @Ctx() ctx: NatsContext): Promise<StockReserveReplyPayload | RpcError>;
  @MessagePattern('fulfillment.stock.release', Transport.NATS)   release(@Payload() p: unknown, @Ctx() ctx: NatsContext): Promise<StockReleaseReplyPayload | RpcError>;
  @MessagePattern('fulfillment.stock.list', Transport.NATS)      list(@Payload() p: unknown): Promise<StockListReplyPayload | RpcError>;
  @MessagePattern('fulfillment.stock.replenish', Transport.NATS) replenish(@Payload() p: unknown): Promise<StockReplenishReplyPayload | RpcError>;
}
```

Every pattern names `Transport.NATS` (CLAUDE.md non-negotiable + ESLint guard). Subjects are constants in the controller module, guarded by a read-the-spec-as-text unit test asserting each equals its AsyncAPI channel `address` — the same instrument `kafka.config.spec.ts` and `nats-saga-commands.adapter.spec.ts` use. **The controller never throws** (the `orders-create.controller.ts` rule): validate → dispatch → `try/catch` → `toRpcError`. Headers come from `ctx.getHeaders()` (`nats` `MsgHdrs`): `x-correlation-id` and `x-request-id` are parsed with `UniqueId.from`; absent/invalid on reserve/release ⇒ `validationRpcError` before any dispatch (`FS3`).

### 6.2 DTOs

`dto/stock.dto.ts` — five `class-validator` classes each `implements` its generated `@otc/contracts` request payload (compile-time field parity, the `OrdersCreateRequestDto` precedent): `StockCheckRequestDto` (`companyCode` string, `lines` ≥ 1 of `{productCode, quantity ≥ 1 int}`), `StockReserveRequestDto` (`orderReference` matching `/^ORD-\d{6}$/`, `retailerCode`, `companyCode`, `lines` ≥ 1 of `{productCode, units ≥ 1}`), `StockReleaseRequestDto` (`orderReference`, `reason ∈ {credit_rejected, order_cancelled}`), `StockListRequestDto` (optional `companyCode`/`productCode`/`belowThreshold`, `page ≥ 1` default 1, `pageSize 1..200` default 25), `StockReplenishRequestDto` (`companyCode`, `lines` ≥ 1 of `{productCode, units ≥ 1}`). Validated manually with `validate(dto, { whitelist: true })` inside the controller so a failure is an `RpcError` under this feature's control. `class-validator` + `class-transformer` join `apps/fulfillment/package.json` (already in the catalog).

### 6.3 The wire finding: bare JSON in, bare JSON out — a (de)serializer pair, not a Nest packet

**What exists on the calling side.** Orders' two outbound adapters (`nats-stock-availability.adapter.ts`, `nats-saga-commands.adapter.ts`) use the raw `nats` client: `connection.request(subject, JSONCodec.encode(payload), { timeout })` and decode the reply as the bare `…ReplyPayload | RpcError`. That is the AsyncAPI wire shape, and it is what the stub responders in Orders' integration tests speak.

**What `@nestjs/microservices`' NATS server does by default** (verified against the installed `@nestjs/microservices@11.2.1`, `server/server-nats.js` `handleMessage`/`getPublisher`, `deserializers/incoming-request.deserializer.js`, `serializers/nats-record.serializer.js`):

1. A bare JSON request has no `id`, so `IncomingRequestDeserializer.isExternal` maps it to `{ pattern: <subject>, data: <payload> }` **without an `id`** — and `ServerNats.handleMessage` then routes any id-less message to **`handleEvent`**, which runs the handler and **never replies**. Orders' adapters would time out on every call; the saga would park every command against a responder that is actually running.
2. A reply is serialised by `NatsRecordSerializer` as the Nest packet `{ response, isDisposed, id, err }` — not the bare payload Orders decodes.

Neither has bitten yet because no Nest-served NATS handler has been called by a raw client in this repository (`orders.create`'s integration test uses `ClientProxyFactory`; the stock-check and saga stubs are raw `nats` subscriptions, not Nest servers). Feature 17 is the first time a real Nest responder meets a real raw caller, so it is designed here rather than discovered on first boot.

**Decision: Fulfillment's NATS microservice installs two small adapters** (`infrastructure/messaging/bare-json-nats.{deserializer,serializer}.ts`), passed as `options.deserializer` / `options.serializer` in `main.ts`:

- `BareJsonNatsDeserializer extends NatsRequestJSONDeserializer`: after `super.deserialize`, if the packet has no `id` **and** `options.replyTo` is set (the caller expects an answer) it assigns `id = randomUUID()`, turning the message into a request. A message with no reply subject stays an event. The synthetic id exists only to route Nest's reply; it is never read by a handler (idempotency is `orderReference`-scoped, §4.5).
- `BareJsonNatsSerializer`: `serialize(packet)` encodes **`packet.response`** alone when present; when `packet.err` is set (the only source is Nest's own `NO_MESSAGE_HANDLER`, since controllers never throw) it encodes `{ code: 'INTERNAL_ERROR', message: String(err), occurredAt }` — a valid `RpcError`. Nothing else from the packet reaches the wire.

| Rejected alternative | Why not |
|---|---|
| Change Orders' adapters to `ClientProxy` | Re-opens two landed, reviewed adapters and their four integration suites; and the Nest packet is a Nest-ism, not the trilogy contract — #8/#9 could not interoperate with it |
| Serve the responders with a raw `nats` subscription loop instead of `@MessagePattern` | Abandons the mandated `@nestjs/microservices` presentation layer and the `Transport.NATS` convention; also loses `@Ctx()` headers and the cqrs wiring shape every service shares |
| Accept both shapes (sniff for `pattern`/`id`) | Exactly the "two meanings for one field" ambiguity feature 14 §3.1 rejected for the outbox payload |

**Consequences recorded for later features.** (a) Orders' own `orders.create` responder still replies in Nest packet shape; the Gateway (feature 25) must either call it with `ClientProxy` or Orders adopts the same pair — flagged, not changed here. (b) `x-deadline-ms` and `traceparent` are not read; feature 27's. `stock-wire.integration.spec.ts` (`FS4`) proves all five subjects answer a raw `nats` client with bare JSON, and that a validation failure is a bare `RpcError`.

### 6.4 `rpc-error-mapper.ts` — Fulfillment's own

A pure function, same shape as Orders' but a **different file with different cases** (not a parity-guarded copy — the error vocabularies differ by service): `ValidationError[]` → `VALIDATION_FAILED`; `NoKnownStockItemError` / `UnknownStockItemError` (replenish) → `NOT_FOUND` with `details.productCode`; `ReservationTerminalError` → `PRECONDITION_FAILED` with `details.code`; `ConcurrentReservationChangeError` → `CONFLICT`; any other `DomainError` → `DOMAIN_ERROR` with `details.code` (Fulfillment's domain refusals are not client-caused the way an order's are, so `DOMAIN_ERROR` rather than Orders' `VALIDATION_FAILED` mapping); anything else → `INTERNAL_ERROR`. `occurredAt` via `new Date()` at the edge, as the Orders mapper does — the only place outside the `Clock` port time is read, and only for an error reply.

## 7. Persistence — the Drizzle adapters

`DrizzleStockItemRepository` (plain class; `FulfillmentDb` + `Clock`; `OutboxRecorder` defaulted the way `DrizzleOrderRepository` defaults it):

- `lockForOrder`: `db.select().from(stock).where(and(eq(companyCode), inArray(productCode, codes))).orderBy(stock.companyCode, stock.productCode).for('update')` — Drizzle's `.for('update')` without `skipLocked` (we **want** to wait: a contender must block, not skip). Then one `select … from reservations where stock_id in (…) and order_reference = ? for update`. Reconstitute each item with its subset. Returns a `Map<productCode, StockItem>`.
- `saveAll`: per item `insert(stock).values(row).onDuplicateKeyUpdate({ set: { units, reservedUnits, lowStockThreshold, updatedAt } })`; per loaded reservation `insert(reservations).values(row).onDuplicateKeyUpdate({ set: { status, updatedAt } })` (the `VALUES()` multi-row form the Orders repository uses); then `outboxRecorder.record(tx, items.flatMap(i => i.pullDomainEvents()))` — the repository drains, never the handler (feature 14 §4.4, OI9's drained-events hazard applies unchanged: a failed unit of work invalidates the instances; a retry re-locks and re-derives).
- `stock-item.mapper.ts`: `rowToSnapshot` / `snapshotToRow`, `reservedUnits`/`units` as integers, dates as UTC `Date`s (the pool is created with `timezone: 'Z'`, `client.ts`).

`DrizzleStockReadRepository` (`StockReadPort`): `availability` = one SELECT + per-line arithmetic, unknown product ⇒ `{ available: 0, sufficient: false }`; `list` = `WHERE` from the optional filters, `belowThreshold` ⇒ `units - reserved_units < low_stock_threshold` in SQL, `ORDER BY company_code, product_code`, `LIMIT/OFFSET` from the page, plus a `COUNT(*)` for `PageInfo.total`. Two queries, no transaction.

`drizzle-unit-of-work.ts`: the Orders file with `OrdersDb/OrdersTx` → `FulfillmentDb/FulfillmentTx`; `asDrizzleTx` remains the single unwrap and is what the copied `processed-events.repository.ts` imports (OI12 whitelist `../persistence/drizzle-unit-of-work`).

## 8. The outbox: writer, relay, publisher — copies, and the rule that governs them

### 8.1 What is copied

`outbox-recorder.ts`, `outbox-envelope-mapper.ts`, `outbox-relay.ts`, `outbox-relay.service.ts`, `outbox-relay.config.ts`, `kafka-fact-publisher.ts`, `create-kafka-client.ts`, `kafka.config.ts` and the two test fixtures — taken from `apps/orders/src/infrastructure/outbox/` with exactly these edits: `OrdersDb` → `FulfillmentDb` (relay), `ORDERS_FACTS_TOPIC` → `FULFILLMENT_FACTS_TOPIC = 'otc.fulfillment.facts.v1'` (publisher default, config), clientId default `otc-fulfillment`, and a banner on each file naming the Orders original. Same poll (`published_at IS NULL ORDER BY seq FOR UPDATE SKIP LOCKED`), same stamp-after-ack, same idempotent producer, same self-scheduling loop, same `OUTBOX_*` settings. The **schema** is already byte-identical by OI11 (`apps/seed/src/outbox-parity.spec.ts`), which is what makes the SQL inside the relay copy correct without change.

### 8.2 The rule: copy per service — the same verdict as feature 14 §6.3, for the same reasons

CLAUDE.md: *"The only shared runtime code is `packages/shared-kernel` and `packages/contracts`. Nothing else is shared."* A `packages/outbox` would be the third shared runtime package the non-negotiable forbids, and it would couple three services' release cadence for ~300 lines. The relay is infrastructure code over a table that is already duplicated per service by the database-per-service rule; duplicating the code that reads it is the honest consequence. Feature 14 §6.3 ruled exactly this for the consumer pattern and added OI12 so the duplication is guarded, not trusted. The relay family follows the rule — with the guard status stated plainly in §8.3.

### 8.3 What is parity-guarded today, and what is not — said out loud

- **Guarded now:** the idempotent-consumer pair (OI12, arms at this feature's copy — §9) and the schema (OI11).
- **Not guarded by this feature:** the relay family. The reason is mechanical, not a preference: OI12's instrument is banner-stripped byte identity, and the canonical `outbox-relay.ts` names `OrdersDb` (a service-specific type) in its imports and its `deps` interface, so a byte-identical copy is impossible *without first editing the canonical* to a service-neutral type (for example `MySql2Database<Record<string, unknown>>`, which `tx.select().from(outbox)` accepts). That edit is an Orders change outside this feature's bounded §10 scope, and it is the natural precondition of the **third** copy. **Decision:** feature 19 `billing_credit` (which creates the third copy) owns (a) making the canonical relay family service-neutral and (b) extending the parity instrument to it. This feature's copies carry the same banner shape OI12 requires (`// COPY OF — apps/orders/src/infrastructure/outbox/<file>`) so that guard can be armed retroactively without touching them. Flagged at the gate as a conscious deferral.

### 8.4 Topic, key, headers

Fulfillment publishes **only** to `otc.fulfillment.facts.v1` (one topic per service, feature 14 §5.3); `kafka.config.spec.ts` reads `asyncapi.yaml` as text and asserts the constant equals the `fulfillmentFacts` channel's `bindings.kafka.topic` (the topic already exists: `infra/kafka/create-topics.sh`, 6 partitions). Key = `correlationId` = the order id from `x-correlation-id` (`R15`) — which is why `FS3` refuses a reserve/release without it: a fact without the order id would land on an arbitrary partition and break per-order ordering for the orchestrator.

## 9. Consumers — none in this feature; the pattern copy is scaffolded anyway

Per saga.md §5, Fulfillment consumes **no** fact: `stock.reserve`/`stock.release`/`despatch.create` are all command-driven. `main.ts` therefore connects **one** microservice transport (NATS) plus HTTP — no Kafka consumer, no `@EventPattern`. The relay's kafkajs producer is the only Kafka client.

The idempotent-consumer pair **is still copied now**, verbatim with the OI12 banner (`apps/fulfillment/src/infrastructure/messaging/idempotent-consumer.ts`, `processed-events.repository.ts`), for three reasons: (1) OI12 case 1 (*"holds every write model's copy … byte-identical"*) is vacuous with a single copy and the design of feature 14 says it *"arms at the second copy (feature 17)"* — this is that copy; (2) the `processed_events` table and the three port files the copy imports exist at the whitelisted paths already, so the copy costs nothing and proves the whitelist's portability claim on a second service tree; (3) feature 18 or any later Fulfillment consumer then starts from a guarded copy rather than a fresh paste. `consumer-name.ts` declares `CONSUMER_NAMES = [] as const` — the shared § Vocabulary names no Fulfillment consumer, so `ConsumerName` is `never` and `runOnce` is **uncallable** until the shared vocabulary grows (requirements §3). That is the honest type: the pattern is present, armed for parity, and cannot be used by accident.

## 10. Orders-side changes — bounded to `FS1` and `FS2`

### 10.1 D1 — `enqueue` idempotent on `(order_id, command)`

`SagaCommandStore.enqueue` returns `Promise<EnqueueOutcome>` with `type EnqueueOutcome = 'enqueued' | 'already_owed'`. `DrizzleSagaCommandStore.enqueue` becomes `insert(sagaCommands).values(...).onDuplicateKeyUpdate({ set: { id: sql\`id\` } })` (MySQL's idiom for "insert or leave untouched"; `affectedRows` = 1 ⇒ `enqueued`, 2 or 0 ⇒ `already_owed` — Drizzle exposes the `ResultSetHeader` the existing `affectedRows()` helper already parses). The existing row keeps its `id`, `status`, `attempts`, `payload` — a parked row is not reset, a sent row is not reopened. `SagaFactHandler` sets `enqueued = step.commandAfter` for **both** outcomes, so the wrapping `@CommandHandler` publishes the dispatch-owed event and the fast path re-dispatches: `SagaCommandDispatcher.dispatch` already no-ops on `sent` and resumes `pending`/`parked` (design 16 §5.5). The **only** behavioural change is that the transactional unit no longer rejects on `uq_saga_commands_order_command` — the crash-loop the reviewer reproduced (P3) cannot recur. Tests: the unit row in `saga-fact-handler.spec.ts` and the integration case added to `saga-compensation-credit-rejected.integration.spec.ts` (requirements §2), which replays the reviewer's scenario: `stock.release` parked, a second `credit.rejected.v1` with a **new** `eventId` arrives, the consumer does not crash, `saga_commands` still holds one `stock.release` row with its original id, `processed_events` has both event ids, and the order is still `stock_reserved`. Synchronise on durable evidence only: the second `processed_events` row (append-only) and the row count — never on a transient status.

### 10.2 `FS2` — the correlation and request headers on every saga command

`SagaCommandsPort` methods gain a second parameter `meta: SagaCommandMeta = { correlationId: UniqueId; requestId: UniqueId }`; `NatsSagaCommandsAdapter.call` builds `nats` `headers()` with `x-correlation-id = meta.correlationId.value` and `x-request-id = meta.requestId.value` and passes `{ timeout, headers }` to `request` (`NatsRequestClient.request`'s `opts` type widens accordingly; the unit fake records headers). `SagaCommandDispatcher.dispatch` passes `{ correlationId: row.orderId, requestId: row.id }` on **every** attempt of every cycle — the row id is stable across in-line retries and sweeper re-issues, which is exactly `RpcHeaders`' *"a retry reuses the same value"*. `NatsStockAvailabilityAdapter` is untouched (no order exists at check time). The stub responders in Orders' `test-support/` ignore headers and keep working; `resolveOrderId` there becomes unnecessary but is left alone (test-support is not production code, and shrinking it is not this feature's job).

**Explicitly not touched:** D2 (`Date.now()` in the dispatcher), D4, D5, D6, and `PlaceOrderHandler`. Each is listed in the progress file's hand-over so the next Orders pass picks them up.

## 11. First boot against the live compose stack — designed, not discovered

Pre-state (from `progress/impl_order_saga_orchestrator.md` and the feature-16 review): `otc_orders.saga_commands` holds three `parked` `stock.reserve` rows for `ORD-000007/8/9` (attempts climbing on the capped schedule, `next_attempt_at ≤ 15 min` away); `otc_orders.orders` has them in `placed`; `otc_fulfillment.stock` holds the seeded rows (500 on hand minus seeded consumption per pair, `reserved_units = 0`), `reservations` holds only seeded terminal rows, `outbox` only seeded pre-stamped rows. Orders must be **rebuilt and restarted** with §10 (headers + idempotent enqueue) before or together with Fulfillment's first start — without `FS2`'s headers, the first real `stock.reserve` is refused `VALIDATION_FAILED` (`FS3`), which the dispatcher treats as a transport error and parks again; loud, safe, and a useful negative check to run once on purpose.

Expected sequence once `pnpm dev:fulfillment` (or `build && start`) is up, **unattended**:

1. Within `SAGA_SWEEPER_INTERVAL_MS` of a parked row's `next_attempt_at`, Orders' sweeper re-issues `stock.reserve` with `x-correlation-id = <order id>`, `x-request-id = <row id>`.
2. Fulfillment answers: `reservations` gains one `reserved` row per line for `ORD-00000x` (if the seeded stock covers the lines — it does, unless the live-check orders asked for > 500 units), `stock.reserved_units` rises accordingly, `otc_fulfillment.outbox` gains one `stock.reserved.v1` row; the relay stamps it published within `OUTBOX_POLL_INTERVAL_MS`; the reply `accepted` marks the `saga_commands` row `sent`. (A short line instead yields `stock.rejected.v1`, reply `rejected`, row `sent` — SO6.)
3. The orchestrator consumes `stock.reserved.v1` from `otc.fulfillment.facts.v1`: `orders.status` → `stock_reserved`, one new `saga_commands` row `credit.hold` → `NoResponders` → 3 attempts → **parked**. (`stock.rejected.v1` instead: → `cancelled`/`stock_rejected`, `order.cancelled.v1` in Orders' outbox, **no** `stock.release` row — R26.)
4. Steady state: three `sent` `stock.reserve` rows, three `parked` `credit.hold` rows, three orders in `stock_reserved` (or `cancelled`), three `reserved` reservation sets visible in `SELECT order_reference, product_code, units, status FROM reservations WHERE order_reference IN ('ORD-000007','ORD-000008','ORD-000009')`. Billing's arrival (feature 19) repeats the same unattended story one step further.

The implementer records the actual `SELECT` outputs and the structured log lines (`stock.reserve` handled, relay published, orchestrator advanced) in `progress/impl_fulfillment_stock.md` § Live boot, with timestamps — the human's manual verification script is derived from that section. If the human prefers a clean slate, the established recreate procedure (`docker compose down -v` → up → migrate → seed) empties both topics and tables; then the verification is "place an order through `orders.create`, watch it reach `stock_reserved` and park at `credit.hold`" — either path is correct and the choice is recorded.

## 12. Configuration and dependencies

| Setting | Default | Note |
|---|---|---|
| `NATS_URL` | `nats://localhost:4222` | reused — the NATS microservice's `servers` |
| `KAFKA_BROKERS` | `localhost:9092` | reused — the relay producer |
| `FULFILLMENT_KAFKA_CLIENT_ID` | `otc-fulfillment` | new — `KAFKA_CLIENT_ID` is Orders' (`otc-orders`); a second service must not silently share the name |
| `OUTBOX_RELAY_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_PUBLISH_TIMEOUT_MS` | as Orders | reused names — both relays read the same four values; a per-service override is not needed until one is tuned differently (open point) |
| `FULFILLMENT_PORT` | `3003` | existing |

`.env.example` gains `FULFILLMENT_KAFKA_CLIENT_ID` with a comment next to `KAFKA_CLIENT_ID`.

**Packages added to `apps/fulfillment/package.json`** (all already in the workspace catalog — **no new catalog entry**; each named in the phase commit message's package section): `@nestjs/cqrs`, `@nestjs/microservices`, `class-validator`, `class-transformer`, `kafkajs`, `nats`; dev: `@nestjs/testing`, `@testcontainers/kafka`, `@testcontainers/nats`. `apps/fulfillment/tsconfig.build.json` gains `"src/**/test-support/**"` in `exclude` (advisory N4 — replicated here as feature 15's review asked). `eslint.config.mjs` is untouched: its `apps/*/src/**` globs already cover Fulfillment.

## 13. Testing approach

| File | Level | Runner | Proves |
|---|---|---|---|
| `domain/stock-item.spec.ts` | domain unit | `vitest.config.mts` (in `pnpm quality`) | `R30` (matrix name `stock-item.spec`), `FS10`, `FS11`, `FS12` unit half, `R61` domain half (`stock-replenishment` cases live here; the matrix's `stock-replenishment.spec` name is kept as the `describe` block) |
| `domain/reservation.spec.ts` | domain unit | idem | `R32`, `R33`, `R35` (matrix names `reservation.spec` › the three quoted cases) |
| `domain/order-stock-reservation.spec.ts` | domain unit | idem | `R34` domain half (matrix name `reservation-release.spec` kept as the `describe`), `FS8`, `FS13`, F3 all-or-nothing across three items |
| `application/stock.command-handlers.spec.ts`, `stock.query-handlers.spec.ts`, `stock-reservation.handler.spec.ts` | unit | idem | delegation, reply built after commit, already_reserved short-circuit, `NOT_FOUND` when no carrier |
| `presentation/stock.controller.spec.ts`, `rpc-error-mapper.spec.ts` | unit | idem | `FS3` header refusal, validation → `RpcError`, never throws, subject constants = AsyncAPI addresses |
| `infrastructure/messaging/bare-json-nats.spec.ts` | unit | idem | §6.3 both directions |
| `infrastructure/outbox/kafka.config.spec.ts`, `outbox-relay.spec.ts` | unit | idem | topic guard; OI6 no-overlap on the copy |
| `apps/orders/.../idempotent-consumer.parity.spec.ts` (existing) | unit | idem | OI12 case 1 **armed** by the Fulfillment copy |
| `stock-check.integration.spec.ts` | integration | `vitest.integration.config.mts` — Testcontainers MySQL `mysql:8.4.11` + NATS `nats:2.14.5-alpine` | `R31` |
| `stock-reserve.integration.spec.ts` | integration | MySQL + NATS + Kafka `apache/kafka:4.3.1` | `R32`/`R33` integration halves, `FS3`, `FS5` |
| `stock-reserve-race.integration.spec.ts` | integration | idem | `FS6`, `FS7` — the acceptance criterion |
| `stock-release-idempotency.integration.spec.ts` | integration | idem | `R34` integration half (matrix name), `FS9`, `FS10` |
| `stock-replenish.integration.spec.ts`, `stock-list.integration.spec.ts`, `stock-wire.integration.spec.ts` | integration | MySQL + NATS | `FS14`, `FS15`, `FS4` |
| `infrastructure/persistence/*.integration.spec.ts` | integration | MySQL | `FS12` stored equality, lock order (`SHOW ENGINE INNODB STATUS` is not asserted — the race test is the proof), read queries |
| `infrastructure/outbox/outbox-relay.integration.spec.ts` | integration | MySQL + Kafka | `FS16` |
| `apps/orders/src/saga-compensation-credit-rejected.integration.spec.ts` (extended), `saga-fact-handler.spec.ts`, `nats-saga-commands.adapter.spec.ts`, `saga-command-dispatcher.spec.ts` (extended) | unit + integration (Orders) | Orders' configs | `FS1`, `FS2` |

**The synchronisation rule (reviewer ruling, feature 16 third pass) is binding on every integration spec here.** Wait only on **terminal or monotonic** evidence: an outbox row's `published_at` (set once, never cleared), a reservation row's terminal status, the count of rows in an append-only table, the `claimed/published` result returned by a hand-driven `relay.runOnce()`, or a Kafka consumer's received-message list. Never poll `reserved_units` mid-flight or a reservation in `reserved` when the test intends to release it. For the race test (`FS6`): start two raw-`nats` requests with `Promise.all`, then assert on the **replies** (one `accepted`, one `rejected`), on the **final** `reserved_units ≤ units`, and on the outbox holding exactly one `stock.reserved.v1` and one `stock.rejected.v1` for the two correlation ids — all terminal facts. Repeat the pair 10× in a loop on a fresh item each time to make a scheduling fluke visible rather than lucky.

**Harness.** `test-support/stock-integration-harness.ts` boots the **real** `AppModule` provider graph (via `@nestjs/testing` `Test.createTestingModule({ imports: [AppModule] })` with the DB/NATS/Kafka config overridden from the containers) and connects the NATS microservice with the §6.3 (de)serializers — so the integration suites exercise the same DI wiring, decorators and serializers the live process uses, which is what would have caught the feature-16 transport-binding crash. Callers in the suites are raw `nats` clients (the production caller's shape), never `ClientProxy`. Images are the pinned tags `docker-compose.infra.yml` uses; the Fulfillment `vitest.integration.config.mts` adopts Orders' `fileParallelism: false` and the 180 s/120 s timeouts with the same comment.

## 14. Out of scope — restated

- **`despatch.create`** and everything `DespatchAdvice`: feature 18. `consume()` is delivered ready, with unit tests, and nothing calls it.
- **Billing**: features 19–22. The live stack will park at `credit.hold` (§11) by design.
- **DLQ, metrics, tracing, `traceparent`/`x-deadline-ms` on RPC, Terminus**: feature 27.
- **Gateway callers of `stock.list`/`stock.replenish`** and the `R61` API row: feature 25.
- **A relay-family parity guard** and the canonical's service-neutral refactor: feature 19 (§8.3).
- **Orders advisories D2, D4, D5, D6**: not this feature (§10).
