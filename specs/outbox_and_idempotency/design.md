# `outbox_and_idempotency` — Design (NestJS / TypeScript, assessment #7)

> **Stack-specific.** This file is where the TypeScript, Drizzle, MySQL, kafkajs, NestJS and Testcontainers detail lives. Nothing here belongs in `specs/shared/`; assessments #8 and #9 write their own equivalent against the same `R11`–`R18`.
>
> Authorities: [`specs/shared/requirements.md`](../shared/requirements.md) §2 (`R11`–`R18`), [`specs/shared/domain-model.md`](../shared/domain-model.md) §7.1 (the envelope) and §8 rule 5 (*aggregates emit; infrastructure publishes*), [`specs/shared/saga.md`](../shared/saga.md) §6 (the three idempotency layers) and §7 (failure handling), [`specs/shared/asyncapi.yaml`](../shared/asyncapi.yaml) (topic addresses, partition key, `Envelope` and `FactHeaders` schemas).
>
> Inherited advisories resolved here: `progress/review_db_orders.md` advisory **1** (no `causation_id` column) → §3.1; advisory **2** (nondeterministic `(published_at, occurred_at)` poll order) → §3.2 and §5.2. `progress/review_db_fulfillment.md` and `progress/review_db_billing.md` add the binding constraint that the outbox shape stays identical in all three databases → §3.4.

## 1. Scope

**In scope.**

- The **coordinated schema change** to `outbox` in all three write models (`otc_orders`, `otc_fulfillment`, `otc_billing`) — one migration per database, identical shape (§3).
- The **outbox writer**: a `UnitOfWork` port, the final `OrderRepository` signature, and the `OutboxRecorder` that turns pulled domain events into outbox rows inside the caller's transaction (§4).
- The **relay publisher**: poll, claim, publish to Kafka keyed by `correlationId`, stamp after acknowledgement (§5).
- The **idempotent-consumer pattern**: the reusable shape every fact subscriber in this system adopts, proven here against real MySQL (§6).
- The collateral work the schema change creates: three migration round-trip specs, the `apps/seed` writers and fixtures, and a mechanical parity guard across the three schemas (§3.4, §9).
- The **parity guard over the pattern copies** — the check that keeps the per-service copies of §6 in agreement with the Orders canonical as features 17–24 add them (§6.4).

**Out of scope, and owned elsewhere.**

| Not here | Owned by |
|---|---|
| NATS RPC handlers, `orders.create`, the synchronous `stock.check`, order-number allocation | feature 15 `orders_acceptance` |
| The saga orchestrator, Kafka **consumers** (`@EventPattern`), issuing commands, compensation sequencing | feature 16 `order_saga_orchestrator` |
| Consumer retry with backoff, `<topic>.dlq` publication, dead-letter headers, outbox-lag and dead-letter metrics, OTel trace propagation | feature 27 `observability_reliability` (§7) |
| The Fulfillment and Billing **runtime** copies of the writer/relay/consumer pattern (their `outbox` **columns** land here) | features 17–22, copying §4–§6 (§6.3) |
| The projector's MongoDB dedup ledger | feature 24 `projector_read_model` (§6.3) |

## 2. Where everything lives

```
apps/orders/src/
  application/ports/
    clock.port.ts                      CLOCK token + Clock { now(): Date }
    unit-of-work.port.ts               UNIT_OF_WORK token + TransactionContext (opaque) + UnitOfWork
    fact-publisher.port.ts             FACT_PUBLISHER token + PublishableFact + FactPublisher
    order-repository.port.ts           REVISED — save(order, tx), findById(id, tx?), findByReference(ref, tx?)
    consumer-name.ts                   the closed set 'orders.saga' | 'projector' | 'notifications'
  infrastructure/persistence/
    drizzle-unit-of-work.ts            UnitOfWork over db.transaction(); the only place TransactionContext is unwrapped
    order.repository.ts                DrizzleOrderRepository — save + find, outbox written through OutboxRecorder
    order.mapper.ts                    rows <-> Order aggregate (snapshot in, snapshot out)
    schema/outbox.schema.ts            + causation_id, + seq, + trace_parent, occurred_at -> datetime(3), + poll index
  infrastructure/outbox/
    outbox-recorder.ts                 DomainEventEnvelope[] -> outbox rows, inside the caller's tx
    outbox-relay.ts                    OutboxRelay — plain class, runOnce(): claim -> publish -> stamp
    outbox-relay.service.ts            @Injectable NestJS wrapper: the interval loop + graceful shutdown
    outbox-relay.config.ts             poll interval, batch size, enabled flag, publish timeout
    kafka-fact-publisher.ts            kafkajs producer adapter (idempotent producer), key = correlationId
    kafka.config.ts                    brokers, clientId, the Orders fact topic constant
  infrastructure/messaging/
    idempotent-consumer.ts             IdempotentConsumer.runOnce(eventId, consumer, work)
    processed-events.repository.ts      the processed_events write, inside the caller's tx

apps/fulfillment/src/infrastructure/persistence/schema/outbox.schema.ts   same four changes, no runtime code
apps/billing/src/infrastructure/persistence/schema/outbox.schema.ts       same four changes, no runtime code

apps/orders/drizzle/0002_<name>.sql        the coordinated migration (orders already has 0000, 0001)
apps/fulfillment/drizzle/0001_<name>.sql   byte-identical body
apps/billing/drizzle/0001_<name>.sql       byte-identical body
```

**Layering.** `domain/` is untouched by this feature — not one file under `apps/orders/src/domain/` changes, which is the cleanest evidence that the outbox is an infrastructure concern and that `domain-model.md` §8 rule 5 holds. Ports live in `application/` because they are the application's requirement of the outside world; every adapter lives in `infrastructure/`. The `presentation/` layer gains nothing here: this feature has no controller, because a relay has no inbound message.

**Why the relay's core is a plain class.** `OutboxRelay` takes its collaborators through its constructor and carries **no NestJS decorator**; `OutboxRelayService` is the thin `@Injectable()` wrapper that owns the interval and the lifecycle hooks. That split buys three things: `runOnce()` is directly callable from a test without a Nest application context; the class can be imported by `apps/seed`'s integration spec (which spans all three databases and must not boot a Nest app) to prove the seeded databases have nothing to publish; and the loop's timing concerns stay out of the code that does the work.

## 3. The coordinated schema change

One migration per database, **identical body**, generated by `drizzle-kit` from three identical schema edits. Four changes to `outbox`; `processed_events` is **not touched** — its `(event_id, consumer)` unique index is already exactly what §6 needs.

```sql
ALTER TABLE `outbox` ADD `causation_id` char(36) NOT NULL;              -- §3.1, advisory 1
ALTER TABLE `outbox` ADD `seq` bigint unsigned NOT NULL AUTO_INCREMENT UNIQUE;  -- §3.2, advisory 2
ALTER TABLE `outbox` ADD `trace_parent` varchar(64);                     -- §3.3, nullable, reserved for feature 27
ALTER TABLE `outbox` MODIFY `occurred_at` datetime(3) NOT NULL;          -- §3.2, the read model's ordering key
CREATE INDEX `idx_outbox_unpublished_seq` ON `outbox` (`published_at`,`seq`);   -- §5.2
```

The existing `idx_outbox_published_occurred (published_at, occurred_at)` index **stays**. It is no longer the poll index, but it is exactly the index for the outbox-lag metric feature 27 must expose (`R59`: *"the age of the oldest unpublished outbox record"* = `SELECT MIN(occurred_at) FROM outbox WHERE published_at IS NULL`), and the three committed integration specs already assert it exists. Dropping it would break three tests to save nothing.

### 3.1 The `causationId` resolution — a column, not an envelope in `payload`

**Decision: `causation_id char(36) NOT NULL`, a promoted column in all three `outbox` tables.**

The alternative the advisory offered — redefine `payload` as the *complete envelope* rather than the fact body — is rejected:

| | New column (chosen) | Full envelope in `payload` |
|---|---|---|
| Agreement with the contract | `payload` keeps the meaning `asyncapi.yaml` gives it (`Envelope.payload` = *"the fact-specific body"*), and every envelope field is a typed, constrained column | `payload` would mean two different things — the wire's fact body and the store's whole envelope — with only a comment to tell them apart |
| Integrity | `NOT NULL char(36)`; a fact without causation cannot be committed | A JSON key can be absent, misspelled or null and nothing notices until a consumer tries to reconstruct a chain |
| Redundancy | None | `event_id`, `event_type`, `aggregate_id`, `correlation_id`, `occurred_at` would exist **twice** — as columns and inside the JSON — with nothing keeping the two copies in agreement. `outbox.event_id` carries a `UNIQUE` constraint that a JSON twin could silently contradict |
| Queryability | `WHERE causation_id = ?` walks a causal chain with an ordinary index | Requires JSON extraction; no constraint, no index without a generated column |
| Blast radius | One ALTER × 3 databases; three round-trip specs and the seed writers gain one field | Every existing seeded row is rewritten, the round-trip specs change meaning, and the relay's row → wire mapping becomes "trust the JSON" |

**Collateral work this creates**, all of it turned into tasks so none of it is discovered late:

1. **Three `migrations.integration.spec.ts` round-trips** (`apps/{orders,fulfillment,billing}/src/infrastructure/persistence/`) insert an `outbox` row through the typed Drizzle builder. They stop compiling the moment `causationId` is `NOT NULL`, and their `toMatchObject` assertions must include `causationId`, `seq` and `traceParent` or the round-trip stops proving the columns exist. Each also gains an assertion for the new `idx_outbox_unpublished_seq` index, in the style of the existing `information_schema` index assertion. Tasks A5–A7.
2. **The three `apps/seed` writers** (`orders-db.writer.ts`, `fulfillment-db.writer.ts`, `billing-db.writer.ts`) build outbox inserts field by field and will not typecheck without `causationId`. Task B3.
3. **`apps/seed/src/data/sagas.data.ts`** — `OutboxFixture` gains `causationId: string`, and the header comment that currently explains *why* causation is not written (lines 25–30) is replaced by the causal chain of §3.5. Tasks B1–B2.
4. **A warm database cannot take this migration.** `ADD COLUMN ... NOT NULL` with no default fails against a table that already has rows under strict `sql_mode`, and the seeded rows' causation cannot be derived in SQL. The accepted procedure is the one feature 13 already established for `order_items.description`: recreate (`docker compose down -v` → up → migrate → re-seed). Written into the tasks and into the progress file, not left to the reader.

### 3.2 The deterministic ordering key — a monotonic sequence, and a wider `occurred_at`

**Decision: `seq bigint unsigned NOT NULL AUTO_INCREMENT UNIQUE`, and the relay orders by `seq` alone.**

The reviewer's point is the decisive one: `DATETIME(3)` narrows the window in which two rows tie, it does not close it, and one transaction routinely writes several outbox rows *at the same instant by construction* — `payment.received.v1` and `credit.released.v1` are specified to be written together (`asyncapi.yaml`, `billingFacts` channel). A timestamp is the wrong tool for a total order. `AUTO_INCREMENT` gives a value that is assigned by the store at insertion, strictly increasing, and tie-free by construction.

*Why `seq` does not violate "identity is generated in the domain"* (`domain-model.md` §8 rule 3): `seq` is **not an identity**. `id` remains the domain-generated `char(36)` primary key and `event_id` remains the domain-generated envelope id. `seq` is a publication-ordering artefact of one write model's outbox; it never leaves infrastructure, never appears in an envelope, never crosses a service boundary and is never read by the domain.

*Why AUTO_INCREMENT needs its own key.* InnoDB requires an `AUTO_INCREMENT` column to be the leading column of **some** index; `UNIQUE (seq)` satisfies that and additionally states the truth (the sequence never repeats). The poll index `(published_at, seq)` is separate, because the poll filters on `published_at` first.

*The commit-order gap, stated plainly.* `AUTO_INCREMENT` values are assigned at INSERT, not at COMMIT, so a transaction holding `seq = 7` can commit after a transaction holding `seq = 8`. Two things make this harmless:

- **Per-`correlationId` order is preserved anyway.** Two transactions that write facts about the same order also mutate the same aggregate row, so the second blocks on the first's row lock and does not reach its outbox INSERT until the first has committed. Its `seq` values are therefore strictly higher *and* its commit is later. Cross-aggregate order is not claimed by anyone: `saga.md` §"Ordering guarantees" claims per-order ordering only, and explicitly disclaims global ordering.
- **The relay never uses `seq` as a cursor** (OI3, §5.2). A record that commits late is still `published_at IS NULL`, so the very next poll finds it. Gaps self-heal because the poll predicate is a nullability test, not a high-water mark. This is the single most important sentence about the poll and it is why the "skipped record" failure mode of cursor-based outbox relays cannot occur here.

**And separately, `occurred_at` becomes `datetime(3)`.** Not for the relay — `seq` orders that — but because `occurred_at` is what the relay copies into the published envelope, and `R50` makes the envelope's `occurredAt` the **only** ordering key the read model trusts. At second precision the two facts Billing writes in one transaction reach the projector with identical timestamps and the timeline's order becomes arbitrary — a defect visible in the demo UI. Three milliseconds of column width removes it. `published_at` and `created_at` stay `datetime(0)`: nothing orders by them.

### 3.3 `trace_parent` — one nullable column, added now, used by feature 27

**Flagged for the approval gate as the only speculative element of this migration.**

`asyncapi.yaml`'s `FactHeaders` makes `traceparent` a **required** header of every fact, and `R56`/`R57` require one trace to span HTTP → NATS → MySQL → Kafka → consumers. An outbox relay publishes on a different thread, in a different process moment, from the transaction that produced the fact; the *only* way to link the publication span to the producing trace is to store the W3C trace context **with the record**. Feature 27 will therefore need this column. Adding it now, nullable and unused, costs one line in a migration that is being coordinated across three databases anyway; adding it later costs a second three-database coordinated migration and another round of the collateral work in §3.4.

The cost of being wrong is one unused nullable column. If the gate prefers to keep the migration strictly to what this feature uses, drop the line — §7 records the consequence so feature 27 is not surprised.

**What this feature does with it:** writes `NULL`, and the relay emits `traceparent` **only** if the column is populated (it will not be) or an ambient trace context exists (it will not, until feature 27 installs the OTel SDK). Until then #7 knowingly publishes facts without the `traceparent` header that `FactHeaders` marks required — a documented, dated gap closed by feature 27, not a silently fabricated header. `x-event-type` and `content-type` are emitted from the first commit.

### 3.4 Three migrations, one shape — and the guard that keeps it that way

`apps/orders` already carries `0000` and `0001`, so the files are `apps/orders/drizzle/0002_*.sql`, `apps/fulfillment/drizzle/0001_*.sql` and `apps/billing/drizzle/0001_*.sql`. Numbering differs; **bodies must not**.

The three reviewers established that the outbox shape is byte-identical across the three databases and diffed it **by hand** (`progress/review_db_billing.md` §3: *"byte-identical in all six comparisons"*). This feature changes all three at once, which is exactly the moment that guarantee is most likely to break — so it stops being a manual reviewer chore and becomes a test (**OI11**): `apps/seed/src/outbox-parity.spec.ts` reads every committed `apps/*/drizzle/*.sql`, extracts every statement that mentions `outbox` or `processed_events`, normalises whitespace, and asserts the three resulting statement sets are equal. `apps/seed` is the right home: it is the one package that legitimately spans all three databases, and the test is pure text (no Docker, so it runs inside `pnpm quality`).

**Generated, not hand-written.** The SQL comes from `pnpm --filter @otc/<app> db:generate` after the schema file is edited, per the standing rule that a committed migration is generated and immutable. `AUTO_INCREMENT` on an added column is the one statement `drizzle-kit` may emit in a form MySQL rejects (the column must become a key in the same statement). The escape hatch is `drizzle-kit generate --custom`, which produces a numbered, empty migration for the author to fill — a first-class drizzle-kit feature, not a hand-edit of generated output. If it is needed, the task requires it to be recorded in the progress file with the exact `drizzle-kit` output that made it necessary.

### 3.5 The causal chain the seed must fabricate

`R12` says `causationId` is the `eventId` of the causing fact **or** the id of the causing command. In the running system the chain is exact (§4.4). The seed has no commands, so it needs a written rule rather than an improvisation:

| Seeded fact | `causationId` | Why |
|---|---|---|
| `order.placed.v1` | `deterministicId('order:<seq>:command:orders.create')` | Root of the saga: the cause is the `orders.create` command, and the seed fabricates a stable synthetic id for it |
| `stock.reserved.v1` / `stock.rejected.v1` | `eventId` of `order.placed.v1` | The fact that made the orchestrator issue `stock.reserve` |
| `credit.approved.v1` / `credit.rejected.v1` | `eventId` of `stock.reserved.v1` | Step 2 of `saga.md` §3.1 |
| `order.confirmed.v1` | `eventId` of `credit.approved.v1` | Step 3, emitted by Orders itself |
| `order.despatched.v1` | `eventId` of `credit.approved.v1` | Step 3's `despatch.create` command was issued on that fact |
| `invoice.issued.v1` | `eventId` of `order.despatched.v1` | Step 4 |
| `payment.received.v1` | `deterministicId('order:<seq>:command:payment.register')` | Second root: a remittance arrives from outside the saga |
| `credit.released.v1` (paid path) | `eventId` of `payment.received.v1` | Written in the same transaction, immediately after it |
| `stock.released.v1` (cancelled path) | `eventId` of `credit.rejected.v1` | `saga.md` §4.2 Path B: release, then cancel |
| `order.completed.v1` | `eventId` of `credit.released.v1` | Step 7 |
| `order.cancelled.v1` | `eventId` of `stock.released.v1` | The compensation that preceded it |

**A documented simplification:** for facts a responder emitted while handling an RPC command, the exact `causationId` is that command's `x-request-id` (§4.4). The seed does not fabricate command ids for intermediate steps, so it uses the **triggering fact's** `eventId` instead. The chain stays complete and reconstructible; it is one link shorter than a live saga's. This replaces the comment currently at `apps/seed/src/data/sagas.data.ts:25–30`, which exists only because the column did not.

## 4. The outbox writer

### 4.1 Where the transaction boundary lives

**In the application layer, expressed as a `UnitOfWork` port; opened by infrastructure.**

```ts
// apps/orders/src/application/ports/unit-of-work.port.ts
export const UNIT_OF_WORK = Symbol('UnitOfWork');

declare const transactionBrand: unique symbol;
/** An opaque handle to an open write-model transaction. The application layer passes it; only infrastructure looks inside. */
export interface TransactionContext {
  readonly [transactionBrand]: 'TransactionContext';
}

export interface UnitOfWork {
  /** Runs `work` inside one write-model transaction. Commits if it resolves, rolls back if it rejects, and never swallows the rejection. */
  execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
```

A command handler therefore reads:

```ts
await this.unitOfWork.execute(async (tx) => {
  const order = Order.place(input, { occurredAt: this.clock.now(), causationId: commandId });
  await this.orders.save(order, tx);            // aggregate row + order_items + outbox rows, all inside tx
  return order.id;
});
```

*Why an opaque branded type and not `MySql2Database`.* The port must not name Drizzle — the application layer would then depend on the adapter it is meant to abstract, and the `no-restricted-imports` intent of this repository would be satisfied only by the letter. The brand makes `TransactionContext` unforgeable in application code while carrying the real transaction at runtime. The single unavoidable cast lives in one function in `drizzle-unit-of-work.ts` (`asDrizzleTx(tx)`), is commented, and is the only place in the codebase where a `TransactionContext` is unwrapped.

*Why not `@Transactional()`-style AOP or an ambient async-local transaction.* Both hide the boundary — the most important line in `R13` becomes invisible at the call site, and a reviewer cannot see from a handler whether two writes share a transaction. An explicit parameter makes "same transaction" a compile-time fact.

*Why not put the boundary in the repository (`save` opens its own transaction).* Then `R17` is unsatisfiable: a consumer must write its dedup record, its aggregate change and its outbox records in **one** transaction spanning two collaborators. The boundary has to be above the repository.

### 4.2 The repository port — the promised revision, made explicit

`specs/orders_aggregate/design.md` §8 recorded the port as *"provisional in one respect: feature 14 will add a transactional-context parameter (`save(order, tx)` or a unit-of-work wrapper). That is recorded here as expected, not as drift."* This feature **honours that promise and takes the first of the two options**:

```ts
// apps/orders/src/application/ports/order-repository.port.ts  (final shape)
export const ORDER_REPOSITORY = Symbol('OrderRepository');

export interface OrderRepository {
  /** Reads outside a transaction by default; pass `tx` to read your own uncommitted writes. */
  findById(id: UniqueId, tx?: TransactionContext): Promise<Order | null>;
  findByReference(reference: OrderNumber, tx?: TransactionContext): Promise<Order | null>;
  /**
   * Persists the aggregate AND drains its uncommitted domain events into the outbox, inside `tx`.
   * Never opens a transaction of its own — `tx` is required, not optional (R13).
   */
  save(order: Order, tx: TransactionContext): Promise<void>;
}
```

`tx` is **required** on `save` and **optional** on the two reads. That asymmetry is deliberate: a read is legitimately performed outside a transaction (the saga loads an order to inspect it), whereas a write outside a transaction is precisely the dual-write `R13` forbids — so the type system, not a code review, refuses it.

### 4.3 The adapter — a *revision* of `orders_aggregate` §8, argued rather than assumed

`specs/orders_aggregate/design.md` §8 deferred the Drizzle `OrderRepository` **adapter** to feature 15 for three reasons. Re-read against this feature, they no longer hold:

- Reason **(a)** — *"`save` would have to be written twice, once without a transaction/outbox and once with, and the intermediate version would be untestable against R13"*. This now argues the opposite way: written here, `save` is written **once**, with its transaction and its outbox, and it is testable against `R13` immediately. Deferring it to 15 is what would create an intermediate version.
- Reason **(b)** — the missing `order_items.description` column — was already withdrawn; the column landed in feature 13.
- Reason **(c)** — *"it would require Testcontainers in a feature whose acceptance criterion is 'pure domain unit tests, zero framework imports'"* — was a statement about **feature 13's** acceptance. Feature 14 is a Testcontainers feature by nature: `R13` cannot be proven without a real transaction against a real store.

**Decision: `DrizzleOrderRepository` lands here, bounded.** It implements `save`, `findById` and `findByReference`, plus the row ↔ aggregate mapping of `orders_aggregate` §9 (business codes ↔ reference-table ids, resolved inside the adapter). It does **not** allocate order numbers, does not talk to NATS and does not know what a command is — all of that stays in feature 15, which now builds the `orders.create` flow on an adapter that already exists and is proven against MySQL. The revision is recorded in the open-points table so it is auditable as a decision, not as drift.

*Upsert semantics.* `save` upserts: `INSERT ... ON DUPLICATE KEY UPDATE status, cancellation_reason, notes, updated_at` for the `orders` row, and the same per `order_items` row keyed by line id. No `isNew` flag is needed, and — usefully — `save` becomes idempotent, which is the behaviour a saga retry wants. Lines are immutable after `confirmed` (**O4**), so rewriting them is a no-op in every path that matters; the cost is a handful of rows per save and is accepted.

### 4.4 From pulled events to outbox rows

The repository — not the handler — drains the aggregate:

```ts
// apps/orders/src/infrastructure/outbox/outbox-recorder.ts
export class OutboxRecorder {
  constructor(private readonly clock: Clock) {}
  /** Appends one outbox row per envelope, in array order, inside `tx`. Assigns no sequence — the store does (§3.2). */
  async record(tx: TransactionContext, events: readonly DomainEventEnvelope[]): Promise<void>;
}
```

| Outbox column | Source | Note |
|---|---|---|
| `id` | `UniqueId.generate()` | The **row** id, deliberately distinct from `event_id`: the row is a publication attempt record, the event is a domain fact |
| `event_id` | `envelope.eventId` | Generated in the domain at event creation (`domain-model.md` §7.1), `UNIQUE` — a dual-write bug fails loudly |
| `event_type`, `aggregate_id`, `correlation_id`, `causation_id`, `occurred_at` | the envelope, verbatim | No transformation, no defaulting (**OI1**) |
| `payload` | `envelope.payload` | The fact **body** only, typed by the per-fact payload types of `@otc/contracts` at the point the aggregate built it |
| `published_at` | `null` | The relay's job (**R14**) |
| `trace_parent` | `null` | Feature 27 (§3.3) |
| `created_at` | `clock.now()` | Through the `Clock` port, so tests control time |
| `seq` | *omitted* | Assigned by the store (§3.2) |

*Ordering inside one transaction.* `pullDomainEvents()` returns events in append order and the recorder inserts them in that order, so `seq` reflects the aggregate's emission order. This is what makes `asyncapi.yaml`'s promise about `payment.received.v1` preceding `credit.released.v1` true in feature 22 without any extra mechanism.

*Where `@otc/contracts` is used.* Two places, in two directions. **Writing:** the aggregate builds `payload` typed as `OrderPlacedPayload` etc. (feature 13, already done), so a payload that does not match the AsyncAPI schema is a compile error before it ever reaches a row. **Publishing:** the relay assembles the row into the generated `Envelope` type (`export type { Envelope, FactHeaders } from '@otc/contracts'`), so the wire shape is the generated contract and a change to `asyncapi.yaml` breaks the build rather than the consumers. `Envelope.occurredAt` is an `Instant` (ISO-8601 string), so the row's `Date` is rendered `toISOString()` exactly once, in the relay.

*The drained-events hazard (**OI9**).* `pullDomainEvents()` is destructive: after a rollback, the in-memory aggregate has already lost its events, and a naive retry using the same instance would commit an aggregate row with **no** outbox row — a silent dual-write in the other direction. The rule is therefore explicit and tested: **a failed unit of work invalidates the aggregate instances it touched; a retry re-loads (or re-creates) the aggregate and re-derives its events.** The alternative — adding a non-destructive `uncommittedEvents` getter to `packages/shared-kernel` and clearing only after commit — was considered and rejected here: `AggregateRoot` is kernel code whose semantics `orders_aggregate` already froze, the fix would spread commit-awareness into the domain base class, and the hazard is fully covered by an integration test at the level where it can actually bite.

## 5. The relay publisher

### 5.1 Shape

```ts
export interface OutboxRelayResult { readonly claimed: number; readonly published: number }

export class OutboxRelay {                       // plain class — no decorator (§2)
  constructor(deps: { db: OrdersDb; outbox: typeof outboxTable; publisher: FactPublisher; clock: Clock; config: OutboxRelayConfig; logger: Logger });
  /** One complete cycle: claim -> publish -> stamp, in one write-model transaction. Returns what it did. */
  runOnce(): Promise<OutboxRelayResult>;
}
```

`OutboxRelayService` (`@Injectable()`, `OnApplicationBootstrap` / `OnApplicationShutdown`) drives `runOnce()` on a **self-scheduling** `setTimeout` chain rather than `setInterval`: the next cycle is scheduled only when the previous one settles, which is what makes overlapping cycles structurally impossible (**OI6**) instead of merely unlikely. Shutdown clears the pending timer and awaits the in-flight cycle. `@nestjs/schedule` is deliberately not added — it is a dependency for one interval, and its intervals overlap under a slow tick, which is the exact failure this design refuses.

The service is enabled by `OUTBOX_RELAY_ENABLED` (default `true`), so a deployment that scales the Orders service out can still run exactly one relay.

### 5.2 The poll, the claim, and the ordering key

One transaction per cycle:

```sql
-- 1. claim
SELECT id, event_id, event_type, aggregate_id, correlation_id, causation_id, payload, occurred_at, trace_parent
FROM outbox
WHERE published_at IS NULL
ORDER BY seq ASC
LIMIT :batchSize
FOR UPDATE SKIP LOCKED;

-- 2. publish to Kafka, await acknowledgement  (no SQL)

-- 3. stamp
UPDATE outbox SET published_at = :now WHERE id IN (:ids);
-- COMMIT
```

- **Predicate:** `published_at IS NULL`. Never a stored cursor (**OI3**) — see §3.2 for why that is the property that makes late-committing rows safe.
- **Order:** `seq ASC`, the tie-free insertion sequence (**OI2**, advisory 2 resolved). Not `occurred_at`, which ties by construction; not `id`, which is a random UUID and has no relation to insertion order.
- **Index:** `idx_outbox_unpublished_seq (published_at, seq)` turns this into a range scan over the `NULL` prefix, already ordered by `seq` — no filesort, and the scan never touches the (large, growing) published tail.
- **Claim:** `FOR UPDATE SKIP LOCKED` (MySQL 8.0+; the pinned `mysql:8.4.11` supports it). Two relay instances take **disjoint** batches; neither blocks the other and neither can claim the same row (**OI4**).

**Why `SKIP LOCKED` and not a claim column.** The rejected alternative is a lease: `UPDATE outbox SET claimed_by = ?, claimed_at = NOW() WHERE published_at IS NULL AND (claimed_at IS NULL OR claimed_at < :leaseCutoff) ORDER BY seq LIMIT n`, then select the claimed rows.

| | `FOR UPDATE SKIP LOCKED` (chosen) | Lease columns |
|---|---|---|
| Schema cost | none | two more columns × **three** databases (§3.4), on a table three reviewers just certified as byte-identical |
| Crash recovery | the connection drops, InnoDB releases the locks, the rows are claimable on the very next poll — **no operator action, no wait** (**OI5**) | rows stay invisible until the lease expires; recovery latency is a tunable that can be set wrong, and a stale-lease sweeper becomes another moving part |
| Correctness of the tunable | none to get wrong | a lease shorter than a slow publish causes **double publication by design** |
| Cost | the transaction stays open across the broker round-trip | none |

The accepted cost is the open transaction. It is bounded by `OUTBOX_BATCH_SIZE` (default 100) and by the producer's `OUTBOX_PUBLISH_TIMEOUT_MS` (default 5 000), it holds locks only on the claimed rows (`SKIP LOCKED` means no other relay waits on them), and it never blocks a writer, because writers only INSERT.

### 5.3 Publishing

```ts
// apps/orders/src/application/ports/fact-publisher.port.ts
export const FACT_PUBLISHER = Symbol('FactPublisher');
export interface PublishableFact {
  readonly key: string;                        // the partition key = correlationId (R15)
  readonly envelope: Envelope;                 // the generated @otc/contracts type
  readonly headers: Readonly<Record<string, string>>;
}
export interface FactPublisher {
  /** Resolves only when the broker has acknowledged every fact; rejects otherwise. Never partially reports success. */
  publish(facts: readonly PublishableFact[]): Promise<void>;
}
```

- **One topic per service.** Orders publishes to `otc.orders.facts.v1` — every fact in `apps/orders`'s outbox belongs to that topic by construction, so a cycle is a single `producer.send`. The topic name is a constant in `kafka.config.ts` guarded by a unit test that reads `specs/shared/asyncapi.yaml` and asserts the `ordersFacts` channel's `bindings.kafka.topic` equals it — the same "never hardcode a topic, derive it from the spec" discipline `infra/kafka/create-topics.sh` established, without adding a YAML parser to a service. (A generated `TOPICS` constant in `@otc/contracts` would be nicer still and is recorded as an open point, not done here.)
- **Key = `correlationId`** (`R15`). Kafka's default partitioner hashes the key, so every fact about one order lands on one partition and is read in publication order, whatever the partition count (`create-topics.sh` uses 6).
- **Idempotent producer** (`kafka.producer({ idempotent: true })`, which pins `acks = -1` and `maxInFlightRequests = 1`) — **OI7**. Without it, a client-internal retry can both duplicate a record the broker already accepted and reorder a partition, which would silently break `R15` in a way no test of *our* code would catch.
- **Headers:** `x-event-type` (mirrors `envelope.eventType`, so a consumer filters without deserialising — the cost of topic-per-service) and `content-type: application/json`. `traceparent` per §3.3.
- **Stamp after acknowledgement, never before** (`R14`). If `publish` rejects, the transaction rolls back, **nothing** is stamped, and the same batch is retried on the next poll (**OI8**). Partial success inside a rejected batch is possible and is **accepted**: this is at-least-once, and de-duplication is the consumer's job (§6). Saying that out loud is the point — `saga.md` §6's three layers exist precisely because this system does not pretend to exactly-once delivery.
- **kafkajs, not `@nestjs/microservices`, for the producer.** The relay needs explicit control of the key, the idempotent-producer flags and the acknowledgement point; `ClientKafka` wraps kafkajs and abstracts exactly those away. Consumers (features 16, 24, 23) will use `@nestjs/microservices` `@EventPattern`, as `CLAUDE.md` prescribes — the asymmetry is deliberate and recorded.

## 6. The idempotent-consumer pattern

### 6.1 The shape

```ts
// apps/orders/src/infrastructure/messaging/idempotent-consumer.ts
export type ConsumptionOutcome = 'processed' | 'duplicate';

export class IdempotentConsumer {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly clock: Clock) {}

  /**
   * Runs `work` at most once for (eventId, consumer):
   *   BEGIN
   *     INSERT INTO processed_events (id, event_id, consumer, processed_at, created_at)   -- FIRST
   *     -> duplicate key ? ROLLBACK and return 'duplicate' without calling `work`         (R18)
   *     await work(tx)                                                                    -- effects + outbox rows
   *   COMMIT                                                                              (R17)
   */
  runOnce(eventId: string, consumer: ConsumerName, work: (tx: TransactionContext) => Promise<void>): Promise<ConsumptionOutcome>;
}
```

`ConsumerName` is the closed union `'orders.saga' | 'projector' | 'notifications'` (`specs/shared/requirements.md` § Vocabulary), so a typo cannot create a second, silently-empty dedup namespace. The column is `varchar(50)`.

**Insert the dedup record first, then do the work.** Both orders are transactionally equivalent, but insert-first is better twice over: it fails fast on the common redelivery path without touching any aggregate, and it takes the unique-index lock **before** the effects, so two concurrent deliveries of the same event serialise — the second blocks on the index until the first commits, then receives `ER_DUP_ENTRY` (1062) and reports `duplicate` (**OI10**). A read-then-write check (`SELECT ... ; if absent INSERT`) has no such property and would let both deliveries pass under `READ COMMITTED`; the unique index is the guarantee, and the `SELECT` is not even performed.

**What the caller does with the outcome.** `duplicate` → acknowledge the message, mutate nothing, emit nothing, issue nothing (`R18`). `processed` → acknowledge. A rejection → do **not** acknowledge; this is where feature 27's retry/DLQ wrapper attaches (§7). This feature returns an outcome and lets the caller decide, because the caller (a Kafka `@EventPattern` handler) does not exist yet.

### 6.2 How it composes with the handler's own transaction

The handler never opens a transaction; it receives one. A saga handler in feature 16 will read:

```ts
const outcome = await this.idempotency.runOnce(envelope.eventId, 'orders.saga', async (tx) => {
  const order = await this.orders.findById(orderId, tx);
  order.markStockReserved({ occurredAt, causationId: envelope.eventId });
  await this.orders.save(order, tx);            // aggregate + outbox, same tx as the dedup row (R17)
});
```

One transaction contains the dedup record, the aggregate change and the outbox records. That is `R17` literally, and it is why the `UnitOfWork` boundary had to sit above the repository (§4.1).

### 6.3 Where this code lives, given that shared runtime code is forbidden

`CLAUDE.md` is unambiguous: *"The only shared runtime code is `packages/shared-kernel` (dependency-free) and `packages/contracts` (generated types). Nothing else is shared."* Five components will eventually need this pattern (orders, fulfillment, billing, projector, notifications). The options, and why the third wins:

| Option | Verdict |
|---|---|
| Put `IdempotentConsumer` in `packages/shared-kernel` | **Rejected.** The kernel is dependency-free *domain* code — value objects and the aggregate base. This class exists to talk to a store. Even the store-agnostic half would drag an infrastructure concept into the one package `orders_aggregate` deliberately kept pure, and #8/#9 have no equivalent. |
| Create `packages/messaging` | **Rejected** — it is exactly the third shared runtime package the non-negotiable forbids, and it would couple five services' release cadence together for ~80 lines. |
| **Per-service copies of a small pattern** | **Chosen.** `idempotent-consumer.ts` + `processed-events.repository.ts` are ~80 lines against a table that is *already* duplicated per service by the database-per-service rule. The duplication is deliberate, bounded and honest: each service owns its own dedup ledger, and nothing links their deployments. |

Only the **Orders** copy is written in this feature, as the reference implementation, together with the tests that prove it. Features 17–22 copy it into fulfillment and billing when they gain their first consumer. Two seams are recorded now so those features do not re-decide:

- **The projector (feature 24) has no MySQL.** Its dedup ledger is a MongoDB `processed_events` collection with a unique index on `(eventId, consumer)` and a single-document upsert; the *pattern* (record first, effects second, duplicate ⇒ no-op) transfers unchanged, the transaction does not. `R51` already anticipates this.
- **Notifications (feature 23) has no store at all** in `docker-compose.infra.yml`. `R17` requires a dedup record in the same transaction as the effects, and sending an email is not transactional. Feature 23 must choose a store or an explicitly-argued weaker guarantee; flagged here, decided there.

The duplication is accepted, but it is **not** left to discipline — §6.4 turns it into a check.

### 6.4 The parity guard for the copies (**OI12**)

Five hand-copied files drift. That is not a risk to be managed by good intentions, and the resolution of §3.4 already invented the right instrument for exactly this shape of problem: a pure-text test that reads the committed artefacts of every service and asserts they agree. What worked for three migration bodies works for the pattern copies, so this feature specifies the same trick a second time.

**What is compared: a designated canonical copy, byte-identical after the banner.**

`apps/orders/src/infrastructure/messaging/idempotent-consumer.ts` and its sibling `processed-events.repository.ts` are the **canonical** copies — §6.3 already calls the Orders pair "the reference implementation", and this makes that word load-bearing. Every other MySQL write model's copy must be **byte-identical** to the canonical, including whitespace and comments, after exactly **one** normalisation: the **banner** — the file's leading run of contiguous `//` lines, up to the first line that is not a comment — is removed from both sides before comparison.

| Option | Verdict |
|---|---|
| Whole-file byte identity, no normalisation | **Rejected.** It forbids the one per-service difference actually worth having: a copy that says it is a copy. A developer who lands in `apps/billing/.../idempotent-consumer.ts` must be told, in that file, that it may not be edited in place. |
| A forgiving normalisation (strip all comments, rename service tokens, compare identifiers or ASTs) | **Rejected.** Every normalisation rule is a licence to drift, and the drift it would forgive is the worst kind: a comment that still states a rule the code no longer follows. The more the comparison forgives, the less it guards. |
| **A designated canonical copy, byte-identical after the banner** | **Chosen.** The strictest rule that is still satisfiable. It has one further virtue: it is only satisfiable if the pattern is genuinely service-agnostic, which turns a property of the test into a constraint on the code (below). |

**The constraint this places on the two pattern files.** Byte-identity is only achievable if nothing outside the banner names a service. Concretely:

- **No service-named type.** `processed-events.repository.ts` may not mention `OrdersDb`, `FulfillmentDb` or `BillingDb`. It receives its transaction as the opaque `TransactionContext` of §4.1 and unwraps it through the single `asDrizzleTx` of `drizzle-unit-of-work.ts` — which is the rule §4.1 already states, now enforced by a test rather than by review.
- **Only portable import specifiers.** Every `import` in the two files must resolve to the same relative path in every service tree. The whitelist is exactly: `../../application/ports/unit-of-work.port`, `../../application/ports/clock.port`, `../../application/ports/consumer-name`, `../persistence/schema/processed-events.schema`, `../persistence/drizzle-unit-of-work`, `@otc/shared-kernel`, `drizzle-orm`. This is satisfiable today: all three services already export `processedEvents` from an identically-named file at an identical path (verified against the three committed `processed-events.schema.ts`), and the ports of group C are per-service files at identical paths.
- **Service-naming prose belongs in the banner.** A comment that wants to say "the saga handler of feature 16 subscribes through this" names a service and therefore lives in the banner, which is the one region that is *expected* to differ per copy.

**The banner, being excluded from the comparison, is held to a shape rule instead.** Every copy must have one (first line begins `//`), and a non-canonical copy's banner must contain the literal path `apps/orders/src/infrastructure/messaging/idempotent-consumer.ts` — so the file both declares itself a copy and points at the copy that governs it.

**Where the test lives: beside the canonical copy, not in `apps/seed`.**

`apps/seed/src/idempotent-consumer-parity.spec.ts` was considered and rejected. §3.4's claim on `apps/seed` is precise and does not extend here: seed is *"the one package that legitimately spans all three **databases**"*, and the artefacts it compares there — committed migration SQL — are database artefacts that `apps/seed` genuinely depends on. The pattern copies are neither database artefacts nor a set of three: they span **five** components, and two of them (`projector`, `notifications`) `apps/seed` does not seed, does not import and has no relationship with. Making the seeder the custodian of source files belonging to services it never touches buys nothing and costs the reader an explanation.

The honest home is next to the thing it certifies:

```
apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts
```

The canonical copy owns its own guard. A developer editing `idempotent-consumer.ts` gets a red spec **in the same directory as the edit**, which is where the mistake is being made — not in a package they were not thinking about. The test reads the other copies as **text** through `node:fs` (repo-root-relative, resolved by walking up from `import.meta.url` to the directory holding `pnpm-workspace.yaml`, so the result does not depend on Vitest's cwd), so it creates no build dependency, needs no `tsconfig` `include` entry, adds no package, boots no container, and runs inside `pnpm quality` — the same properties §3.4 required of the SQL parity test. Apps are enumerated with `readdirSync('apps')`, not with a glob library: no new dependency (§8's package table is unchanged by this amendment).

**How it behaves while only the Orders copy exists.** This feature writes one copy; features 17–22 add the rest. A parity test over a set of one is vacuous, so the spec is a set of **four** cases, of which two are meaningful today and two arm themselves structurally as the copies appear. None of them can pass silently forever with a single copy.

| # | Case | Set it ranges over | State today (one copy) |
|---|---|---|---|
| 1 | *holds every write model's copy of the idempotent-consumer pattern byte-identical to the canonical copy* | apps that have **both** `src/infrastructure/persistence/schema/processed-events.schema.ts` (i.e. a MySQL dedup ledger) **and** `src/infrastructure/messaging/idempotent-consumer.ts` | one member, so it asserts only that the canonical equals itself — and says so in its own failure message. Arms at the second copy (feature 17) |
| 2 | *keeps the canonical copy adoptable verbatim, naming no service and importing nothing service-specific* | the canonical pair alone | **fully meaningful now.** Asserts the banner-stripped text of both files matches no `\b(orders\|fulfillment\|billing\|projector\|notifications)\b` (case-insensitive) and that every import specifier is in the whitelist above. This is the anti-vacuity case: at n = 1 the guard still fails the day someone writes `OrdersDb` into the pattern |
| 3 | *requires a copy of the pattern from every write model that consumes facts* | every `apps/*` carrying a MySQL `processed_events` schema | **fully meaningful now**, and self-arming: an app that carries the schema **and** any `@EventPattern` in `src` must carry the copy. Orders, fulfillment and billing carry the schema and no `@EventPattern` yet, so today the case asserts a computed empty set of violations, and it turns red the moment feature 17 gives a service a consumer without giving it the pattern |
| 4 | *requires a documented divergence banner from a copy that cannot share the canonical's transaction* | any `apps/*/src/**/idempotent-consumer.ts` in an app **without** a MySQL `processed_events` schema — i.e. the projector's Mongo variant and whatever feature 23 chooses | dormant (no such file exists). Arms at features 23/24. A variant is **never** compared to the canonical — it cannot be, §6.3 — but its banner must cite the canonical path and carry a line beginning `Divergence:` stating what it does differently and why |

The discriminator between "copy" and "variant" is *"does this app own a MySQL `processed_events` table"*, read from the filesystem — not a hand-maintained list of app names. That is deliberate: a registry that must be edited when a copy is added is a registry someone forgets to edit, and the drift then hides in the very file that was supposed to reveal it.

**Not a promotion candidate.** `OI12` guards a duplication that exists only because *this* assessment's `CLAUDE.md` forbids a third shared runtime package. #8 (.NET) can put the pattern in one shared project and #9 (FastAPI) in one shared module, at which point there is nothing to keep in parity. It stays local, and `requirements.md` §5 says so.

## 7. Retry and DLQ — exactly what this feature does and does not do

**Does:**

- Retries **publication** indefinitely, by construction: an unstamped record is retried on every poll until the broker accepts it (`R14`, **OI8**). There is no attempt counter and no give-up.
- Logs every publication failure as structured JSON with `correlationId` and `eventId` (the shape `R58` will formalise).
- Returns `'processed' | 'duplicate'` from the consumer pattern, and **rejects** on handler failure, leaving the decision to acknowledge or retry to the caller.

**Does not:**

- No consumer-side retry with backoff, no attempt counting, no `<topic>.dlq` publication, no `x-failed-consumer` / `x-attempts` / `x-error` headers. That is **`R16`**, owned by feature 27 (`feature_list.json` #27: *"failed processing lands on `<topic>.dlq` after N attempts"*).
- No metrics. Outbox lag and dead-letter depth are `R59`, feature 27. The `(published_at, occurred_at)` index this feature preserves is the one that query needs (§3).
- No trace propagation. `R56`/`R57` are feature 27; the `trace_parent` column is provisioned (§3.3) so that feature does not need a fourth coordinated migration.

**The seam feature 27 attaches to**, stated so it is not re-derived:

1. **Consumer side:** wrap `IdempotentConsumer.runOnce(...)`. A rejection is already the failure signal; feature 27 adds attempts, backoff and the dead-letter publication around it, and only then acknowledges. Nothing in §6 needs to change.
2. **Relay side:** a permanently unpublishable record (a payload the broker rejects outright) blocks its batch, and therefore its database's outbox, forever — `seq` ordering means the head of the queue is retried first every time. This is the **correct** default (a fact must not be skipped or reordered, **OI8**), and it is loud (outbox lag climbs, the error logs repeat). If feature 27 decides to bound it, the mechanism is an `attempts` column and an outbox dead-letter path — and that is another three-database coordinated migration, which is why it is written down here rather than discovered then.
3. **Headers:** the publisher already builds a header map; feature 27 injects `traceparent`/`tracestate` into it and populates `trace_parent` at record time.

## 8. Configuration and new dependencies

| Setting | Default | Where |
|---|---|---|
| `OUTBOX_RELAY_ENABLED` | `true` | `.env.example`, `outbox-relay.config.ts` |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | idem — small enough that the demo feels immediate, large enough not to hammer MySQL when idle |
| `OUTBOX_BATCH_SIZE` | `100` | idem — bounds how long the claim transaction stays open (§5.2) |
| `OUTBOX_PUBLISH_TIMEOUT_MS` | `5000` | idem — the producer's acknowledgement budget; also bounds the open transaction |
| `KAFKA_BROKERS` | `localhost:9092` | `.env.example`, `kafka.config.ts`; `kafka:29092` inside compose (the existing `KAFKA_INTERNAL_HOST`/`KAFKA_HOST_PORT` vars stay the source of truth for the broker itself) |
| `KAFKA_CLIENT_ID` | `otc-orders` | idem |

`specs/shared/requirements.md` §10 leaves these numbers explicitly to each assessment's design; this table is #7's answer.

**New packages** (each must appear in the feature's commit message, per `CLAUDE.md`):

| Package | Where | Purpose |
|---|---|---|
| `kafkajs` | catalog + `apps/orders` dependency | The relay's producer. Already anticipated by `eslint.config.mjs`, which bans it from `domain/` |
| `@testcontainers/kafka` | catalog + `apps/orders` devDependency | Real Kafka in the relay integration tests (§9) |

## 9. Testing approach

**Levels, and what each may touch** (`specs/shared/test-matrix.md` § Test levels):

| File | Level | Runner/config | Proves |
|---|---|---|---|
| `apps/orders/src/infrastructure/outbox/outbox-relay.spec.ts` | unit | `vitest.config.mts` (in `pnpm quality`) | **OI6** — the loop never overlaps. Fake publisher, fake claim source, controllable clock; no Docker |
| `apps/orders/src/infrastructure/outbox/kafka-fact-publisher.spec.ts` | unit | idem | **OI7** — the producer is constructed idempotent, `acks = -1`, one in-flight request; asserted on the config object, not by mocking a broker |
| `apps/seed/src/outbox-parity.spec.ts` | unit | idem | **OI11** — the three committed migration sets define `outbox`/`processed_events` identically |
| `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` | unit | idem | **OI12** — the per-service copies of the consumer pattern agree with the canonical, and the canonical stays adoptable verbatim (§6.4) |
| `.../outbox-atomicity.integration.spec.ts` | integration | `vitest.integration.config.mts` — Testcontainers **MySQL `mysql:8.4.11`** | **R13**, **OI9** |
| `.../outbox-envelope.integration.spec.ts` | integration | idem | **R12**, **OI1** |
| `.../outbox-relay.integration.spec.ts` | integration | MySQL **+ Kafka `apache/kafka:4.3.1`** | **R14**, **OI2**, **OI3**, **OI8** |
| `.../fact-partitioning.integration.spec.ts` | integration | idem | **R15** — one partition per order, emission order preserved, read back through a real consumer |
| `.../outbox-relay-concurrency.integration.spec.ts` | integration | MySQL (fake publisher — the point is the claim, not the broker) | **OI4**, **OI5** |
| `apps/orders/src/infrastructure/messaging/idempotent-consumer.integration.spec.ts` | integration | MySQL | **R17**, **R18**, **OI10** |
| `apps/seed/src/seed.integration.spec.ts` (extended) | integration | the existing three-MySQL + Mongo fixture | the relay finds **zero** unpublished records in all three seeded databases |

**Real Kafka in this repository for the first time.** The image is `apache/kafka:4.3.1` — the **same pinned tag** as `docker-compose.infra.yml:91`, following the convention `db_orders` set for MySQL (`mysql:8.4.11`, asserted by the reviewer as *"the same pinned tag as `docker-compose.infra.yml`"*). Rules for the implementer:

- Never a different image or a floating tag. If `@testcontainers/kafka`'s `KafkaContainer` cannot drive `apache/kafka:4.3.1` directly, fall back to `GenericContainer` with **that same tag** and explicit KRaft environment — never to `confluentinc/cp-kafka` or `latest`.
- Create the topic explicitly through the kafkajs admin client with the same **6 partitions / replication factor 1** `infra/kafka/create-topics.sh` uses, rather than relying on broker auto-creation (which yields one partition and would make the `R15` partitioning test vacuous).
- Kafka integration specs stay in `vitest.integration.config.mts` (out of `pnpm quality`), which is the decision `progress/impl_db_orders.md` §Decisions 5 recorded and the two later `db_*` features followed. `testTimeout`/`hookTimeout` already 120 s; a cold Kafka pull may need more — raise it in the config with a comment, do not `skip`.

**Determinism note for the seed.** `seq` is store-assigned, so it is **excluded** from the seed's determinism assertions (`apps/seed/src/deterministic.spec.ts` and the `verify` path). `causationId` is derived from `deterministicId(...)` and **is** asserted, like every other seeded id.

## 10. Out of scope — restated, because these are the natural next questions

- **NATS**: no client, no subject, no handler. Feature 15.
- **The saga orchestrator and every Kafka consumer**: feature 16 (and 23, 24). This feature builds the *primitive* a consumer uses, and proves it by calling it directly.
- **`R16` retry/backoff/DLQ**: feature 27 (§7).
- **The domain layer**: unchanged, deliberately (§2).
