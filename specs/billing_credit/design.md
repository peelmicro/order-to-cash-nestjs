# `billing_credit` — Design (NestJS / TypeScript, assessment #7)

> **Stack-specific.** This file is where the NestJS, `@nestjs/cqrs`, `@nestjs/microservices` NATS, Drizzle, MySQL, kafkajs and Testcontainers detail lives. Nothing here belongs in `specs/shared/`; assessments #8 and #9 write their own equivalent against the same `R37` – `R41`.
>
> Authorities: [`specs/shared/domain-model.md`](../shared/domain-model.md) §5.1 (`BuyerCredit`, `CreditLedgerEntry`, the derived quantities, **B1** – **B5**), §7.1 (the envelope), §7.2 facts 5/6/7, §8 (cross-cutting rules); [`specs/shared/saga.md`](../shared/saga.md) §2 (command vocabulary), §3.1 steps 2/3 and 6, §4.2 – §4.3, §5, §6; [`specs/shared/asyncapi.yaml`](../shared/asyncapi.yaml) (`creditHold`/`creditList` channels, `RpcHeaders`, `RpcError`, `CreditApproved`/`CreditRejected`/`CreditReleased`, the `billingFacts` topic); [`specs/outbox_and_idempotency/design.md`](../outbox_and_idempotency/design.md) §4 – §6 (the `UnitOfWork`, repository-drains-aggregate, recorder, relay, idempotent-consumer pattern, `OI11`, `OI12`); **and above all [`specs/fulfillment_stock/design.md`](../fulfillment_stock/design.md), the reference implementation of a responder service — Billing mirrors its shape file for file and does not invent a new one.**
>
> Inherited work resolved here: `fulfillment_stock/design.md` §8.3's deferral (the canonical relay made service-neutral and parity-guarded at the **third** copy, which this feature creates) → §9; `review_fulfillment_despatch.md` **N1** (`outbox-parity.spec.ts` matching migration comments) → §10.1; **N3** (`verify.ts` on a long-lived dev DB) → §10.2. Left to its owner: **N2** (`despatch-creation.handler.ts`'s `companyCode`/`retailerCode` asymmetry) → §10.3.

## 1. Scope

**In scope.**

- The `BuyerCredit` aggregate root, the `CreditLedgerEntry` child entity, the pure exposure arithmetic, invariants **B1** – **B5**, and the three fact builders.
- Two NATS responders: `billing.credit.hold` (`R38`, `R39`) and `billing.credit.list` (the read side of **B1**).
- The **credit-decision port** feature 20's simulator will implement, plus the approve-everything adapter bound in its place today.
- Billing's own outbox recorder, relay, Kafka publisher and idempotent-consumer copies — the **third** copy of each, which is what arms the parity guard.
- The service-neutral refactor of the canonical outbox-relay family and the retroactive `OB1` parity guard across `apps/orders`, `apps/fulfillment`, `apps/billing`.
- `apps/seed` findings **N1** and **N3**.

**Out of scope.** The `.99` simulator and `CREDIT_FAILURE_RATE` (feature 20, `R42` – `R44`); invoice issue and the `consume` *caller* (feature 21, `R45` – `R46`); remittance intake and the `invoice_paid` *caller* (feature 22, `R47` – `R49`); a `billing.credit.release` responder (**no such subject exists** — `requirements.md` §3); DLQ, retry policy, metrics, tracing, Terminus (feature 27); the Gateway's callers of `billing.credit.list` (feature 25).

## 2. Where everything lives

```
apps/billing/src/
  domain/
    buyer-credit.ts                    BuyerCredit aggregate root (§3.1): evaluateHold / approveHold / refuseHold / releaseHold / consumeHold, B1-B5
    credit-ledger-entry.ts             CreditLedgerEntry child entity + CreditEntryType (§3.2)
    credit-exposure.ts                 PURE arithmetic: summariseLedger(entries) -> LedgerSummary (§3.3) — the one place BC5/BC6 live
    buyer-credit-snapshot.ts           the plain snapshot shape the mapper reconstitutes from (mirrors stock-item-snapshot.ts)
    credit-events.ts                   creditApprovedEvent / creditRejectedEvent / creditReleasedEvent builders (§3.4)
    credit-errors.ts                   DomainError subclasses with stable codes (§3.5)
    index.ts                           barrel
    *.spec.ts                          pure unit tests — no framework, no DB, no clock
  application/
    ports/
      clock.port.ts                    CLOCK + Clock                                        (verbatim copy of Orders')
      unit-of-work.port.ts             UNIT_OF_WORK + TransactionContext + UnitOfWork        (verbatim copy of Orders')
      consumer-name.ts                 CONSUMER_NAMES = [] as const — Billing consumes no fact (§8)
      fact-publisher.port.ts           FACT_PUBLISHER + PublishableFact + FactPublisher      (verbatim copy of Orders')
      buyer-credit-repository.port.ts  BUYER_CREDIT_REPOSITORY: lockForOrder / save (§5.2)
      credit-read.port.ts              CREDIT_READ: list — the non-locking read for the QueryBus (§5.2)
      credit-decision.port.ts          CREDIT_DECISION — feature 20's seam (§6)
    queries/
      credit.queries.ts                ListCreditQuery
      credit.query-handlers.ts         one @QueryHandler class (explicit @Inject)
      credit.query-handlers.spec.ts
    commands/
      credit.commands.ts               HoldCreditCommand (carries correlationId / requestId)
      credit.command-handlers.ts       one @CommandHandler class (explicit @Inject)
      credit.command-handlers.spec.ts
    credit-hold.handler.ts             the hold transactional unit as a plain class the @CommandHandler delegates to (§5.3)
    credit-hold.handler.spec.ts
    credit-application-errors.ts       CreditLineNotFoundError, CreditCurrencyMismatchError (§5.4)
  infrastructure/
    credit/
      always-approve-credit-decision.ts   the adapter bound today; feature 20 replaces the PROVIDER, not this file's callers (§6.3)
      always-approve-credit-decision.spec.ts
    persistence/
      drizzle-unit-of-work.ts          copy of Orders'/Fulfillment's, BillingDb/BillingTx; asDrizzleTx is the ONE unwrap
      buyer-credit.repository.ts       DrizzleBuyerCreditRepository: FOR UPDATE on the credits row, ledger reads, save = insert entries + outbox drain (§7)
      buyer-credit.mapper.ts           rows <-> BuyerCredit (snapshot in, snapshot out)
      credit-read.repository.ts        DrizzleCreditReadRepository: paged list + one grouped ledger query, no locks (§7.2)
      buyer-credit.repository.integration.spec.ts
      credit-read.repository.integration.spec.ts
      client.ts                        + `export type WriteModelDb = BillingDb;`  (§9.2)
      schema/                          UNCHANGED — credits, credit_items, invoices, invoice_items, payments, outbox, processed_events (phase 6 + feature 14)
    outbox/
      outbox-recorder.ts               copy of Orders' (§9.1)
      outbox-envelope-mapper.ts        copy of Orders'
      outbox-relay.ts                  copy of Orders' — byte-identical after §9.2
      outbox-relay.service.ts          copy of Orders'
      outbox-relay.config.ts           copy of Orders'
      kafka-fact-publisher.ts          copy of Orders' — byte-identical after §9.2
      kafka.config.ts                  BILLING_FACTS_TOPIC + FACTS_TOPIC alias + loadKafkaConfig (clientId default `otc-billing`) — deliberately NOT guarded (§9.3)
      kafka.config.spec.ts             read-the-spec-as-text guard for the topic
      create-kafka-client.ts           copy of Orders'
      outbox-relay.spec.ts             OI6 no-overlap (copy of Orders' unit test)
      outbox-relay.integration.spec.ts BC16 — MySQL + Kafka
      test-support/kafka-test-fixture.ts  copy of Orders'
    messaging/
      idempotent-consumer.ts           VERBATIM copy of the canonical, banner per OI12 (§8)
      processed-events.repository.ts   VERBATIM copy of the canonical, banner per OI12
      nats.config.ts                   loadNatsConfig (copy of Orders')
      bare-json-nats.serializer.ts     copy of Fulfillment's (§4.3)
      bare-json-nats.deserializer.ts   copy of Fulfillment's (§4.3)
      bare-json-nats.spec.ts           unit: both directions, RpcError on `err`
      test-support/nats-test-fixture.ts   copy of Orders'
    system-clock.ts                    copy of Orders'
  presentation/
    credit.controller.ts               two @MessagePattern(…, Transport.NATS) responders (§4.1)
    credit.controller.spec.ts
    dto/credit.dto.ts                  class-validator DTOs implementing the two @otc/contracts request payloads (§4.2)
    rpc-error-mapper.ts                Billing's own mapping (domain + application errors -> RpcError) (§4.4)
    rpc-error-mapper.spec.ts
    app.controller.ts                  existing health payload, unchanged
  app.module.ts                        CqrsModule.forRoot(), class-provider handlers with explicit @Inject, useFactory for everything else
  main.ts                              hybrid: HTTP + ONE NATS microservice with the bare-JSON (de)serializers; NO Kafka consumer transport (§8)
  credit-hold.integration.spec.ts      BC1, BC3, BC4, BC7, BC8, BC10 + R38/R39 integration halves
  credit-hold-race.integration.spec.ts BC9
  credit-list.integration.spec.ts      BC6 integration half
  credit-wire.integration.spec.ts      BC2
  test-support/credit-integration-harness.ts   boots the real AppModule graph against Testcontainers MySQL + NATS + Kafka

apps/orders/src/                       §9 — bounded to the relay family
  infrastructure/persistence/client.ts             + `export type WriteModelDb = OrdersDb;`
  infrastructure/outbox/outbox-relay.ts            OrdersDb -> WriteModelDb (1 import + 2 references)
  infrastructure/outbox/kafka.config.ts            + `export const FACTS_TOPIC = ORDERS_FACTS_TOPIC;`
  infrastructure/outbox/kafka-fact-publisher.ts    ORDERS_FACTS_TOPIC -> FACTS_TOPIC (1 import + 1 default)
  infrastructure/outbox/outbox-relay.parity.spec.ts   NEW — OB1 (§9.4)

apps/fulfillment/src/                  §9 — bounded to the relay family
  infrastructure/persistence/client.ts             + `export type WriteModelDb = FulfillmentDb;`
  infrastructure/outbox/kafka.config.ts            + `export const FACTS_TOPIC = FULFILLMENT_FACTS_TOPIC;`
  infrastructure/outbox/{outbox-relay,kafka-fact-publisher}.ts   re-synced to the canonical

apps/seed/src/                         §10 — bounded to two findings
  outbox-parity.spec.ts                            N1 — strip SQL comments before matching and comparing
  verify.ts                                        N3 — lower-bound assertions for saga-grown tables
  verify.spec.ts                                   NEW — BC19
```

**No migration.** Every table this feature writes exists since phase 6 (`credits`, `credit_items`) and feature 14 (`outbox`, `processed_events`). `apps/billing/drizzle/` is untouched — deliberately: `BC5` forbids a materialised available-credit column, so there is nothing to add. `OI11` therefore has nothing new to compare, and a task asserts it still passes after the `N1` fix.

**Layering.** `domain/` imports only `@otc/shared-kernel` and `import type` from `@otc/contracts`. Ports live in `application/`; every adapter in `infrastructure/`; the only NestJS-decorated classes are the controller, the two cqrs handlers and `OutboxRelayService` — all with explicit `@Inject(TOKEN)` on every constructor parameter. Plain classes (repositories, the relay, `CreditHoldHandler`, the decision adapter) are wired with `useFactory` + `inject: [...]`, exactly as `apps/orders` and `apps/fulfillment` do.

## 3. The domain

### 3.1 `BuyerCredit` — the aggregate root

```ts
// apps/billing/src/domain/buyer-credit.ts
export interface CreditContext {                    // time + causation in, nothing pulled — same shape as Fulfillment's StockContext
  readonly occurredAt: Date;
  readonly causationId: UniqueId;
}

export interface HoldRequest {
  readonly orderReference: OrderNumber;
  readonly amount: Money;                            // the order total — integer minor units + currency
  readonly correlationId: UniqueId;                  // the order id, from x-correlation-id
}

export type HoldEvaluation =
  | { readonly kind: 'already_held'; readonly heldAmount: Money }        // BC7 — a `hold` entry exists for this order, whatever its net
  | { readonly kind: 'currency_mismatch'; readonly expected: CurrencyCode }
  | { readonly kind: 'fits' }
  | { readonly kind: 'over_limit'; readonly availableCredit: Money };

export class BuyerCredit extends AggregateRoot<BuyerCredit> {
  static reconstitute(snapshot: BuyerCreditSnapshot): BuyerCredit;       // validates B1/B3 on the way in (InvalidBuyerCreditSnapshotError)
  get code(): CreditLineReference; get retailerCode(): string; get companyCode(): string;
  get creditLimit(): Money;
  /** creditLimit − committedExposure (BC5). Never negative while B1 holds; `reconstitute` refuses a snapshot where it would be. */
  get availableCredit(): Money;
  /** The BC6 split for the orders this instance was loaded with. */
  get summary(): LedgerSummary;

  /** PURE, no mutation, no event, no port. The single decision function; the application layer consults the credit-decision port ONLY on `fits` (§6.1). */
  evaluateHold(request: HoldRequest): HoldEvaluation;

  /** Appends ONE `hold` entry and exactly one credit.approved.v1 whose `availableCreditAfter` is recomputed WITH the new entry (BC10). Throws CreditLimitExceededError unless `evaluateHold` would answer `fits` — a caller cannot bypass B1 by skipping the evaluation. */
  approveHold(request: HoldRequest, ctx: CreditContext, newId: () => UniqueId): CreditLedgerEntry;

  /** Appends NO entry and exactly one credit.rejected.v1 carrying `reason` (R39, B1). Throws CreditRefusalMismatchError if `reason` is `over_limit` while the amount actually fits — a refusal must not lie about why. */
  refuseHold(request: HoldRequest, reason: CreditRejectionReason, ctx: CreditContext): void;

  /** Appends ONE `release` entry for the order's outstanding exposure and exactly one credit.released.v1 with `reason`. Returns null — no entry, no fact — when the order has no outstanding exposure (BC11, B5). Throws CreditReleaseUnderflowError if an explicit amount would drive exposure below zero. */
  releaseHold(input: { orderReference: OrderNumber; reason: CreditReleaseReason; correlationId: UniqueId }, ctx: CreditContext, newId: () => UniqueId): CreditLedgerEntry | null;

  /** Appends ONE `consume` entry of the order's active hold. Emits NOTHING — invoice.issued.v1 is feature 21's Invoice fact (R40, BC12). Throws NoActiveHoldError when the order holds nothing. */
  consumeHold(input: { orderReference: OrderNumber }, ctx: CreditContext, newId: () => UniqueId): CreditLedgerEntry;

  /** The entries appended during this instance's lifetime — what the repository inserts. The loaded ones are never re-written (B2: append-only). */
  get appendedEntries(): readonly CreditLedgerEntry[];
  toSnapshot(): BuyerCreditSnapshot;
}
```

**Invariant B1 lives here, not in the schema — and that was decided in phase 6.** `apps/billing/src/infrastructure/persistence/schema/credits.schema.ts`'s header already records why there is deliberately no `CHECK`: `B1` is a derived quantity over the whole ledger, not a value the `credits` row carries, and it must produce a `credit.rejected.v1` **fact** rather than a raw driver error. This feature honours that: `approveHold` throws unless the amount fits, `reconstitute` refuses a snapshot whose `committedExposure` already exceeds `creditLimit`, and nothing in infrastructure writes a ledger row except through `appendedEntries` of an aggregate that has already enforced it.

**Invariant B2 (append-only) is enforced by shape, not by a rule.** `CreditLedgerEntry` exposes no setter and no mutating method; `BuyerCredit` exposes no way to reach a loaded entry; the repository's `save` only ever `INSERT`s `appendedEntries` and never `UPDATE`s or `DELETE`s `credit_items`. The domain unit test for `R37` asserts the negative directly: every attempt to reach into the loaded ledger is a compile-time impossibility, and the runtime attempt the test *can* make — asking the aggregate to reverse an entry — appends a new `release` instead.

**What the aggregate holds, honestly.** Like `StockItem` and its `reservedUnits`, `BuyerCredit` **preserves** `B1` rather than recomputing it from everything it can see. It is reconstituted with (a) the `credits` row, (b) `committedExposure` — one scalar, the `BC5` two-term sum over the *whole* line, computed in SQL — and (c) the complete entry list of the **one order** the command names, which is all `B4`/`B5`/`BC7` need. It never loads the whole ledger; a hot credit line's history would otherwise grow the aggregate's memory footprint without any invariant benefiting. The consequence is stated plainly and is checked where a drift would actually be visible: an integration test recomputes `availableCredit` from every row of `credit_items` after each committed operation and compares it with the fact's `availableCreditAfter`.

### 3.2 `CreditLedgerEntry` — the child entity

```ts
// apps/billing/src/domain/credit-ledger-entry.ts
export const CREDIT_ENTRY_TYPES = ['hold', 'consume', 'release'] as const;
export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];

export class CreditLedgerEntry extends Entity<CreditLedgerEntry> {
  static create(input: { id: UniqueId; orderReference: OrderNumber; amount: Money; type: CreditEntryType; entryDate: Date }): CreditLedgerEntry;
  static reconstitute(snapshot: CreditLedgerEntrySnapshot): CreditLedgerEntry;
  get orderReference(): OrderNumber; get amount(): Money; get type(): CreditEntryType; get entryDate(): Date;
  // No mutator of any kind — B2.
}
```

`create` rejects a non-positive amount and a currency other than the line's (**B3**, checked by the aggregate, which is the only construction site).

### 3.3 `credit-exposure.ts` — the crux, one pure function

This is the file the whole feature turns on, and it is deliberately the smallest one.

```ts
// apps/billing/src/domain/credit-exposure.ts
export interface OrderExposure {
  readonly orderReference: string;
  readonly exposure: number;       // Σ hold − Σ release, in minor units — what the order still ties up
  readonly openExposure: number;   // min(Σ consume, exposure) — the invoiced portion
  readonly activeHold: number;     // exposure − openExposure — the not-yet-invoiced portion
  readonly hasHoldEntry: boolean;  // BC7's idempotency predicate: a `hold` was recorded, whatever happened since
}
export interface LedgerSummary {
  readonly byOrder: readonly OrderExposure[];
  readonly committedExposure: number;   // Σ exposure over every order = Σ hold − Σ release over the whole line
  readonly activeHolds: number;
  readonly openExposure: number;
}
/** PURE. The only place BC5 and BC6 are computed, in this service and in the read model alike. */
export function summariseLedger(entries: readonly CreditLedgerEntrySnapshot[]): LedgerSummary;
```

**Why this formula and not `domain-model.md` §5.1's literal one.** The shared model writes `activeHold = Σhold − Σconsume − Σrelease applied to holds` and `openExposure = Σconsume − Σrelease applied to exposures`. The qualifier *"applied to holds"* is not computable: a `release` row carries a type, an amount and an order reference, and nothing that says which of the two quantities it unwinds. Worse, the naive un-qualified reading breaks **B5**: for an order cancelled before invoicing (`h`, then `r = h`, `c = 0`) it yields `openExposure = c − r = −h`, a negative exposure the model explicitly forbids. The two-term identity below is exact, needs no qualifier, and is what this assessment implements:

```
exposure(order)      = Σ hold(order) − Σ release(order)             -- B5 keeps this ≥ 0
openExposure(order)  = min( Σ consume(order), exposure(order) )     -- the invoiced part of what is still tied up
activeHold(order)    = exposure(order) − openExposure(order)
committedExposure    = Σ_orders exposure(order) = Σ_line hold − Σ_line release
availableCredit      = creditLimit − committedExposure
```

Three consequences worth naming, because each is a requirement elsewhere:

1. **`consume` is numerically neutral by construction.** It appears in neither term of `availableCredit`. `R40` is therefore not a rule the code applies — it is a property of the formula, and it cannot be broken by a future change to the consume path without changing this function. `BC5`'s domain unit test asserts exactly that.
2. **`availableCredit` needs no grouping at all.** It is a single scalar aggregate over `credit_items WHERE credit_id = ?` — no `GROUP BY`, no rows materialised, an index-range scan on `idx_credit_items_credit_order`. That is what makes the hold transaction (§5.5) cheap enough to run under an exclusive row lock.
3. **Only the *view* needs the per-order split**, and the view is a non-locking read outside any transaction (§7.2). The write path never pays for it.

**Cost, stated rather than hidden.** `committedExposure` is `O(entries on the line)`, so it grows with a retailer's history — three rows per completed order. At demo and assessment volumes this is a few thousand rows behind a covering index inside a millisecond-scale transaction, and it buys the property that the append-only ledger is the *single* source of truth with nothing to drift against. The alternatives — a materialised `available_credit` column on `credits`, or periodic compaction entries — are recorded as rejected, with the reason, in §12.

### 3.4 The three fact builders

`credit-events.ts` mirrors `apps/fulfillment/src/domain/stock-events.ts` exactly: `createDomainEvent` from `@otc/shared-kernel`, payload types `CreditApprovedPayload` / `CreditRejectedPayload` / `CreditReleasedPayload` from `@otc/contracts` (`import type`), the same `Indexed<TPayload>` intersection trick, `correlationId = request.correlationId` (the order id), `aggregateId = this.id` (the credit line — domain-model.md §7.2 facts 5/6/7 name `BuyerCredit` as the producing aggregate), `causationId` / `occurredAt` from `CreditContext`. `creditCode` is included in all three payloads (optional in `CreditRejectedPayload`'s `required` list, always known here because the line was resolved before any refusal could be decided).

**`credit.rejected.v1` has exactly one builder and exactly one call site** — `refuseHold`. There is no separate branch for an adapter refusal anywhere in the domain, the application layer, the outbox record or the RPC reply. That is `BC14` / `R44`, achieved structurally: a genuine `over_limit` fact and a `simulated_cents_rule` fact are produced by the same lines of code and differ in the one string that was passed in.

### 3.5 Domain errors

All extend `DomainError` with a stable `code`: `CreditLimitExceededError` (`CREDIT_LIMIT_EXCEEDED`, carries `requested`, `available`), `CreditRefusalMismatchError` (`CREDIT_REFUSAL_MISMATCH`), `CreditReleaseUnderflowError` (`CREDIT_RELEASE_UNDERFLOW`), `NoActiveHoldError` (`NO_ACTIVE_HOLD`), `InvalidBuyerCreditSnapshotError` (`INVALID_BUYER_CREDIT_SNAPSHOT`), `FactAggregateMismatchError` (`FACT_AGGREGATE_MISMATCH`). §4.4 is where these codes become wire codes.

### 3.6 Invariants → where they are enforced

| Invariant | Enforced by | Proven by |
|---|---|---|
| **B1** `Σ holds + Σ exposure ≤ creditLimit` | `evaluateHold` (decides), `approveHold` (throws), `reconstitute` (refuses) | `R37` domain unit, `BC9` integration |
| **B2** append-only | no mutator on `CreditLedgerEntry`; `save` only `INSERT`s `appendedEntries` | `R37` domain unit, `BC10` integration |
| **B3** one currency per line | `approveHold`/`releaseHold`/`consumeHold` construct entries in the line's currency only; `evaluateHold` answers `currency_mismatch` first | `BC4` |
| **B4** at most one active hold per order | `evaluateHold` answers `already_held` on any recorded `hold` entry | `BC7` unit + integration |
| **B5** release never goes below zero | `releaseHold` releases exactly `exposure(order)` and returns `null` when it is zero | `BC11` domain unit |

## 4. Presentation — the two responders

### 4.1 The controller

```ts
@Controller()
export class CreditController {
  constructor(@Inject(QueryBus) private readonly queries: QueryBus, @Inject(CommandBus) private readonly commands: CommandBus) {}

  @MessagePattern('billing.credit.hold', Transport.NATS) hold(@Payload() p: unknown, @Ctx() ctx: NatsContext): Promise<CreditHoldReplyPayload | RpcError>;
  @MessagePattern('billing.credit.list', Transport.NATS) list(@Payload() p: unknown): Promise<CreditListReplyPayload | RpcError>;
}
```

Every pattern names `Transport.NATS` (CLAUDE.md non-negotiable + ESLint guard). Subjects are constants in the controller module, guarded by a read-the-spec-as-text unit test asserting each equals its AsyncAPI channel `address`. **The controller never throws**: validate → dispatch → `try/catch` → `toRpcError`. Headers come from `ctx.getHeaders()`: on `hold`, `x-correlation-id` and `x-request-id` are parsed with `UniqueId.from` and an absent/invalid value is a `validationRpcError` **before** any dispatch (`BC1`); `list` reads neither.

### 4.2 DTOs

`dto/credit.dto.ts` — two `class-validator` classes each `implements` its generated `@otc/contracts` request payload: `CreditHoldRequestDto` (`orderReference` matching `/^ORD-\d{6}$/`, `retailerCode`, `companyCode`, `amount` a nested `{ minorUnits: int, currency: /^[A-Z]{3}$/ }` `Money` object — it travels alone on this subject, per the AsyncAPI field description), `CreditListRequestDto` (optional `retailerCode`/`companyCode`, `page ≥ 1` default 1, `pageSize 1..200` default 25). Validated manually with `validate(dto, { whitelist: true })` inside the controller so a failure is an `RpcError` under this feature's control.

### 4.3 The wire: bare JSON in, bare JSON out

`fulfillment_stock/design.md` §6.3 established, live, that `@nestjs/microservices`' NATS server treats an id-less bare-JSON request as an **event** (runs the handler, never replies) and serialises replies as a Nest packet. Billing's callers are the same raw `nats` clients — Orders' `nats-saga-commands.adapter.ts` (for `credit.hold`) and, later, the Gateway. Billing therefore installs the **same pair**, copied from `apps/fulfillment/src/infrastructure/messaging/` with a `// COPY OF —` banner: `BareJsonNatsDeserializer` (an id-less packet with a `replyTo` gains a synthetic id and becomes a request; without a `replyTo` it stays an event) and `BareJsonNatsSerializer` (encodes `packet.response` alone; `packet.err` becomes a bare `RpcError` `INTERNAL_ERROR`).

These two files are **not** in the `OB1` parity set (§9.4) — they belong to the messaging family, not the outbox family — but they are byte-identical copies with a banner, so extending a guard to them later is free. Recorded as an open point rather than done here, to keep this feature's structural work to the one refactor it was assigned.

### 4.4 `rpc-error-mapper.ts` — Billing's own

A pure function, same shape as Fulfillment's but a **different file with different cases** (error vocabularies differ by service): `ValidationError[]` → `VALIDATION_FAILED`; `CreditLineNotFoundError` → `NOT_FOUND` with `details.retailerCode`/`details.companyCode` (`BC3`); `CreditCurrencyMismatchError` → `VALIDATION_FAILED` with `details.expected`/`details.received` (`BC4`); `CreditReleaseUnderflowError` / `NoActiveHoldError` → `PRECONDITION_FAILED` with `details.code`; any other `DomainError` → `DOMAIN_ERROR` with `details.code`; anything else → `INTERNAL_ERROR`. `occurredAt` via `new Date()` at the edge, as both existing mappers do.

**A business rejection is never an `RpcError`.** An over-limit or adapter-refused hold resolves with `outcome: 'rejected'` and a `reason` — saga.md §7: *"Responder returns a business rejection … This is not a failure — it is a domain outcome."* Only the two contract violations of `BC3`/`BC4` and a malformed request produce an error reply.

## 5. The application layer — `@nestjs/cqrs`, binding

### 5.1 Buses and handlers

| Subject | Bus | Message class | Handler | Transactional? |
|---|---|---|---|---|
| `billing.credit.list` | `QueryBus` | `ListCreditQuery { retailerCode?, companyCode?, page, pageSize }` | `ListCreditHandler` → `CreditReadPort.list` | no — three plain SELECTs |
| `billing.credit.hold` | `CommandBus` | `HoldCreditCommand { request, correlationId, requestId }` | `HoldCreditHandler` → `CreditHoldHandler.hold` | yes — §5.5 |

The `@QueryHandler`/`@CommandHandler` classes are thin: no logic beyond delegation, every dependency through `@Inject(TOKEN)`, registered as class providers. `CreditHoldHandler` is a plain class (`useFactory`-wired) so its spec can `new` it with fakes — the same split `StockReservationHandler` and `SagaFactHandler` use. **No `EventBus`, no `@Saga`**: the orchestrator lives in Orders; Billing's post-commit obligation is the relay's. The `CommandBus` hop is synchronous and awaited by the controller, so "reply after commit" is structural.

### 5.2 Ports

```ts
// buyer-credit-repository.port.ts
export const BUYER_CREDIT_REPOSITORY = Symbol('BuyerCreditRepository');
export interface BuyerCreditRepository {
  /** §5.5 steps 1-3: FOR UPDATE on the `credits` row of (retailerCode, companyCode); then, under that lock, the scalar committedExposure and the complete entry list of `orderReference`. Resolves to null when no credit line exists (BC3) — the caller turns that into CreditLineNotFoundError, and no transaction has written anything. */
  lockForOrder(tx: TransactionContext, retailerCode: string, companyCode: string, orderReference: OrderNumber): Promise<BuyerCredit | null>;
  /** INSERTs `credit.appendedEntries` (never an UPDATE, never a DELETE — B2), then drains `credit.pullDomainEvents()` into the outbox, all inside `tx` (R13). `tx` required — never opens its own. */
  save(credit: BuyerCredit, tx: TransactionContext): Promise<void>;
}

// credit-read.port.ts — the QueryBus side; never locks, never mutates
export const CREDIT_READ = Symbol('CreditRead');
export interface CreditReadPort {
  list(query: CreditListRequestPayload): Promise<CreditListReplyPayload>;
}
```

`CLOCK`, `UNIT_OF_WORK`, `FACT_PUBLISHER` and `consumer-name.ts` are verbatim copies of the Orders files at the identical relative paths — the `OI12` whitelist requires those paths to exist in every service carrying the consumer pattern (§8).

### 5.3 The credit-decision port is separate on purpose

It is *not* a method on the repository and *not* a parameter of the aggregate — see §6.

### 5.4 Application errors

`CreditLineNotFoundError` (`BC3`) and `CreditCurrencyMismatchError` (`BC4`) live in `application/`, not `domain/`: neither is a statement about a credit line's state, both are contract violations of the incoming command, and the domain layer has no vocabulary for "the pair you named does not exist". This mirrors `apps/fulfillment/src/application/despatch-application-errors.ts`.

### 5.5 The hold transactional unit, and the lock protocol

```ts
// apps/billing/src/application/credit-hold.handler.ts  (plain class)
export class CreditHoldHandler {
  constructor(unitOfWork: UnitOfWork, credits: BuyerCreditRepository, decision: CreditDecisionPort, clock: Clock) {}
  hold(cmd: HoldCreditCommand): Promise<CreditHoldReplyPayload>;
}
```

Inside one `UnitOfWork.execute`, in this order, nothing else:

```sql
-- 1. claim the credit line — the ONE row this transaction ever locks
SELECT * FROM credits
 WHERE retailer_code = :retailer AND company_code = :company
 FOR UPDATE;                                   -- uq_credits_retailer_company
-- no row -> ROLLBACK, CreditLineNotFoundError -> RpcError NOT_FOUND (BC3). Nothing written, no fact.

-- 2. the whole line's committed exposure — ONE scalar, no GROUP BY (BC5)
SELECT COALESCE(SUM(CASE type WHEN 'hold' THEN amount WHEN 'release' THEN -amount ELSE 0 END), 0)
  FROM credit_items WHERE credit_id = :id FOR UPDATE;

-- 3. the subject order's entries — index seek on idx_credit_items_credit_order, at most a handful of rows (B4/B5/BC7)
SELECT * FROM credit_items WHERE credit_id = :id AND order_reference = :ref FOR UPDATE;

-- 4. domain: evaluateHold(request) -> already_held | currency_mismatch | over_limit | fits
--    `fits` ONLY: consult the credit-decision port (§6.1)
--    approve -> approveHold(...)   | refuse -> refuseHold(..., reason)   | over_limit -> refuseHold(..., 'over_limit')

-- 5. approved: INSERT credit_items (one `hold` row) + INSERT outbox (credit.approved.v1)
--    rejected: INSERT nothing into credit_items      + INSERT outbox (credit.rejected.v1)
--    already_held / currency_mismatch: nothing written at all
-- COMMIT
```

- **Why one row lock is enough, and why no deadlock is possible.** A credit line is a single aggregate in a single row, so `stock.reserve`'s multi-row lock-ordering problem does not arise: a hold transaction locks exactly one `credits` row and holds it for the whole unit of work. Two transactions can only ever contend on the *same* row, and a lock-ordering cycle needs at least two rows. This is a genuinely stronger position than Fulfillment's, and `design.md` §4.2's tension with `domain-model.md` §8 rule 6 (*"one transaction mutates exactly one aggregate instance plus its outbox records"*) simply does not exist here — Billing satisfies rule 6 literally.
- **Why steps 2 and 3 are locking reads.** Under `REPEATABLE READ`, a plain `SELECT` after the `FOR UPDATE` would depend on when InnoDB establishes the transaction's consistent-read view — a correct-but-subtle argument. `FOR UPDATE` makes both current reads and removes the isolation-level reasoning entirely, exactly as `fulfillment_stock/design.md` §4.3 did for the reservations read. Nothing is tuned per connection; MySQL's default `REPEATABLE READ` is kept.
- **Why the transaction is short.** Three statements, one pure evaluation, one synchronous port call (the bound adapter is pure — §6.3 forbids I/O inside the lock) and at most two inserts. No NATS, no Kafka, no clock read beyond `clock.now()` once. The reply is built from the domain outcome **before** commit but returned **after** `execute` resolves, so a rollback can never produce a success reply.
- **`ctx = { occurredAt: clock.now(), causationId: cmd.requestId }`** (`BC1`, `R12`).

### 5.6 Responder idempotency — the keys, stated once

| Command | Idempotency key (saga.md §2) | What a repeat observes | Reply | Fact |
|---|---|---|---|---|
| `credit.hold` | `orderReference` | any `hold` entry for the order on this line, whatever its net | `already_held` + the recorded `heldAmount` + current `availableCredit` | none |
| `credit.hold` | `orderReference` | a previously **rejected** hold — nothing was recorded (**B1**) | re-evaluated from scratch (`BC8`) | possibly a second `credit.rejected.v1` |
| `credit.list` | — (read) | — | — | none |

**`heldAmount` on an `already_held` reply is the amount of the recorded `hold` entry, not the currently outstanding exposure** — the reply's job is *"I already handled this order's hold, and here is what I recorded"*. `availableCredit` is always current. This matters for the one case where they differ: an order whose hold was released by a cancellation and whose `credit.hold` is then re-issued by a sweeper. `BC7` refuses to re-acquire, exactly as `FS5` refuses to re-reserve released stock.

**`BC8`'s second rejection fact is safe, and it is safe by machinery that already exists.** A rejection records nothing, so a re-issued rejected hold is re-evaluated and emits a *new* `credit.rejected.v1` with a distinct `eventId`. saga.md §6's redelivery table covers precisely this row (*"`credit.rejected.v1` | `stock_reserved` (compensation in flight) or `cancelled`"*), and the failure mode a distinct-`eventId` duplicate used to cause — the consumer crash-looping on `uq_saga_commands_order_command` — was fixed as `FS1` in feature 17. The alternative, a fourth `credit_items` type recording refusals, is rejected: it would contradict **B1**'s *"a hold that would break it is **not recorded**"*, change the shared schema, and make `Σ` arithmetic type-dependent.

## 6. The credit-decision port — feature 20's seam, fixed now

### 6.1 The contract

```ts
// apps/billing/src/application/ports/credit-decision.port.ts
export const CREDIT_DECISION = Symbol('CreditDecision');

/** Everything an adapter may see. It is told the amount and the credit line's state; it is NOT given the aggregate, the repository, the transaction or the clock. */
export interface CreditDecisionRequest {
  readonly orderReference: string;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly creditCode: string;
  readonly amountMinorUnits: number;      // the order total — integer minor units
  readonly currency: string;
  readonly availableCreditMinorUnits: number;   // BEFORE the hold, AFTER the aggregate found it fits
}

/** `over_limit` is deliberately excluded: it is the aggregate's word, and only the aggregate may say it (BC14). */
export type AdapterRejectionReason = Exclude<CreditRejectionReason, 'over_limit'>;

export type CreditDecision =
  | { readonly kind: 'approve' }
  | { readonly kind: 'refuse'; readonly reason: AdapterRejectionReason };

export interface CreditDecisionPort {
  /** Called ONCE per hold, and ONLY when the aggregate has already answered `fits` (BC13). Synchronous or not; must not perform I/O — it runs inside the credit line's row lock. */
  decide(request: CreditDecisionRequest): CreditDecision | Promise<CreditDecision>;
}
```

### 6.2 Why the ordering is the guarantee

`R44` requires that the simulator cannot bypass `R37` — that a genuine over-limit rejection stays reachable with the simulator bound. Three ways to guarantee it were considered:

| Approach | Why not / why yes |
|---|---|
| Trust the adapter not to approve over-limit holds | A guarantee by discipline, which is what `R44` exists to rule out |
| Give the adapter the aggregate and let it call `approveHold` | `approveHold` throws on over-limit, so the invariant survives — but the adapter would then own domain vocabulary and the failure would be an exception rather than a decision |
| **Evaluate `B1` first; consult the port only on `fits`; forbid the port from returning `over_limit`** | **Chosen.** An adapter is structurally incapable of approving an over-limit hold, because it is never asked about one. It can only ever narrow approvals, never widen them. The type system carries half the guarantee (`AdapterRejectionReason`) and the call ordering carries the other half |

`BC13`'s unit test is the direct probe: a fake port that records every call, driven with an over-limit request, must record **zero** calls and still yield a `credit.rejected.v1` with `reason: 'over_limit'`.

### 6.3 What is bound today, and what feature 20 changes

`infrastructure/credit/always-approve-credit-decision.ts` — a pure, dependency-free class returning `{ kind: 'approve' }`. It is bound in `app.module.ts` as

```ts
{ provide: CREDIT_DECISION, useFactory: () => new AlwaysApproveCreditDecision() },
```

**Feature 20's entire footprint is that one provider.** It adds `infrastructure/credit/simulator-credit-decision.ts` (the `.99` rule, `CREDIT_FAILURE_RATE`, the start-up validation of `R43`) and changes the `useFactory` to build it. No domain file, no application file, no presentation file, no port, no DTO, no fact builder, no test of this feature changes. `BC15`'s test asserts the smaller half of that claim (the adapter approves everything); the design records the larger half so feature 20's reviewer can check it as a diff.

### 6.4 Indistinguishability, concretely

`R44` asks that a simulated and a genuine rejection be indistinguishable downstream except by `reason`. In this design that is not a property to test for at three levels — it is a property of there being **one** `refuseHold`, **one** `creditRejectedEvent` builder, **one** outbox record shape and **one** `rejected` reply branch. The named test (`BC14`, `apps/billing/src/domain/credit-hold.spec.ts`) builds both facts from the same fixture and asserts the two envelopes are equal field-for-field after normalising `eventId`, `occurredAt` and `reason` — a positive assertion of sameness, not a checklist of differences. Feature 20 then flips `R44`'s own integration row end to end.

## 7. Persistence — the Drizzle adapters

### 7.1 `DrizzleBuyerCreditRepository` (write side)

Plain class; `BillingDb` + `Clock`; `OutboxRecorder` defaulted the way `DrizzleOrderRepository` and `DrizzleStockItemRepository` default it.

- `lockForOrder`: `db.select().from(credits).where(and(eq(retailerCode), eq(companyCode))).for('update')` — Drizzle's `.for('update')` without `skipLocked` (a contender must **wait**, not skip). `null` when the row is absent. Then the `BC5` scalar (`sql<number>` over `credit_items`, `.for('update')`) and the subject order's entries (`.for('update')`). Reconstitutes one `BuyerCredit`.
- `save`: `insert(creditItems).values(rows)` for `credit.appendedEntries` **only** — no `onDuplicateKeyUpdate`, no `update`, no `delete` anywhere in this file, which is `B2` made mechanical; then `outboxRecorder.record(tx, credit.pullDomainEvents())`. The repository drains, never the handler (feature 14 §4.4; `OI9`'s drained-events hazard applies unchanged — a failed unit of work invalidates the instance, and a retry re-locks and re-derives). The `credits` row itself is **never** written: nothing in this feature changes a credit limit.
- `buyer-credit.mapper.ts`: `rowToSnapshot` / `snapshotToRow`, amounts as integer minor units, dates as UTC `Date`s (the pool is created with `timezone: 'Z'`).

### 7.2 `DrizzleCreditReadRepository` (`CreditReadPort`)

Three queries, no transaction, no lock:

1. the page of `credits` — optional `retailerCode`/`companyCode` filters, `ORDER BY retailer_code, company_code`, `LIMIT/OFFSET`;
2. `COUNT(*)` over the same filter, for `PageInfo.total`;
3. one grouped read of `credit_items` restricted to the page's `credit_id IN (…)`, `GROUP BY credit_id, order_reference`, returning `Σhold`, `Σconsume`, `Σrelease` per order.

The three amounts of each `CreditView` are then folded in TypeScript by the **same** `summariseLedger` the aggregate uses — one implementation of `BC5`/`BC6`, two callers. `availableCredit` is `creditLimit − committedExposure` and is never read from a column, because there is no column. `BC6`'s integration test asserts the reconciliation identity on live rows.

## 8. Consumers — none in this feature; the pattern copy is scaffolded anyway

Per saga.md §5, Billing consumes **no** fact: `credit.hold`, `invoice.issue` and `payment.register` are all command-driven, and Billing's own facts are produced, never consumed, by it. `main.ts` therefore connects **one** microservice transport (NATS) plus HTTP — no Kafka consumer, no `@EventPattern`. The relay's kafkajs producer is the only Kafka client.

The idempotent-consumer pair **is still copied**, verbatim with the `OI12` banner, for the same three reasons feature 17 gave: it makes `OI12` case 1 compare three copies instead of two; the `processed_events` table and the three whitelisted port paths already exist; and feature 22's remittance intake — which does need dedup by `paymentReference`, a different key but the same pattern's neighbourhood — starts from a guarded copy. `consumer-name.ts` declares `CONSUMER_NAMES = [] as const`, so `ConsumerName` is `never` and `runOnce` is uncallable until the shared § Vocabulary grows.

## 9. The outbox relay: the third copy, and the refactor it triggers

`fulfillment_stock/design.md` §8.3 deferred two things to "the feature that creates the third copy", with the reason stated mechanically rather than as a preference: `OI12`'s instrument is banner-stripped byte identity, and the canonical `outbox-relay.ts` names `OrdersDb` — a service-specific type — so a byte-identical copy is impossible *without first editing the canonical*. This feature creates the third copy and therefore owns both.

### 9.1 What Billing copies

`outbox-recorder.ts`, `outbox-envelope-mapper.ts`, `outbox-relay.ts`, `outbox-relay.service.ts`, `outbox-relay.config.ts`, `kafka-fact-publisher.ts`, `create-kafka-client.ts`, `kafka.config.ts`, and the two test fixtures — from `apps/orders/src/infrastructure/outbox/`, with a `// COPY OF — apps/orders/src/infrastructure/outbox/<file>` banner on each. Same poll (`published_at IS NULL ORDER BY seq FOR UPDATE SKIP LOCKED`), same stamp-after-ack, same idempotent producer, same self-scheduling loop, same `OUTBOX_*` settings. The schema is already byte-identical by `OI11`.

### 9.2 The service-neutral refactor — the smallest edit that works

Two service-specific names stand between the canonical family and byte identity. Both are removed by **indirection through a fixed relative path**, which is exactly the mechanism `OI12`'s import whitelist already relies on — not by widening a Drizzle generic parameter, whose variance behaviour would have to be discovered rather than reasoned about.

| Name | Today | After |
|---|---|---|
| `OrdersDb` in `outbox-relay.ts` (1 import, 2 references) | `import type { OrdersDb } from '../persistence/client'` | `import type { WriteModelDb } from '../persistence/client'` — each service's `client.ts` gains `export type WriteModelDb = <Service>Db;` |
| `ORDERS_FACTS_TOPIC` in `kafka-fact-publisher.ts` (1 import, 1 default) | `import { ORDERS_FACTS_TOPIC } from './kafka.config'` | `import { FACTS_TOPIC } from './kafka.config'` — each service's `kafka.config.ts` gains `export const FACTS_TOPIC = <SERVICE>_FACTS_TOPIC;` |

The existing `OrdersDb`, `FulfillmentDb`, `BillingDb`, `ORDERS_FACTS_TOPIC` and `FULFILLMENT_FACTS_TOPIC` exports **stay**, so no other file, spec or fixture in either service changes. The two new exports are one line each. This is a rename behind an alias, not a redesign, and the relay's behaviour is untouched — which is the point: a refactor whose only observable effect is that a text guard can now be armed.

### 9.3 What is guarded, and what deliberately is not

| File | Guarded by `OB1`? | Why |
|---|---|---|
| `outbox-relay.ts`, `outbox-relay.service.ts`, `outbox-relay.config.ts`, `outbox-envelope-mapper.ts`, `outbox-recorder.ts`, `kafka-fact-publisher.ts`, `create-kafka-client.ts` | **yes** — banner-stripped byte identity across all three | They are one implementation duplicated by the database-per-service rule; drift between them is a defect by definition |
| `kafka.config.ts` | **no** | It *is* the per-service difference — the topic constant and the client-id default. Each service already has its own read-the-spec-as-text test asserting its constant equals its AsyncAPI channel's `bindings.kafka.topic`; that is the right guard for a file whose whole content is meant to differ |
| `client.ts`, `drizzle-unit-of-work.ts` | **no** | Genuinely per-service (pool config, schema type, `<Service>Tx`). `drizzle-unit-of-work.ts` was never in a parity set and is not added to one here — explicitly out of scope |
| `bare-json-nats.{serializer,deserializer}.ts` | **no, this feature** | Byte-identical copies with banners; extending a guard to the messaging family is a natural next step and is recorded as an open point (§4.3), not smuggled into this feature's scope |

### 9.4 `OB1` — the guard itself

`apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts`, modelled case-for-case on `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` and reusing its exact helpers (`findRepoRoot` by walking up to `pnpm-workspace.yaml`, `stripBanner`, `importSpecifiersOf`, `listApps`) so a reader who has read one has read both. Pure text, `node:fs` only, no Docker, runs inside `pnpm quality`.

1. **Byte identity.** For every app owning `src/infrastructure/persistence/schema/outbox.schema.ts`, each of the seven guarded files must equal the canonical after banner-stripping. Non-vacuity: `orders` is in the set, and the set must have **at least three** members — the assertion that says out loud that the guard is armed, replacing `OI12`'s "only the canonical exists yet" placeholder.
2. **Adoptability.** The canonical bodies must not match `/orders|fulfillment|billing|projector|notifications/i` outside their banners (the deliberately un-`\b`-bounded pattern, so `OrdersDb` is caught), and every import specifier must be in a portable whitelist: `drizzle-orm`, `kafkajs`, `@nestjs/common`, `@otc/shared-kernel`, `@otc/contracts`, `../persistence/client`, `../persistence/schema`, `../persistence/drizzle-unit-of-work`, `../../application/ports/clock.port`, `../../application/ports/fact-publisher.port`, `./outbox-relay`, `./outbox-relay.config`, `./outbox-envelope-mapper`, `./kafka.config`, `./create-kafka-client`.
3. **Census.** Every app that owns a MySQL `outbox` schema must own all seven files — the case that fails the day a fourth write model appears with a hand-rolled relay.

### 9.5 Topic, key, headers

Billing publishes **only** to `otc.billing.facts.v1` (one topic per service); `kafka.config.spec.ts` reads `asyncapi.yaml` as text and asserts `BILLING_FACTS_TOPIC` equals the `billingFacts` channel's `bindings.kafka.topic` (the topic already exists — `infra/kafka/create-topics.sh`, 6 partitions). Key = `correlationId` = the order id from `x-correlation-id` (`R15`), which is why `BC1` refuses a hold without it.

**A note for feature 22, recorded here because this feature builds the machinery.** saga.md §6 and `asyncapi.yaml`'s `billingFacts` description require `payment.received.v1` and `credit.released.v1` to be written to the outbox **in one transaction, in that order, on the same partition key**. The relay's `ORDER BY seq` poll and the `correlationId` key preserve that ordering for free, provided both records are recorded in one `outboxRecorder.record(tx, [...])` call in emission order. Nothing in this feature exercises it; the constraint is written down so feature 22 does not rediscover it.

## 10. `apps/seed` — two inherited findings fixed, one reassigned

### 10.1 N1 — `outbox-parity.spec.ts` matches migration comments

`outboxAndProcessedEventsStatements` tests `/\boutbox\b|\bprocessed_events\b/` against the **raw** statement, so a `--` comment mentioning either table makes a comment-only chunk a compared "statement" — which is why migration `0002`'s header had to call the outbox "the fact-relay table". Fix: strip SQL comments first, in `normalise()`, and filter on the normalised text.

```ts
function stripSqlComments(statement: string): string { /* /* … */ blocks, then -- … to end of line */ }
function normalise(statement: string): string { return stripSqlComments(statement).replace(/\s+/g, ' ').trim(); }
// …then: const executable = normalise(statement); if (executable.length > 0 && /\boutbox\b|\bprocessed_events\b/.test(executable)) statements.push(executable);
```

`BC18`'s test case is added to the same file and asserts the property directly: a fixture statement that is *only* a comment mentioning `outbox` contributes nothing. The three real statement sets must still compare equal afterwards — a task runs `pnpm --filter @otc/seed test -- outbox-parity` and records the count before and after, because a fix that silently *changes* what is compared would be worse than the bug.

### 10.2 N3 — `verify.ts` on a long-lived development database

`assertEqual('orders.orders', orders.orders, SAGAS.length)` and its siblings exit 1 as soon as any live order exists — which this feature's own live-boot pass guarantees, since the database already holds `ORD-000007` … `ORD-000011`. Fix: split the assertion vocabulary.

- **Exact (`assertEqual`)** — reference data live traffic never grows: `currencies`, `products`, `retailers`, `companies`, `stock`, **`credits`**.
- **Lower bound (`assertAtLeast`)** — everything saga traffic grows: `orders`, `orderItems`, `orders.outbox`, `reservations`, `despatches`, `despatchItems`, `fulfillment.outbox`, `creditItems`, `invoices`, `invoiceItems`, `payments`, `billing.outbox`, `mongo.order_timeline`.
- The error message names which kind failed (`expected exactly N, got M` vs `expected at least N, got M`).

`credits` staying **exact** is not an accident: `BC3` forbids creating a credit line on demand, so no live path can insert one. If a later feature makes credit lines creatable, this assertion is the thing that will notice — and it should.

`BC19`'s new `apps/seed/src/verify.spec.ts` drives `verifySeed` against fake count sources: a database with extra saga rows passes; one missing a reference row still fails, naming it.

**Why here rather than at feature 28.** `review_fulfillment_stock.md` put this "due no later than feature 28". It becomes due earlier because this feature's own live-boot procedure re-runs `pnpm seed`, and a verifier that exits 1 on the current database blocks the procedure it is part of.

### 10.3 N2 — reassigned, not fixed

`apps/fulfillment/src/application/despatch-creation.handler.ts:99-100` sources `companyCode` from `items[0]` and `retailerCode` from the reservation. `review_fulfillment_despatch.md` records it as **correct today** and asymmetric to read — a comprehension hazard, not a defect. Fixing it means adding a clarifying comment (or symmetrising the source) inside a file this feature otherwise does not touch, widening the Fulfillment blast radius past §9's bounded relay edit for zero behavioural gain. **Owner:** the next pass that opens `apps/fulfillment/src/application/` for its own reasons — feature 27's retry/DLQ work at the latest. Recorded in `progress/impl_billing_credit.md`'s hand-over so it stays owed.

## 11. First boot against the live compose stack — worked out, not discovered

**Pre-state, read from the running stack while writing this design** (not assumed):

| Order | Retailer / company | Status | Total (minor) | `saga_commands` |
|---|---|---|---|---|
| `ORD-000007` | `AldiDe` / `ALBIONFOODS` | `stock_reserved` | 49 998 | `stock.reserve` `sent`, `credit.hold` `parked` |
| `ORD-000008` | `AldiDe` / `ALBIONFOODS` | `stock_reserved` | 49 698 | idem |
| `ORD-000009` | `AldiDe` / `ALBIONFOODS` | `stock_reserved` | 49 698 | idem |
| `ORD-000010` | `CarrefourEs` / `IBERFOODS` | `stock_reserved` | 74 997 | idem |
| `ORD-000011` | `CarrefourEs` / `IBERFOODS` | `stock_reserved` | 74 997 | idem |

`otc_billing.credits` holds the seven seeded lines, each 500 000 minor units; `otc_billing.credit_items` holds fifteen rows that net to **zero** exposure on every line (each seeded completed saga wrote `hold`, `consume`, `release` of the same amount; the seeded cancelled saga `ORD-000006` wrote nothing, because a rejection records nothing). So every seeded line starts at `availableCredit = 500 000`.

**The five parked orders do not all get the same answer, and the difference is the point.**

- **`ORD-000010` and `ORD-000011` advance.** `(CarrefourEs, IBERFOODS)` resolves to `CR-000001`. 74 997 ≤ 500 000, so the first is approved (`availableCreditAfter` 425 003) and the second, seeing the first's committed hold, is approved too (`availableCreditAfter` 350 006). The orchestrator consumes `credit.approved.v1`, moves `stock_reserved → credit_approved → confirmed` in one handler, emits `order.confirmed.v1` and issues `despatch.create` — **and Fulfillment answers it**, because feature 18 landed. Their reservations move `reserved → consumed`, `IBERFOODS`/`PRD-0001` drops from 500 units to 494 with `reserved_units` back to 0, `DES-000006`/`DES-000007` are created, `order.despatched.v1` is published. The orchestrator moves them to `despatched` and issues `invoice.issue` — for which Billing registers **no** responder in this feature, so NATS answers `NoResponders`, the dispatcher treats it as a transport failure, and after three attempts the row **parks**. Final resting state: **`despatched`, parked at `invoice.issue`** — two saga steps further than before, and the first time an order in this repository crosses three services.
- **`ORD-000007`, `ORD-000008` and `ORD-000009` do not.** `AldiDe`'s only seeded credit line is `(AldiDe, GERMANFOODS)` — `CR-000006`. There is **no** credit line for `(AldiDe, ALBIONFOODS)`, so `BC3` fires: `RpcError NOT_FOUND`, nothing written, no fact, the dispatcher parks the row again. These three stay `stock_reserved` with `credit.hold` parked, their reservations still `reserved`. That is the designed refusal for a contract violation, and it is the exact analogue of the `NOT_FOUND` these same three orders received from `stock.reserve` before feature 18 seeded their company's stock.

**This is a finding about the seed, not about Billing.** The seed gives every *retailer* a credit line against exactly one *primary supplier*, so any order against any other supplier has no credit line at all — 7 lines where 7 × 22 pairs are reachable. It is the same class of incoherence `review_fulfillment_stock.md` found for `stock` and feature 18 fixed by adding a baseline row per uncovered pair. The symmetric fix here (a baseline credit line per uncovered `(retailer, company)` pair, at the same 500 000 limit in the retailer's currency) would make all five orders advance — **and it is deliberately NOT taken in this design**, because it is a change to seeded master data that alters the demo's shape, and because leaving three orders parked on a *different* contract violation than the two that advance is itself a good demonstration of the difference between a business rejection and a contract violation. Recorded as an open point for conscious decision at the gate (`progress/spec_billing_credit.md`, row 12).

**Is a genuine over-limit rejection constructible today? Yes.** With `CREDIT_FAILURE_RATE` absent and no simulator bound, a fresh order against `(CarrefourEs, IBERFOODS)` for **21 × `PRD-0001`** totals 21 × 24 999 = **524 979** minor units, which exceeds the 500 000 limit outright — and 524 979 mod 100 = 79, so it would not be confused with the `.99` affordance even once feature 20 is bound. Stock is not a constraint: `IBERFOODS`/`PRD-0001` holds 494 units after the two despatches above, and neither `orders.create`'s DTO nor the `Quantity` value object caps a line's quantity. After `ORD-000010`/`ORD-000011`'s holds the line is at 350 006 available, so **15 × `PRD-0001`** (374 985) is also over limit and is the cheaper demo. The implementer places one of these during the live-boot pass and records the resulting `credit.rejected.v1` with `reason: over_limit`, the `stock.release` compensation and the `cancelled`/`credit_rejected` order — the first end-to-end compensation this repository has ever run, and it runs **without** the simulator, which is precisely what `R44`'s last clause asks to remain reachable.

The implementer records the actual `SELECT` outputs and the structured log lines in `progress/impl_billing_credit.md` § Live boot, with timestamps; the human's manual verification script is derived from that section. If a clean slate is preferred, the established recreate procedure (`docker compose down -v` → up → migrate → seed) applies, and the verification becomes "place an order, watch it reach `despatched` and park at `invoice.issue`; place a 21-unit order, watch it cancel with the stock visibly released". Either path is correct and the choice is recorded.

## 12. Rejected alternatives, recorded

| Alternative | Why not |
|---|---|
| A materialised `available_credit` (or `active_holds`) column on `credits` | A second source of truth for a quantity the ledger already determines, kept in step by discipline; needs a migration; and it is exactly the drift `B2`'s append-only rule exists to prevent. The `credits.schema.ts` header already reasoned this way for the `CHECK` constraint |
| A projection table (`credit_exposure`) maintained in the same transaction | Same objection, plus a second write per hold and a rebuild story nobody would exercise. Justified only at a volume this system will never see |
| Periodic compaction entries (a `hold`/`release` pair collapsing history) | Would bound the `Σ` scan, but makes the ledger's rows no longer a faithful audit trail — the one property `B2` is for |
| A fourth `credit_items` type recording refusals, to make `BC8` idempotent | Contradicts **B1** (*"not recorded"*), changes the shared schema, and makes every `Σ` type-dependent. The duplicate fact is absorbed by machinery that already exists (§5.6) |
| Auto-creating a credit line on first hold (`BC3`) | Would let a typo in `companyCode` silently mint credit, and would make the seed verifier's `credits` count non-deterministic. Master data is created by the seed or by an operator, never by a saga |
| Emitting `credit.rejected.v1` for a currency mismatch, per `R39`'s literal wording | The `reason` enum has no member for it and `R44` requires those three to stay closed for #8/#9; inventing a fourth is a trilogy-wide contract change to cover a case that is a defective message, not a credit decision. `R39` is amended instead (`requirements.md` §3) |
| Widening the relay to `MySql2Database<Record<string, unknown>>` (feature 17's suggested shape) | Makes byte identity depend on Drizzle's generic variance, which would have to be discovered empirically and could break on a minor upgrade. The `WriteModelDb` alias at a fixed relative path is the same mechanism `OI12`'s whitelist already trusts (§9.2) |

## 13. Testing approach

| File | Level | Runner | Proves |
|---|---|---|---|
| `domain/buyer-credit.spec.ts` | domain unit | `vitest.config.mts` (in `pnpm quality`) | `R37` (matrix name `buyer-credit.spec`), `BC5` |
| `domain/credit-hold.spec.ts` | domain unit | idem | `R38`, `R39` (matrix names), `BC10` domain half, `BC14` domain half |
| `domain/credit-ledger.spec.ts` | domain unit | idem | `R40`, `R41` (matrix names), `BC6` domain half, `BC11`, `BC12` |
| `domain/credit-exposure.spec.ts` | domain unit | idem | the `BC5`/`BC6` identities as properties, including the cancelled-before-invoice case the literal §5.1 formula gets wrong |
| `application/credit-hold.handler.spec.ts` | unit | idem | `BC7` short-circuit, `BC13` port ordering, reply built after commit, rollback ⇒ no reply |
| `application/credit.command-handlers.spec.ts`, `credit.query-handlers.spec.ts` | unit | idem | delegation only |
| `application/ports/credit-decision.port.spec.ts` | unit | idem | `BC14` type half — a `@ts-expect-error` probe that `over_limit` is not an adapter reason |
| `infrastructure/credit/always-approve-credit-decision.spec.ts` | unit | idem | `BC15` |
| `presentation/credit.controller.spec.ts`, `rpc-error-mapper.spec.ts` | unit | idem | `BC1` header refusal, validation ⇒ `RpcError`, never throws, subject constants = AsyncAPI addresses, every mapped error class → code |
| `infrastructure/messaging/bare-json-nats.spec.ts` | unit | idem | §4.3 both directions |
| `infrastructure/outbox/kafka.config.spec.ts`, `outbox-relay.spec.ts` | unit | idem | topic guard; `OI6` no-overlap on the copy |
| `apps/orders/.../outbox-relay.parity.spec.ts` | unit | idem | `BC17` / `OB1`, three cases, **armed** by this copy |
| `apps/orders/.../idempotent-consumer.parity.spec.ts` (existing) | unit | idem | now compares three copies |
| `apps/seed/src/outbox-parity.spec.ts` (extended), `verify.spec.ts` (new) | unit | idem | `BC18`, `BC19` |
| `credit-hold.integration.spec.ts` | integration | `vitest.integration.config.mts` — Testcontainers MySQL `mysql:8.4.11` + NATS `nats:2.14.5-alpine` + Kafka `apache/kafka:4.3.1` | `R38`/`R39` integration halves, `BC1`, `BC3`, `BC4`, `BC7`, `BC8`, `BC10` |
| `credit-hold-race.integration.spec.ts` | integration | idem | `BC9` |
| `credit-list.integration.spec.ts` | integration | MySQL + NATS | `BC6` integration half |
| `credit-wire.integration.spec.ts` | integration | MySQL + NATS | `BC2` |
| `infrastructure/persistence/*.integration.spec.ts` | integration | MySQL | `save` inserts only, rollback leaves neither row (`R13` shape, `OI9` re-proven), the read repository's filters and paging at SQL level |
| `infrastructure/outbox/outbox-relay.integration.spec.ts` | integration | MySQL + Kafka | `BC16` |

**The synchronisation rule (reviewer ruling, feature 16 third pass) is binding on every integration spec here.** Wait only on **terminal or monotonic** evidence: an outbox row's `published_at` (set once, never cleared), the count of rows in the append-only `credit_items` table, the `claimed`/`published` result of a hand-driven `relay.runOnce()`, a Kafka consumer's received-message list, or an RPC reply. **Never** poll `availableCredit` or any derived quantity mid-flight — it is a computed value the system passes through, and polling it is a race by construction. For `BC9`: start two raw-`nats` requests with `Promise.all` against a line with room for exactly one, then assert on the **replies** (one `approved`, one `rejected`), on the **final** `Σ hold − Σ release ≤ creditLimit`, and on the outbox holding exactly one `credit.approved.v1` and one `credit.rejected.v1` for the two correlation ids — all terminal. Repeat 10× on a fresh credit line each time so a scheduling fluke is visible rather than lucky.

**Harness.** `test-support/credit-integration-harness.ts` boots the **real** `AppModule` provider graph (`Test.createTestingModule({ imports: [AppModule] })` with DB/NATS/Kafka config overridden from the containers) and connects the NATS microservice with the §4.3 (de)serializers — so the suites exercise the same DI wiring, decorators and serializers the live process uses, which is what would have caught the feature-16 transport-binding crash. Callers are raw `nats` clients, never `ClientProxy`. Images are the pinned tags `docker-compose.infra.yml` uses; `vitest.integration.config.mts` adopts the sibling services' `fileParallelism: false` and 180 s / 120 s timeouts with the same comment.

## 14. Configuration and dependencies

| Setting | Default | Note |
|---|---|---|
| `NATS_URL` | `nats://localhost:4222` | reused — the NATS microservice's `servers` |
| `KAFKA_BROKERS` | `localhost:9092` | reused — the relay producer |
| `BILLING_KAFKA_CLIENT_ID` | `otc-billing` | **new** — a third service must not silently share `KAFKA_CLIENT_ID` (`otc-orders`) |
| `OUTBOX_RELAY_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_PUBLISH_TIMEOUT_MS` | as Orders | reused names — all three relays read the same four values |
| `BILLING_PORT` | `3004` | existing |

`.env.example` gains `BILLING_KAFKA_CLIENT_ID` next to the other two. **`CREDIT_FAILURE_RATE` is deliberately not introduced here** — it is feature 20's, and adding it now would put an unused knob in the environment that `R43`'s start-up validation does not yet police.

**Packages added to `apps/billing/package.json`** (all already in the workspace catalog — **no new catalog entry**; each named in the phase commit message): `@nestjs/cqrs`, `@nestjs/microservices`, `class-validator`, `class-transformer`, `kafkajs`, `nats`; dev: `@nestjs/testing`, `@testcontainers/kafka`, `@testcontainers/nats`. `apps/billing/tsconfig.build.json` gains `"src/**/test-support/**"` in `exclude` (advisory `N4`, replicated for the third service). `eslint.config.mjs` is untouched: its `apps/*/src/**` globs already cover Billing.

## 15. Out of scope — restated

- **The `.99` rule, `CREDIT_FAILURE_RATE`, `R42` – `R44`**: feature 20. The port is here; the simulator is not.
- **`invoice.issue`, the `Invoice` aggregate, the `consume` caller**: feature 21. `consumeHold` is delivered, unit-tested and uncalled.
- **`payment.register`, the `invoice_paid` release caller**: feature 22. `releaseHold` is delivered, unit-tested and uncalled.
- **A `billing.credit.release` responder**: no such subject exists in `asyncapi.yaml` (`requirements.md` §3).
- **DLQ, retries, metrics, tracing, `traceparent`/`x-deadline-ms`, Terminus**: feature 27.
- **Gateway callers of `billing.credit.list`**: feature 25.
- **`N2`** (Fulfillment's `companyCode`/`retailerCode` asymmetry): reassigned, §10.3.
- **A messaging-family parity guard** for the bare-JSON (de)serializer pair: open point, §4.3.
