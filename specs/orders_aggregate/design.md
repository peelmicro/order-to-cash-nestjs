# `orders_aggregate` — Design (NestJS / TypeScript, assessment #7)

> **Stack-specific.** This file is where the TypeScript, `@otc/shared-kernel`, `@otc/contracts`, Drizzle and NestJS detail lives. Nothing here belongs in `specs/shared/`; assessments #8 and #9 write their own equivalent against the same `R1`–`R10`.
>
> Authorities: [`specs/shared/domain-model.md`](../shared/domain-model.md) §3 (the aggregate and Table T-1), [`specs/shared/saga.md`](../shared/saga.md) §3–§4 (which transitions the orchestrator drives), [`specs/shared/requirements.md`](../shared/requirements.md) §1 (`R1`–`R10`).

## 1. Scope

**In scope.** The pure domain of the Orders context: the `Order` aggregate root, the `OrderLine` child entity, the closed status and cancellation-reason types, Table T-1 expressed as data, the four facts Orders itself emits, the domain errors, and the **repository port interface** the application layer will depend on. Pure Vitest domain tests for all of it.

**Out of scope, and owned elsewhere.**

| Not here | Owned by |
|---|---|
| Outbox table writes, the transactional `save`, the polling relay, `processed_events` | feature 14 `outbox_and_idempotency` |
| The Drizzle repository **adapter**, the `stock.check` NATS call, order-number allocation, the `orders.create` handler | feature 15 `orders_acceptance` |
| Kafka consumers, the saga orchestrator, RPC command issuing, compensation sequencing | feature 16 `order_saga_orchestrator` |
| Anything a broker, a database client or a Nest decorator touches | features 14 – 16 |

The aggregate is a **pure function of its inputs**: it never reads a clock, never generates a timestamp, never talks to a port. Everything it needs is passed in (§4.6).

## 2. Where everything lives

```
apps/orders/src/
  domain/                              ← zero framework imports (ESLint-enforced)
    order.ts                           Order aggregate root
    order-line.ts                      OrderLine child entity
    order-status.ts                    OrderStatus union + values + guard
    order-cancellation-reason.ts       CancellationReason union + values + guard
    order-transitions.ts               Table T-1 as data + lookup
    order-totals.ts                    pure totals derivation over lines
    order-events.ts                    the four fact builders (envelope + payload)
    order-errors.ts                    the domain errors of this aggregate
    order-snapshot.ts                  the reconstitution input type
    index.ts                           the domain barrel (public surface)
    order.spec.ts                      R5, R7, OA3, OA5
    order-state-machine.spec.ts        R8, R9
    order-totals.spec.ts               R6, OA1
    order-cancellation.spec.ts         R10, OA4
    order-events.spec.ts               OA2
    order-status.spec.ts               domain ↔ @otc/contracts parity
  application/
    ports/order-repository.port.ts     the port interface + its injection token
  infrastructure/persistence/schema/
    order-items.schema.ts              + `description` column (post-gate amendment, §9.1)
    orders.schema.spec.ts              schema ↔ domain status parity (lives here, not in domain/)

apps/orders/drizzle/
  0001_<name>.sql                      generated: ALTER TABLE order_items ADD description (§9.1)
```

Test-file names are chosen to match the paths `specs/shared/test-matrix.md` §1 already names (`orders/domain/order.spec`, `…/order-totals.spec`, `…/order-state-machine.spec`, `…/order-cancellation.spec`), so the matrix maps one-to-one onto real files without editing the shared document.

**Layering.** `domain/` imports only `@otc/shared-kernel` (runtime) and `@otc/contracts` (**type-only**, `import type`, erased at compile time). It imports nothing from `application/`, `infrastructure/` or `presentation/` — the existing `no-restricted-imports` rule in `eslint.config.mjs` fails the build otherwise. The repository **port** lives in `application/` because it is the application's requirement of the outside world, not a domain concept; the adapter that satisfies it lands in `infrastructure/` in feature 15.

**Workspace wiring.** `apps/orders/package.json` today declares neither `@otc/shared-kernel` nor `@otc/contracts`. Both are added as `"workspace:*"` dependencies by this feature. **Post-gate amendment:** `apps/billing/package.json` and `apps/fulfillment/package.json` are missing them too — `apps/seed` is the only app that declares them, because it is so far the only one that imports them — so the same two lines are added to all **three** service packages here, since the defect is latent and identical in each and features 17–20 would otherwise re-discover it twice (tasks A1, A3). Both packages resolve through `main`/`types` → `dist/`, which is git-ignored, so `pnpm build` must precede `pnpm typecheck`/`pnpm test` on a clean clone (pre-existing across the monorepo; the root `quality` script is **not** changed here — see the open-points table and feature 34).

## 3. The closed types the domain owns

```ts
export const ORDER_STATUSES = ['placed', 'stock_reserved', 'credit_approved', 'confirmed',
  'despatched', 'invoiced', 'paid', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CANCELLATION_REASONS = ['stock_rejected', 'credit_rejected', 'operator_cancelled'] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];
```

The **domain owns these unions**, not `@otc/contracts` and not the Drizzle schema. The schema file already says so in its own header comment ("the domain's own `OrderStatus` union type … is the source of truth and this type must track it, never the reverse"). Two cheap parity tests turn "must track it" into a failing build:

- `order-status.spec.ts` (domain layer, may import `@otc/contracts` as a type): asserts mutual assignability with the generated `OrderStatus` / `CancellationReason` and equality of the value sets.
- `orders.schema.spec.ts` (infrastructure layer, because a domain test may not import `infrastructure/`): asserts `ORDER_STATUS_VALUES` from `orders.schema.ts` equals `ORDER_STATUSES`.

This is the general shape of "invalid states unrepresentable **where feasible**": a status is never a `string` anywhere in this service, a reason is never a `string`, an amount is never a `number`, a quantity is never a `number`, a party id is never a `string`.

## 4. The `Order` aggregate

### 4.1 Shape

```ts
export class Order extends AggregateRoot<Order> {
  private constructor(private props: OrderProps) { super(props.id); }
  get orderReference(): OrderNumber
  get orderDate(): Date
  get buyerGln(): GLN;        get retailerCode(): string
  get supplierGln(): GLN;     get companyCode(): string
  get currency(): string                  // ISO 4217, the order's single currency (O2)
  get status(): OrderStatus
  get lines(): readonly OrderLineView[]   // frozen copies — OA5
  get initialAmount(): Money;  get initialDiscount(): Money;  get totalAmount(): Money
  get cancellationReason(): CancellationReason | undefined   // defined iff status === 'cancelled'
  get notes(): string | undefined
}
```

`id` is the `UniqueId` from `AggregateRoot`/`Entity` and is **also the saga `correlationId`** (`saga.md` §1) — the aggregate therefore never carries a separate saga id. Totals have **no setters**: they are recomputed by `computeOrderTotals` on every path that touches lines (**O3**, R6).

### 4.2 Two construction paths, and only two

```ts
static place(input: PlaceOrderInput, ctx: TransitionContext): Order
static reconstitute(snapshot: OrderSnapshot): Order
```

The constructor is `private`, so no third path exists.

**`place(...)`** is the only way a *new* order comes into being. It enforces every creation invariant **before** anything is assigned:

1. at least one line (**O1**, R5) — else `EmptyOrderError`;
2. every line's `unitPrice`/`lineDiscount` currency equals the order currency (**O2**, OA1) — else `OrderLineCurrencyMismatchError`;
3. totals derived and non-negative (**O3**, R6) — else `NegativeOrderTotalError`;
4. status set to `placed` (Table T-1 row 1) and **exactly one** `order.placed.v1` appended (OA2).

`PlaceOrderInput` takes value objects, never primitives: `{ id: UniqueId, orderReference: OrderNumber, orderDate: Date, buyer: { gln: GLN, code: string }, supplier: { gln: GLN, code: string }, currency: string, lines: PlaceOrderLineInput[], notes?: string }`. The `orderReference` is **pre-allocated by the caller** — sequence allocation is a persistence concern and lands with the repository adapter in feature 15 as an `OrderNumberAllocator` port.

**`reconstitute(...)`** rebuilds an order that already exists. It is a different method rather than a flag on `place` because the two have opposite obligations, and a flag makes the wrong one the default:

| | `place` | `reconstitute` |
|---|---|---|
| Emits `order.placed.v1` | yes, exactly one | **never** (OA3) |
| Status | forced to `placed` | taken from the snapshot, validated against `ORDER_STATUSES` |
| Cancellation reason | absent | required iff status is `cancelled`, forbidden otherwise (OA3) |
| Totals | derived | **re-derived** — `OrderSnapshot` carries no totals fields at all, so a stored/derived drift is unrepresentable rather than merely detected |
| Uncommitted events afterwards | one | `pullDomainEvents()` returns `[]` |

`OrderSnapshot` is a **domain-shaped** structure of value objects (`UniqueId`, `OrderNumber`, `GLN`, `Money`, `Quantity`, `OrderStatus`), not a Drizzle row: the repository adapter maps rows → snapshot, resolving `company_id`/`retailer_id`/`currency_id` to codes/currency on its own side (§8). The domain never sees a foreign key.

### 4.3 Totals

```ts
export function computeOrderTotals(currency: string, lines: readonly OrderLine[]): OrderTotals
// initialAmount   = Σ line.unitPrice.multiply(line.quantity)
// initialDiscount = Σ line.lineDiscount            (order-level discount ≡ Money.zero, see below)
// totalAmount     = initialAmount.subtract(initialDiscount)   → NegativeOrderTotalError if negative
```

Arithmetic is `Money` only — `Money.multiply(Quantity)`, `add`, `subtract` — so **R1** and **R2** hold by construction and no `number` arithmetic on amounts exists in this feature.

**Order-level discount.** `domain-model.md` §3.2 (**O3**) and R6 both write "plus any order-level discount", but the `Order` field table names no such field, the `orders` table has no `order_discount` column, and `OrderPlacedPayload` has no such property. This design therefore carries **no order-level discount**: the term is a constant `Money.zero(currency)` and `initialDiscount = Σ lineDiscount`. `computeOrderTotals` keeps the term in the formula (a named local) so that adding one later is a one-line change with an obvious home.

### 4.4 Lines, and the freeze

`OrderLine` is an `Entity<OrderLine>` with a `UniqueId` local to the aggregate and **immutable fields**: `productCode: string`, `description: string`, `quantity: Quantity`, `unitPrice: Money`, `lineDiscount: Money`. It has no setters at all; a "modification" produces a **new** `OrderLine` with the same id (`withQuantity(q)`), and only `Order` ever puts it back into the collection. That is the mechanism, not a convention: there is no reachable method on a line that mutates the aggregate.

Three mutators exist, purely because `R5`, `R6` and `R7` are about them (no saga flow and no Gateway endpoint uses them — ORDCHG is out of the model):

```ts
addLine(input: PlaceOrderLineInput): void
removeLine(lineId: UniqueId): void
changeLineQuantity(lineId: UniqueId, quantity: Quantity): void
```

Each follows **validate-then-commit**, which is what makes "leaves every field of the order unchanged" (R6, R7, R9) true rather than hopeful:

1. guard the status: `LINES_MUTABLE_IN = new Set<OrderStatus>(['placed', 'stock_reserved', 'credit_approved'])`; anything else throws `OrderLinesFrozenError` carrying the status (**O4**, R7);
2. guard the argument (`UnknownOrderLineError`, `OrderLineCurrencyMismatchError`, last-line removal → `EmptyOrderError`);
3. build the **candidate** line array in a local;
4. run `computeOrderTotals` over the candidate (may throw `NegativeOrderTotalError`);
5. only now assign lines and totals together.

Nothing is written to `this.props` before step 5, so every rejection path is trivially side-effect free.

`get lines()` returns `Object.freeze`-ed copies of immutable line views (OA5) — a caller cannot `push`, cannot reassign an element and cannot reach a `Money` mutator (there is none).

### 4.5 Command methods — one per saga step

Names are aligned with `saga.md` §3.1 and §4, so a reader can put the two tables side by side.

| Method | Edge (T-1) | Driven by (`saga.md`) | Appends |
|---|---|---|---|
| `static place(input, ctx)` | *(none)* → `placed` | step 0, order acceptance (feature 15) | `order.placed.v1` |
| `markStockReserved(ctx)` | `placed` → `stock_reserved` | step 2, on `stock.reserved.v1` | — |
| `approveCredit(ctx)` | `stock_reserved` → `credit_approved` | step 3, on `credit.approved.v1` | — |
| `confirm(ctx)` | `credit_approved` → `confirmed` | step 3, the ORDRSP moment | `order.confirmed.v1` |
| `markDespatched(ctx)` | `confirmed` → `despatched` | step 4, on `order.despatched.v1` | — |
| `markInvoiced(ctx)` | `despatched` → `invoiced` | step 5, on `invoice.issued.v1` | — |
| `markPaid(ctx)` | `invoiced` → `paid` | step 6, on `payment.received.v1` | — |
| `complete(ctx)` | `paid` → `completed` | step 7, on `credit.released.v1` | `order.completed.v1` |
| `cancel(reason, ctx, compensationSteps?)` | `{placed, stock_reserved, credit_approved, confirmed}` → `cancelled` | §4.1 path A, §4.2 step B2, operator cancellation | `order.cancelled.v1` |

Saga step 3 performs **two** edges in one aggregate load (`stock_reserved → credit_approved → confirmed`); that is the orchestrator calling `approveCredit(ctx)` then `confirm(ctx)` on the same instance in feature 16, and it yields exactly one `order.confirmed.v1` (R21). The aggregate offers no combined method — combining them would hide the intermediate `credit_approved` state that `domain-model.md` insists is real and observable.

`cancel` additionally enforces:

- a reason is present and is a member of `CANCELLATION_REASONS` (**O6**, R10) — `CancellationReasonRequiredError` / `InvalidCancellationReasonError`;
- the reason is one Table T-1 pairs with the current status (OA4) — `CancellationReasonNotApplicableError`;
- the reason is written **once** and is thereafter unreadable-as-writable (no setter, and `cancelled` is terminal, so no second `cancel` can run).

`compensationSteps` is a `readonly CompensationStep[]` (type from `@otc/contracts`) supplied **by the caller**, defaulting to `[]`. The aggregate cannot know which compensating facts ran — it never observes `stock.released.v1`; the orchestrator does (feature 16) and passes what it saw. Empty is the correct value for `stock_rejected` (`saga.md` §4.1: nothing was ever acquired, R26).

### 4.6 `TransitionContext` — time and causation in, nothing pulled

```ts
export interface TransitionContext {
  readonly occurredAt: Date;        // UTC instant the fact became true (envelope contract)
  readonly causationId: UniqueId;   // eventId of the causing fact, or the id of the causing command (R12)
}
```

`domain-model.md` §8 rule 2 says timestamps are "stamped by the domain through a **clock port** so tests can control time". This design satisfies that by **passing the instant in** rather than injecting a clock object into the aggregate.

*Trade-off.* A `Clock` port held by the aggregate would shorten call sites, but it makes the aggregate stateful in a collaborator, forces every `reconstitute` to re-attach the clock, and makes an aggregate un-`Object.freeze`-able and awkward to compare in tests. Passing `TransitionContext` keeps every method a pure function of `(state, input)` — the strongest possible position for pure domain tests — at the cost of one extra argument per call. The clock port itself therefore lives in the **application layer** (feature 15/16, where the handlers know the request time) and `@otc/shared-kernel` is **not** extended with a `Clock` in this feature.

## 5. The state machine as data

Table T-1 is copied **once**, as data, in `order-transitions.ts`:

```ts
export interface OrderTransition {
  readonly from: OrderStatus | null;   // null = creation (T-1 row 1)
  readonly to: OrderStatus;
  readonly trigger: string;            // the T-1 "Trigger" cell, verbatim — for docs and error messages
  readonly emits: OrdersFactType | null;  // the T-1 "Fact emitted by Orders" cell
}
export const ORDER_TRANSITIONS: readonly OrderTransition[] = [ /* the 12 rows of T-1 */ ];
export function findTransition(from: OrderStatus, to: OrderStatus): OrderTransition | undefined;
```

A `Map<from, Map<to, OrderTransition>>` is built once at module load for lookup. Every command method funnels through one private `transitionTo(to, ctx)`, which looks the edge up, throws `OrderTransitionNotAllowedError` when it is absent, and otherwise assigns the status and appends the fact named by `emits` (or none).

**Why a table and not a `switch` cascade.** A cascade scatters legality across eight methods, cannot be enumerated, and drifts from T-1 silently. The table is diffable against the shared spec by eye, and it makes the decisive test possible: `order-state-machine.spec.ts` iterates the **full 9 × 9 Cartesian product** of statuses and asserts that exactly the 11 non-creation edges of T-1 succeed and the other **70 pairs** each throw, change nothing and append no event (R8, R9). That is a stronger guarantee than any hand-written list of illegal cases, and it fails loudly if someone adds a row to the table without adding it to T-1.

**Why not typestate (a class per status, so illegal calls do not compile).** It is the only way to make illegal transitions *unrepresentable* in TypeScript, and it was rejected: the orchestrator loads an order whose status is known only at runtime (from MySQL), so `reconstitute` would return a nine-way union and every call site would need narrowing before it could call anything — the compile-time guarantee evaporates exactly where the risk is, and the ORM mapping triples in size. The chosen position is: **closed union types** make an invalid *status value* unrepresentable, **value objects** make an invalid amount/quantity/GLN/reference unconstructable, and the one remaining runtime check — edge legality — is proved exhaustively by test. This is the "unrepresentable where feasible, testable everywhere else" line for this stack.

## 6. Domain events

**The aggregate emits four of the thirteen facts** — those whose producing context is Orders in `domain-model.md` §7.2: `order.placed.v1` (1), `order.confirmed.v1` (8), `order.completed.v1` (12), `order.cancelled.v1` (13).

**The other nine are not emitted here.** `stock.*`, `credit.*`, `order.despatched.v1`, `invoice.issued.v1` and `payment.received.v1` are produced by Fulfillment and Billing. They reach this aggregate only as the *reason a command method is called* by the orchestrator (feature 16), and the corresponding edges emit nothing (OA2). This is the resolution of the tension between invariant **O8** ("a successful state transition appends exactly one domain event") and Table T-1, whose "Fact emitted by Orders" cell is empty for five edges: **T-1 governs**, and O8 is read as *exactly one when T-1 names a fact, none otherwise* — never as an invitation to invent a fourteenth fact type. The timeline stays complete because the projector consumes all thirteen facts, including the five foreign ones that drive those edges.

**Construction.** `order-events.ts` builds each envelope with `createDomainEvent(...)` from `@otc/shared-kernel` and a payload typed by `@otc/contracts`:

```ts
import type { OrderPlacedPayload, OrderCancelledPayload } from '@otc/contracts';

export function orderPlacedEvent(order: Order, ctx: TransitionContext): DomainEventEnvelope<OrderPlacedPayload>
```

| Envelope field | Value |
|---|---|
| `eventId` | generated by `createDomainEvent` (in the domain, at creation, never at publication) |
| `eventType` | the literal `'order.placed.v1'` etc. — validated against `<aggregate>.<fact>.v<n>` by the kernel |
| `aggregateId` | `order.id` |
| `correlationId` | `order.id` — always the order id (R12) |
| `causationId` | `ctx.causationId` |
| `occurredAt` | `ctx.occurredAt` |
| `payload` | built from the aggregate; `Money` → `amount` (minor units) + top-level `currency`; `Date` → ISO-8601 string (`Instant`) |

Payload notes: `OrderPlacedPayload.lines` is typed as a non-empty tuple `[OrderLine, ...OrderLine[]]`, so the builder asserts non-emptiness through a tiny local helper justified by **O1** rather than casting blindly; `OrderLine.description` is optional in the generated type but the domain always supplies it; `cancelledAt`/`confirmedAt`/`completedAt` are `ctx.occurredAt` rendered ISO-8601, so the envelope and the payload can never disagree.

Appending is `AggregateRoot.addDomainEvent`; the infrastructure drains with `pullDomainEvents()` when it persists (feature 14). No aggregate method publishes anything.

## 7. Domain errors

All extend `DomainError` from `@otc/shared-kernel` and carry a stable `code` plus the fields a caller (and a test) needs.

| Class | `code` | Carries | Requirement |
|---|---|---|---|
| `OrderTransitionNotAllowedError` | `ORDER_TRANSITION_NOT_ALLOWED` | `orderId`, `from`, `to` | R9 (**O5**, **O7**) |
| `EmptyOrderError` | `ORDER_HAS_NO_LINES` | `orderId?` | R5 (**O1**) |
| `OrderLinesFrozenError` | `ORDER_LINES_FROZEN` | `orderId`, `status` | R7 (**O4**) |
| `NegativeOrderTotalError` | `ORDER_TOTAL_NEGATIVE` | `orderId?`, `totalAmount` | R6 (**O3**) |
| `OrderLineCurrencyMismatchError` | `ORDER_LINE_CURRENCY_MISMATCH` | `orderId?`, `lineId?`, `expected`, `actual` | OA1 (**O2**) |
| `UnknownOrderLineError` | `ORDER_LINE_NOT_FOUND` | `orderId`, `lineId` | R6, R7 |
| `CancellationReasonRequiredError` | `ORDER_CANCELLATION_REASON_REQUIRED` | `orderId` | R10 (**O6**) |
| `InvalidCancellationReasonError` | `ORDER_CANCELLATION_REASON_INVALID` | `orderId`, `reason` | R10 (**O6**) |
| `CancellationReasonNotApplicableError` | `ORDER_CANCELLATION_REASON_NOT_APPLICABLE` | `orderId`, `status`, `reason` | OA4 |
| `InvalidOrderSnapshotError` | `ORDER_SNAPSHOT_INVALID` | `orderId?`, `reason` | OA3 |

`from`/`to` on `OrderTransitionNotAllowedError` are `OrderStatus`, not strings, so a typo in a test is a compile error. Codes are the vocabulary the RPC error mapping (feature 15) and the HTTP problem mapping (feature 25) will translate; they are stable from here on.

## 8. The repository port — and where the adapter lands

```ts
// apps/orders/src/application/ports/order-repository.port.ts
export const ORDER_REPOSITORY = Symbol('OrderRepository');

export interface OrderRepository {
  findById(id: UniqueId): Promise<Order | null>;
  findByReference(reference: OrderNumber): Promise<Order | null>;
  save(order: Order): Promise<void>;
}
```

**Decision: the port interface lands in this feature, the Drizzle adapter does not.** The adapter arrives in feature 15 (`orders_acceptance`), where it is first *needed* — that is also the first moment it can be written honestly, because a correct `save` must write the aggregate row, its lines and the outbox records in **one transaction**, and the outbox mechanics belong to feature 14.

*Trade-off.* Writing the adapter now would prove the port against real Drizzle sooner and remove the risk that the interface changes when it meets reality. It was rejected for three concrete reasons: (a) `save` would have to be written twice — once without a transaction/outbox, once with — and the intermediate version would be untestable against `R13`; (b) *(withdrawn by the post-gate amendment of 2026-08-20)* the mapping needs an `order_items.description` column that does not exist yet — that column now lands **in this feature** (§9.1, tasks J1–J5), so it is no longer a reason to defer the adapter, and the remaining two reasons carry the decision on their own; (c) it would require Testcontainers in a feature whose acceptance criterion is *"pure domain unit tests, zero framework imports"*, blurring the cleanest demonstration of domain purity in the repository. The accepted cost is a port signature that is **provisional in one respect**: feature 14 will add a transactional-context parameter (`save(order, tx)` or a unit-of-work wrapper). That is recorded here as expected, not as drift.

`Symbol` is used as the injection token so the port file itself needs no `@nestjs/common` import; the Nest provider binding is written in feature 15.

## 9. What the repository will have to map (notes for feature 15) — and the one column this feature adds

Recorded now, because reading `apps/orders/src/infrastructure/persistence/schema/` while designing the aggregate is what surfaced them. Everything below is *notes* for feature 15 **except** the `description` column: the approval gate ruled that migration must land here (§9.1), so the schema stops contradicting the domain model and the `order.placed.v1` payload as of this feature.

| Domain | `otc_orders` write model | Note |
|---|---|---|
| `Order.id` | `orders.id` `char(36)` | UUID generated in the domain |
| `Order.currency` | `orders.currency_id` → `currencies.code` | adapter resolves code ↔ id; the domain never sees an id |
| `retailerCode` / `buyerGln` | `orders.retailer_id` → `retailers.code` / `.gln` | idem |
| `companyCode` / `supplierGln` | `orders.company_id` → `companies.code` / `.gln` | idem |
| totals | `initial_amount`, `initial_discount`, `total_amount` `int` | written **out** only; never read back into the aggregate (OA3) |
| `status` | `orders.status` `varchar(20)` | values must equal `ORDER_STATUSES` — asserted by `orders.schema.spec.ts` |
| `cancellationReason` | `orders.cancellation_reason` `varchar(100)` nullable | non-null iff `status = 'cancelled'` |
| `OrderLine.productCode` | `order_items.product_id` → `products.code` | adapter resolves; the wire always carries the code |
| `OrderLine.description` | `order_items.description` `varchar(255)` `NOT NULL` — **added by this feature** (§9.1) | the snapshot is required by `OrderPlacedPayload` and by `domain-model.md` §3.1; added by migration rather than joined from `products` at load time, which would silently un-snapshot the order — the reasoning is unchanged, only the feature that lands it |
| `createdAt` / `updatedAt` | `orders.created_at` / `updated_at` | audit columns, stamped by the adapter's clock; not domain state |

### 9.1 The `order_items.description` migration (post-gate amendment, lands in this feature)

**Why here.** `domain-model.md` §3.1 makes `description` a required field of `OrderLine`, snapshotted at order time; `OrderPlacedPayload.lines[].description` carries it on the wire; §4.4 of this design makes it an immutable field of the `OrderLine` entity. `apps/orders/drizzle/0000_bizarre_champions.sql` gives `description varchar(255) NOT NULL` to `products` only — `order_items` has `id`, `order_id`, `product_id`, `price`, `quantity`, `discount`, `created_at`, `updated_at` and nothing else. Deferring the column to feature 15 would leave the schema in open contradiction with both the domain model and the published fact payload for the whole life of this feature. The approval gate ruled it lands here.

**Why not join `products` at read time** (the alternative, unchanged from §9): the row would then carry the *current* catalogue text, so a later catalogue edit would silently rewrite the description of a historical order and the reconstituted aggregate would no longer equal the `order.placed.v1` fact that was published from it. That is exactly the un-snapshotting `domain-model.md` §3.1 forbids ("a later catalogue price change never rewrites an order"), and it is why `price` is already snapshotted on the row rather than joined. The column is the honest mapping.

**The column.**

```sql
ALTER TABLE `order_items` ADD `description` varchar(255) NOT NULL;
```

| Choice | Value | Why |
|---|---|---|
| Type/width | `varchar(255)` | `Text` in `domain-model.md` §3.1 is the model's **logical string** type, not MySQL `TEXT` — the same notation labels `productCode`, which this schema already maps to `varchar(30)`. The sibling snapshot source `products.description` is `varchar(255)`, so a description can be copied from the catalogue without truncation, and `asyncapi.yaml`'s `OrderLine.description` (`type: string`, no `maxLength`) imposes no narrower bound. `TEXT` would be off-page storage and an un-indexable column for a short human label — no benefit here. |
| Nullability | `NOT NULL` | `description` is a **required** field of the domain entity and of the snapshot; a nullable column would make an un-representable domain state representable in the store, which is the opposite of §3's line. |
| Default | none | The domain always supplies the value (§6). See the backfill note below. |
| Position | after `product_id` | Keeps the snapshot columns (`description`, `price`, `quantity`, `discount`) together; cosmetic, and whatever `drizzle-kit generate` emits is acceptable. |

**Mechanics.** The Drizzle table definition in `apps/orders/src/infrastructure/persistence/schema/order-items.schema.ts` gains the column first; the SQL is then **generated**, never hand-written, by `pnpm --filter @otc/orders db:generate`, producing `apps/orders/drizzle/0001_<name>.sql` plus its `meta/` journal entry. Both are committed.

**Backfill.** Adding a `NOT NULL` column with no default to a table that already has rows fails (or silently coerces to `''`) depending on `sql_mode`. Today the only writer of `order_items` is `apps/seed`, and no production data exists, so the accepted procedure is: the migration test runs from an **empty** database and is unaffected; a developer with a warm database recreates it (`docker compose down -v`, migrate, re-seed). To make a warm database converge anyway, the seeder's `onDuplicateKeyUpdate` set for `order_items` also writes `description` (task J4).

**Two existing files this breaks if left alone**, both called out as tasks so the implementer cannot leave them half-migrated:

1. `apps/orders/src/infrastructure/persistence/migrations.integration.spec.ts` — its Testcontainers round-trip inserts an `order_items` row and asserts it back (`price`, `quantity`, `discount`). The insert will not typecheck without `description`, and the `toMatchObject` assertion must include it, otherwise the round-trip stops proving the column exists (task J3). The table-list assertion still expects **8** tables — this migration adds a column, not a table.
2. `apps/seed/src/writers/orders-db.writer.ts` + `apps/seed/src/data/sagas.data.ts` — the writer inserts `order_items` rows and will not typecheck without the field. `OrderLineFixture` gains `description: string`, resolved once in `resolveLines(...)` from `productByCode(line.productCode).name` — which is **already** the value `orderPlacedLines(...)` puts into the `order.placed.v1` payload — so the persisted row and the published fact carry the same text by construction rather than by coincidence (task J4). Do not switch the source to `products.description` in this feature: that would change the payload the seeded outbox rows already carry and is a seed-data decision, not an aggregate one.

## 10. Testing

Pure Vitest, `apps/orders/vitest.config.mts` (already excludes `*.integration.spec.ts`). No `@nestjs/*`, no `drizzle-orm`, no Testcontainers, no mocks of infrastructure — there is no infrastructure to mock, which is the point. Time enters through `TransitionContext`, so no test touches `Date.now()`.

**One exception, and it authors no new test:** the post-gate `description` migration (§9.1) requires the *existing* Testcontainers spec `apps/orders/src/infrastructure/persistence/migrations.integration.spec.ts` to have its `order_items` round-trip updated for the new column (task J3). That file is already integration-tier and already excluded from this feature's unit run; the domain suite below stays pure.

| File | Proves |
|---|---|
| `order.spec.ts` | R5, R7, OA3, OA5 — creation invariants, the freeze, reconstitution, non-mutable accessors |
| `order-state-machine.spec.ts` | R8, R9 — 11 legal edges walked, 70 illegal pairs rejected with state and events untouched |
| `order-totals.spec.ts` | R6, OA1 — derivation after every mutation, negative total refused, currency mismatch refused at the aggregate boundary |
| `order-cancellation.spec.ts` | R10, OA4 — closed reason set, immutability, reason ↔ status pairing, payload carries the reason |
| `order-events.spec.ts` | OA2 — four emitting edges, five silent edges, envelope fields (`correlationId = order id`, `causationId`, `occurredAt`) |
| `order-status.spec.ts` | domain ↔ `@otc/contracts` parity |
| `orders.schema.spec.ts` | domain ↔ Drizzle status parity (infrastructure layer) |

Coverage gate for this feature: **≥ 80 % of the domain layer** (`CLAUDE.md`). The exhaustive state-machine test alone reaches most of it; the remainder comes from the error paths above.

Test case names for `R5`–`R10` are **copied verbatim** from `specs/shared/test-matrix.md` §1 — the matrix names the contract and rule 4 makes a rename a traceability break.
