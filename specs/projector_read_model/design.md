# `projector_read_model` — Design (NestJS / TypeScript / MongoDB, assessment #7)

> Stack-specific. Everything here is #7's realisation of `R50` – `R55`; nothing here belongs in `specs/shared/`. Read with [`requirements.md`](./requirements.md) (`PR1` – `PR28`) open.

---

## 1. Scope

`apps/projector` today is a four-file scaffold: a bare `AppModule`, a health `AppController`, a `main.ts` that only calls `app.listen`. This feature turns it into the third fact consumer in the system and the **only** writer of the MongoDB read model.

It consumes **all thirteen** facts — the first consumer that must (`domain-model.md` §7.3: the orchestrator takes ten, Notifications seven). It maintains one denormalised document per order in `otc_read_model.order_timeline`. It publishes an update signal. It answers nothing.

The closest reference implementation is **`apps/notifications`**, which landed immediately before this: the same "consume only, no outbox, no responder" shape, the same `kafka.config.ts` topic constants with a text-scan guard, the same hybrid-app `main.ts`, the same `useFactory`-everywhere module. The one place this feature deliberately departs from it is the idempotency ledger — §9.

---

## 2. Where everything lives

```
apps/projector/src/
├── main.ts                                    ← + Kafka transport, + Mongo index bootstrap, + NATS connect
├── app.module.ts                              ← CqrsModule.forRoot() + useFactory wiring
├── domain/                                    ← ZERO framework/driver imports (PR28)
│   ├── projection-delta.ts                    ← the store-agnostic value infrastructure translates
│   ├── order-status-rank.ts                   ← PR12's table + `rankOf`, `impliedStatusOf`
│   ├── fact-projection.ts                     ← `projectFact(envelope): ProjectionDelta` — the thirteen-way switch
│   ├── summaries.ts                           ← the thirteen `summary`/`detail` builders (PR16)
│   └── money-format.ts                        ← minor units + currency → text. No float, ever.
├── application/
│   ├── ports/
│   │   ├── clock.port.ts                      ← copied shape; used for logging only, never for a document field
│   │   ├── consumer-name.ts                   ← CONSUMER_NAMES = ['projector'] as const
│   │   ├── read-model-writer.port.ts          ← READ_MODEL_WRITER — the only write surface
│   │   └── update-signal.port.ts              ← UPDATE_SIGNAL_PUBLISHER
│   ├── commands/
│   │   ├── project-fact.command.ts            ← one command (PR27)
│   │   └── project-fact.command-handler.ts    ← one @CommandHandler, delegation only
│   └── projection-apply.service.ts            ← delta → writer → signal; owns PR18/PR19's ordering
├── infrastructure/
│   ├── messaging/
│   │   ├── kafka.config.ts                    ← the three topic constants + group id (copied shape)
│   │   ├── idempotent-consumer.ts             ← THE VARIANT (PR23/PR24). Banner is load-bearing.
│   │   ├── idempotent-consumer.parity.integration.spec.ts   ← named by that banner; must exist
│   │   └── test-support/idempotent-consumer-conformance.ts  ← copied verbatim from apps/orders
│   ├── persistence/
│   │   ├── mongo.config.ts                    ← same shape as apps/seed/src/mongo-config.ts
│   │   ├── mongo-client.ts                    ← the only value-import of `mongodb` besides the writer
│   │   ├── order-timeline.document.ts         ← the document type (§3)
│   │   ├── delta-to-pipeline.ts               ← ProjectionDelta → aggregation-pipeline stages (§5)
│   │   ├── mongo-read-model-writer.ts         ← implements ReadModelWriter over the variant
│   │   └── read-model-indexes.ts              ← PR22
│   ├── signal/
│   │   ├── nats.config.ts                     ← copied from apps/orders
│   │   ├── nats-client.ts                     ← copied shape; the only value-import of `nats`
│   │   └── nats-update-signal.publisher.ts    ← PR17
│   └── system-clock.ts
└── presentation/
    ├── app.controller.ts                      ← unchanged health endpoint
    └── projector-facts.controller.ts          ← three @EventPattern(..., Transport.KAFKA)
```

Root-level guard specs (the `apps/notifications` precedent): `projector-consumes-only.spec.ts` (`PR1`, `PR21`), `read-model-sole-writer.spec.ts` (`PR20`), `main-kafka-options.spec.ts` (`PR5`).

---

## 3. The document shape — reconciled against `apps/seed`

`apps/seed/src/writers/mongo.writer.ts` **already writes this collection**, and its `OrderTimelineDocument` is a structural mirror of `openapi.yaml`'s `OrderDetail`. That shape is adopted, not competed with. `apps/projector/src/infrastructure/persistence/order-timeline.document.ts` re-declares the same interface (the two apps share no code — `CLAUDE.md`: the only shared runtime code is `shared-kernel` and `contracts`) and a text-parity guard is **not** proposed, because the two are structurally identical only by intent; the binding check is that both satisfy `openapi.yaml` `OrderDetail`, which is where feature 25's contract test will bite.

The seeded shape is **sufficient for `R50` – `R55` and needs two additions**, both projector-owned and both invisible to clients:

| Field | Present in seed? | Purpose |
|---|---|---|
| `_id`, `orderId`, `orderReference`, `orderDate`, `retailer`, `company`, `status`, `cancellationReason`, `currency`, `totals`, `items`, `references`, `events[]`, `headerComplete`, `updatedAt` | **yes** | Adopted verbatim. `headerComplete` already exists and already means what `R53`/`PR9` need. |
| `statusRank: number` | **no — added** | `PR12`. Makes `R52`'s "precedes" decidable inside a single atomic update, with no state-machine walk and no read-then-write. |
| `processedEventKeys: string[]` | **no — added** | `PR23`. `` `${consumer}:${eventId}` ``, sorted. The dedup ledger. |

Both are stripped by feature 25's Mongo projection (`{ projection: { statusRank: 0, processedEventKeys: 0 } }`) so `OrderDetail` on the wire is unchanged. `openapi.yaml` does not close `additionalProperties`, so no shared-contract change is needed either way; projecting them out is a cleanliness choice, recorded so feature 25 does not have to rediscover it.

### 3.1 Two things about the seeded shape that must change

1. **`uq_order_reference` must become partial.** `mongo.writer.ts` creates `createIndex({ orderReference: 1 }, { unique: true, name: 'uq_order_reference' })`. Every seeded document has a string `orderReference`, so this is harmless today — but a projector **placeholder** (`PR8`) has `orderReference: null`, MongoDB indexes nulls and compares them equal, and the **second** placeholder would be rejected with `E11000`. Creating the same index name with different options fails with `IndexOptionsConflict`, so this cannot be worked around from the projector side. The fix is one option in `apps/seed`: `partialFilterExpression: { orderReference: { $type: 'string' } }`, plus dropping the old index on any existing dev database. **Open point 1 — needs approval, because it edits a second app.**
2. **`updatedAt`'s meaning is fixed, not changed.** `PR14` makes it *the greatest `occurredAt` applied so far*. `apps/seed` already writes `saga.updatedAt`, which for every fixture is the last fact's `occurredAt`. The two agree; the requirement records the agreement so a later reader does not "fix" it to a wall clock and silently break `PR15`.

### 3.2 `_id` and the identity chain

`_id = orderId = correlationId`. `R12` makes `correlationId` always the order id, `asyncapi.yaml` makes it the partition key of all three topics, and `domain-model.md` §7.1 calls it "the read-model document key" outright. Nothing is generated in this service — `UniqueId.generate()` appears nowhere in `apps/projector` — which is one of the three legs of `PR15`.

---

## 4. The domain layer — a projection, not an aggregate

The projector owns no aggregate and enforces no invariant. Its "domain" is the pure, total function from an envelope to a description of the change.

```ts
// domain/projection-delta.ts
export interface TimelineEntryDelta {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;          // ISO-8601, straight from the envelope
  readonly summary: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ProjectionDelta {
  readonly orderId: string;             // = correlationId
  readonly entry: TimelineEntryDelta;
  readonly impliedStatus: OrderStatus | null;   // null for the four status-less facts
  readonly statusRank: number;                  // 0 when impliedStatus is null
  /** Fields written only while null (PR11, PR13). */
  readonly fillIfAbsent: Readonly<Partial<Pick<OrderTimelineDocument, 'cancellationReason'>>> &
    { readonly references?: Readonly<Partial<OrderTimelineDocument['references']>> };
  /** Present ONLY for order.placed.v1 (PR9). Written unconditionally; the dedup filter is what stops a second write. */
  readonly header?: OrderHeaderDelta;
}

export function projectFact(envelope: Envelope): ProjectionDelta;
```

`projectFact` is a thirteen-arm switch with **no default arm that silently returns** — an unknown type throws `UnknownFactTypeError`, which `projector-facts.controller.ts` turns into `PR4`'s log-and-acknowledge. `PR2`'s structural spec reads the thirteen `eventType` strings out of `specs/shared/domain-model.md` §7.2 as **text** (the `kafka.config.spec.ts` discipline: no YAML/Markdown parser dependency) and compares them to the switch's exported key set in both directions.

`summaries.ts` holds thirteen small pure builders. Notifications proved on seven facts that the envelope carries enough to render a human line with no write-model access; the extension to thirteen is mechanical, and the four Notifications deliberately skips are exactly the ones where the read model *does* want a line — `"Stock rejected: 3 unit(s) short on ACME-0007"`, `"5 unit(s) released back to stock (compensation)"`, `"Credit hold of 24 900 EUR rejected (simulated_cents_rule)"`, `"Credit exposure released — invoice paid"`. `apps/seed/src/data/sagas.data.ts` already contains prose of exactly this shape for nine of them; the builders reproduce that voice so a seeded document and a projected document read alike.

Money: `money-format.ts` takes `(minorUnits: number, currency: string)` and renders with an integer-only algorithm (`Math.trunc`/`%` on the integer, never `/100`). `M2` forbids cross-currency arithmetic and there is none here — a summary renders one payload's amount in that payload's own currency.

`detail` is populated only where the UI needs structure: shortages (`stock.rejected.v1`), released units (`stock.released.v1`), the rejection reason and requested amount (`credit.rejected.v1`), the cancellation reason and compensation steps (`order.cancelled.v1`). It mirrors `sagas.data.ts`'s existing use.

---

## 5. The write — one atomic apply, and why

This is the heart of the feature and the answer to the hazard feature 23 shipped (an in-memory ledger that duplicated on restart) in its other guise: *an upsert that looks idempotent under test but is not under concurrent or out-of-order delivery.*

### 5.1 Phase 1 — bring the document into existence

```ts
await collection.updateOne(
  { _id: orderId },
  { $setOnInsert: placeholderSkeleton(orderId) },   // PR8
  { upsert: true },
);
```

`$setOnInsert` applies **only** on insert, so this operation is a no-op against an existing document — idempotent by construction, not by inspection. It never touches `events`, `status`, `statusRank` or `processedEventKeys` of a document that already exists.

Its one race is the classic Mongo upsert race: two concurrent deliveries for an **absent** order can both fail to match and both attempt an insert; one wins, the other gets `E11000` on `_id`. Handled explicitly — catch `E11000`, retry the operation exactly **once**, after which it can only match (`PR7`). Not swallowed generally: any other error propagates and the fact is redelivered.

### 5.2 Phase 2 — the atomic apply

```ts
const applied = await collection.findOneAndUpdate(
  { _id: orderId, processedEventKeys: { $ne: dedupKey } },   // ← THE IDEMPOTENCY CHECK
  [ /* one aggregation pipeline, §5.3 */ ],
  { returnDocument: 'after' },
);
// applied === null  ⇒ duplicate: nothing was written, no signal (R51, PR18)
// applied !== null  ⇒ processed: exactly this fact was applied, once
```

**The filter is the check.** There is no `findOne` beforehand, no `if (doc.processedEventKeys.includes(key))` in TypeScript, no compare-and-set loop. `PR6` states this as a requirement precisely because the read-then-write version passes every single-threaded test.

**Under two concurrent deliveries of the same `eventId`:** MongoDB evaluates the predicate, takes the document-level write lock, and on a WiredTiger write conflict **retries the whole operation, re-evaluating the query predicate**. So the loser re-runs its filter *after* the winner's `$setUnion` has landed, finds its own key present, matches nothing and returns `null`. Exactly one apply, one signal, one timeline entry — and the loser's answer is `'duplicate'`, which is the correct answer, not an error. This is the same shape as the canonical's insert-first `INSERT` into a unique index (`apps/orders/.../idempotent-consumer.ts`): in both, the store's own concurrency control is the serialisation point and the application code contains no check at all.

**Under out-of-order delivery:** the pipeline is written so that every field's new value is a **monotone function of its old value and the incoming fact** — `$max` for the rank, `$ifNull` for the references, a sort for the array, `$max` for `updatedAt`. Monotone means commutative here, which is what makes `PR15` (replay determinism) true and `R52` (no regression) automatic rather than case-analysed.

### 5.3 The pipeline

An **update with an aggregation pipeline** (MongoDB 4.2+; the compose stack runs `mongo:8.3.8`) is the instrument, because it is the only single-operation update that can read the current document to compute the new one. `delta-to-pipeline.ts` emits one `$set` stage:

```js
[{ $set: {
  processedEventKeys: { $sortArray: {                                    // PR15 — a set union's order is unspecified
    input: { $setUnion: [{ $ifNull: ['$processedEventKeys', []] }, [dedupKey]] }, sortBy: 1 } },

  events: { $sortArray: {                                                // PR10 — sorted in the document, not at read
    input: { $concatArrays: [{ $ifNull: ['$events', []] }, [entryDoc]] },
    sortBy: { occurredAt: 1, eventId: 1 } } },

  statusRank: { $max: [{ $ifNull: ['$statusRank', 0] }, rank] },         // PR12 — rank 0 for status-less facts
  status: { $cond: [{ $gt: [rank, { $ifNull: ['$statusRank', 0] }] }, impliedStatus, '$status'] },

  'references.despatchReference': { $ifNull: ['$references.despatchReference', despatchOrNull] },   // PR11
  'references.invoiceReference':  { $ifNull: ['$references.invoiceReference',  invoiceOrNull]  },
  'references.paymentReference':  { $ifNull: ['$references.paymentReference',  paymentOrNull]  },
  cancellationReason: { $ifNull: ['$cancellationReason', reasonOrNull] },                            // PR13

  updatedAt: { $max: ['$updatedAt', occurredAt] },                       // PR14 — never a wall clock

  // present ONLY when delta.header is (order.placed.v1) — PR9
  ...headerFields, headerComplete: true,
}}]
```

Notes that matter:

- `$sortArray` needs MongoDB **5.2+**; the stack is 8.3.8 and `@testcontainers/mongodb` drives the same tag. Recorded because it is the one version-sensitive construct here.
- **Every array and rank operand is `$ifNull`-guarded.** `$setUnion` and `$concatArrays` *error* on a missing field, and a missing `$statusRank` compares as null — which BSON orders **below** every number, so an unguarded `$gt: [1, '$statusRank']` is `true` and would regress a document that has a status but no rank. Documents in exactly that shape exist: `apps/seed` wrote them (§11). The guard makes the pipeline total over any document; the §11 backfill is what makes the *value* right for those documents.
- `status` uses `$cond` on `rank > $statusRank` **strictly**, and `statusRank` uses `$max`. Both are evaluated against the *pre-update* document within one pipeline stage (`$set` computes all its expressions against the input document), so the two agree without ordering games.
- For a status-less fact, `rank = 0`; `$max` leaves the rank and `$gt` is false, so `status` re-writes its own value. Cheap and total — no conditional pipeline construction, which keeps `delta-to-pipeline.ts` a pure function with one shape.
- The header fields are written **unconditionally** when `delta.header` is present. They do not need `$ifNull` protection because `order.placed.v1` occurs exactly once per order and the dedup filter already stops its redelivery. Writing them conditionally would hide a genuine defect (two different `order.placed.v1` facts for one order id) behind a silent no-op.

### 5.4 What is *not* used, and why

| Rejected | Why |
|---|---|
| `replaceOne` of a document rebuilt in TypeScript | Requires a read; lost-update under concurrency; and it is what `apps/seed` does, correctly, because the seed is single-threaded and offline. |
| A multi-document transaction across a `processed_events` collection and `order_timeline` | The compose stack runs a **standalone** `mongo:8.3.8`, not a replica set, so transactions are unavailable — and even with them, one document is strictly better than two. |
| An optimistic-concurrency `version` field with a compare-and-set retry loop | Correct, but it is a read-then-write with extra steps, and `PR15` would then have to exclude a `version` field from the byte-comparison. |
| `$addToSet` + `$push` with `$each`/`$sort` (classic operators instead of a pipeline) | Cannot express the conditional `status` (`R52`) in the same operation, which would force a second write or a read. |

---

## 6. Idempotency — the variant (`PR23` – `PR26`)

### 6.1 The class

`apps/projector/src/infrastructure/messaging/idempotent-consumer.ts`:

```ts
export type ConsumptionOutcome = 'processed' | 'duplicate';

/** The MongoDB variant: the dedup mark and the projection are ONE write. */
export class MongoIdempotentConsumer {
  constructor(private readonly collection: Collection<OrderTimelineDocument>) {}

  /**
   * @param scopeId       the document the dedup key lives in (= orderId)
   * @param eventId       the fact's eventId
   * @param consumer      the consumer name — the key is the PAIR (R17)
   * @param stages        the projection, merged into the same atomic write
   * @param afterApplied  runs exactly once, AFTER the write, only when it matched
   */
  runOnce(
    scopeId: string,
    eventId: string,
    consumer: ConsumerName,
    stages: (dedupKey: string) => Document[],
    afterApplied: (applied: OrderTimelineDocument) => Promise<void>,
  ): Promise<ConsumptionOutcome>;
}
```

The banner is load-bearing — OI12 case 4 reads it and now requires three things, all checked:

```
// VARIANT OF — apps/orders/src/infrastructure/messaging/idempotent-consumer.ts
//
// Divergence: the ledger is not a MySQL `processed_events` row inside a SQL
// transaction; it is the `processedEventKeys` array of the read-model
// document itself, written by the SAME single findOneAndUpdate that applies
// the projection. ... (why: §9.1)
//
// Behavioural conformance: apps/projector/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts
```

### 6.2 Why `stages` is a parameter and `work` is a post-apply callback

The canonical's `runOnce(eventId, consumer, work)` runs `work` **inside** the transaction that inserts the dedup row. There is no transaction here, and the effect *is* the same write, so `work` cannot be "run inside" anything. Two shapes were considered:

- `work` returns the stages → then `work` must be invoked before the write, **including on duplicates**, and conformance case 2 (`expect(work).toHaveBeenCalledTimes(1)` after a redelivery) fails. That is not a test-fitting problem; it means the shape genuinely does not preserve the pattern's semantics.
- the stages are their own parameter and `work` becomes the **post-apply** callback → invoked exactly once on `'processed'`, never on `'duplicate'`, which is precisely the canonical's observable contract. And it has a real job: it is where `PR18`'s signal publication lives, and it is what makes "no signal for a suppressed redelivery" structural rather than a second `if`.

The second is adopted. The conformance adapter is then honest and thin:

```ts
runOnce: (eventId, consumer, work) =>
  real.runOnce(FIXED_SCOPE_ID, eventId, consumer, dedupOnlyStages, () => work()),
```

`FIXED_SCOPE_ID` is one document created once per suite — the analogue of "one table". `dedupOnlyStages` writes the dedup key and nothing else, so what the suite exercises is exactly the dedup mechanism; the projection is proved by `R50` – `R53`'s own integration specs. All five conformance cases are non-vacuous under this adapter:

| Case | Why it genuinely bites here |
|---|---|
| 1 first call processed, work once | the filter matches, `findOneAndUpdate` returns a document |
| 2 second call duplicate, work still once | the filter's `$ne` no longer matches; `null`; callback skipped |
| **3 fresh instance, same store → duplicate** | the state is in MongoDB, not in a field of the class — the property `N1` violated live and `N15` calls load-bearing |
| 4 two eventIds both run | two distinct keys |
| **5 same eventId, different consumer → both run** | **this is why the key is the pair and not the bare `eventId` already sitting in `events[]`** |

### 6.3 The registry (`PR24`)

`apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` already carries `projector: 'documented-variant'`. **This feature changes no file under `apps/orders`.** What it must do is make that entry *true*:

- own **no** `src/infrastructure/persistence/schema/processed-events.schema.ts` (case 2 fails loudly otherwise: *"registered 'documented-variant' but owns a MySQL processed-events.schema.ts"*);
- own `src/infrastructure/messaging/idempotent-consumer.ts` with the banner of §6.1 (case 4 checks the canonical path literal, a `Divergence:` line, a `Behavioural conformance:` line, **and that the named file exists on disk**);
- make the named file real and green (`PR25`).

Case 4 is dormant today — no `documented-variant` app owns the file — and **arms on this feature**. That is exactly what `impl_oi12_behavioural_parity.md` built it for, and this is its first real subject.

---

## 7. The update signal (`R55`, `PR17` – `PR19`)

### 7.1 The transport choice, argued against the decision matrix

`asyncapi.yaml`'s matrix has two columns and the update signal fits neither cleanly. Held against each property:

| Property | Fact stream (Kafka) | RPC transport (NATS core) | The update signal |
|---|---|---|---|
| Immutable domain truth | yes | no | **no** — it is a *derived* notification about a store, not something that happened in the domain |
| Must be durable and replayable | yes | no | **no** — `openapi.yaml` `/orders/stream` already states the buffer is bounded, the stream is a notification channel and the read model is the source of truth |
| Advances the saga | yes | no | **no** |
| Has one responder, expects a reply | no | yes | **no** — but it is fire-and-forget on the *same* transport |
| Loss degrades liveness only | no (loss is a correctness bug) | yes (a timeout is a legitimate answer) | **yes** |
| Fan-out to every interested subscriber | via consumer groups | via subject subscription | **must fan out to every Gateway replica** |

**Decision: NATS core publish**, subjects `readmodel.order.updated.<orderId>` and `readmodel.timeline.appended.<orderId>`.

Three reasons, in order of weight:

1. **Its delivery semantics are NATS's, not Kafka's.** At-most-once, no durability, loss degrades liveness only and is already accounted for by the shared contract. Putting it on Kafka would give it durability and replay it does not need and must not have — a replayable "signal" topic is a topic someone will eventually treat as a fact and derive state from, which `R54` forbids outright.
2. **Fan-out.** Every Gateway replica holding SSE connections must receive **every** signal. On Kafka that means one consumer group per replica (operationally ugly, and a shared group would deliver each signal to exactly one replica — a real bug for SSE fan-out, and one that only appears at two replicas). NATS subject subscription fans out to all subscribers by construction.
3. **The subject hierarchy is the filter.** `GET /orders/stream?orderId=X` becomes a subscription to `readmodel.order.updated.X`; without the parameter, `readmodel.order.updated.*`. Feature 25 writes no filtering code.

**The honest cost, and why it is flagged:** this widens the NATS transport's stated role from *"commands and queries, request-reply"* to *"…and read-model update signals, publish-only"*. It is a genuine extension of a rule in `specs/shared/`, it is inherited verbatim by #8 and #9, and it must therefore be approved consciously rather than noticed later. **Open point 2.** The mitigation that makes it defensible: the signal has no responder and no reply subject, it is never awaited, and no code path branches on it — so the shared rule's *purpose* ("never use RPC for facts, never use Kafka as a request bus") is untouched. If the gate declines, the alternative is a fourth Kafka topic `otc.readmodel.updates.v1` with a per-replica consumer group; nothing else in the design changes.

### 7.2 Shape and ordering

Two publishes per applied fact, both derived from the **post-apply document** `findOneAndUpdate` returned (`returnDocument: 'after'`), so the signal can never describe a state the store never held:

- `readmodel.order.updated.<orderId>` → `OrderStreamUpdate` (`eventId`, `orderId`, `orderReference`, `status`, `cancellationReason`, `references`, `totals`, `occurredAt`)
- `readmodel.timeline.appended.<orderId>` → `TimelineStreamEntry` (`eventId`, `orderId`, `orderReference`, `eventType`, `occurredAt`, `summary`)

Both carry `eventId` because `openapi.yaml` already tells clients to deduplicate on it. `JSONCodec` and the `apps/orders/src/infrastructure/messaging/nats-client.ts` shape are reused; `x-correlation-id` travels in NATS headers, same as the RPC adapters.

Failure handling is `PR19`: log and swallow. The argument is in the requirement and is worth restating because it is counter-intuitive — rethrowing here produces a redelivery that `PR6`'s filter suppresses, so the signal can *never* be emitted on a retry, and the partition blocks while failing forever. Losing a frame that the client's reconnect-and-refetch already covers is strictly better.

---

## 8. Wiring

### 8.1 `main.ts`

Hybrid app, exactly `apps/notifications`' shape plus two things:

```ts
app.enableShutdownHooks();
await ensureReadModelIndexes(db);                 // PR22 — before consuming
app.connectMicroservice<MicroserviceOptions>({
  transport: Transport.KAFKA,
  options: {
    client: { clientId, brokers },
    consumer: { groupId: 'projector', sessionTimeout: 30000 },
    subscribe: { fromBeginning: true },           // PR5 — deliberately NOT notifications' `false`
    run: { partitionsConsumedConcurrently: 1 },
  },
});
await app.startAllMicroservices();
await app.listen(PROJECTOR_PORT);                 // 3006, health only
```

`fromBeginning: true` deserves its comment in the file, because the service next door made the opposite choice for a good reason. Notifications' facts produce an **external side effect** (an email); replaying history there means emailing counterparties about months-old orders. The projector's effect is **internal and idempotent**; replaying history is how the read model is *built*, and it is the mechanism behind `feature_list.json`'s own acceptance bullet *"replaying a topic reproduces an identical document"*. `PR15` is what makes that safe: a replayed fact either applies once or is suppressed, and either way the document converges to the same bytes.

The NATS connection is a plain `connect()` from the `nats` package (no `ClientsModule`, no `ClientProxy`) — the shape `apps/orders` established for explicit control, here for publish only.

### 8.2 `app.module.ts`

`CqrsModule.forRoot()`, the one `@CommandHandler` as a class provider, everything else `useFactory` + `inject: [...]` with explicit tokens (`CLAUDE.md` § Explicit DI tokens; the ESLint `no-restricted-syntax` guard enforces it). Module-local symbols `READ_MODEL_COLLECTION` and `NATS_CONNECTION`, not exported.

### 8.3 `projector-facts.controller.ts`

Three `@EventPattern(TOPIC, Transport.KAFKA)` handlers — the explicit `Transport` argument is non-negotiable (`CLAUDE.md`; the live boot crash of feature 16). Each parses the envelope with the same tolerant `parseFactEnvelope` shape Notifications and the saga controller use, then `commandBus.execute(new ProjectFactCommand(envelope))`. `PR3` and `PR4` are the two log-and-acknowledge branches; neither writes, neither signals.

### 8.4 Configuration and dependencies

Already in `.env.example`: `MONGO_HOST`, `MONGO_HOST_PORT`, `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `MONGO_DB_READMODEL`, `NATS_URL`, `KAFKA_BROKERS`, `PROJECTOR_PORT`. **Added:** `PROJECTOR_KAFKA_CLIENT_ID` (default `otc-projector`), `PROJECTOR_CONSUMER_GROUP` (default `projector`) — the `NOTIFICATIONS_*` pair's exact shape.

Packages, all already in the `pnpm-workspace.yaml` catalog (no new catalog entry, no lockfile surprise): `@nestjs/microservices`, `@nestjs/cqrs`, `kafkajs`, `nats`, `mongodb`, `@otc/contracts`, `@otc/shared-kernel`; dev: `testcontainers`, `@testcontainers/mongodb`, `@testcontainers/kafka`, `@testcontainers/nats`, `dotenv-cli`.

---

## 9. Decisions argued

### 9.1 Why not a fifth MySQL database

The alternative the brief names: register `'mysql-copy'`, add `otc_projector` with the canonical `processed_events` table, adopt `idempotent-consumer.ts` byte-identically. Rejected, and the reason is not cost:

The canonical's whole guarantee is *"the mark and the effect commit together"* (`R17`). Here the effect lives in **MongoDB** and the mark would live in **MySQL**. There is no transaction spanning them, so a crash between commit and apply leaves the event permanently marked and never projected — a silently missing timeline entry that no redelivery can repair, because the mark suppresses it. Notifications hit the same wall and answered with `N6`'s insert-first-then-compensating-delete, which is defensible for an email (worst case: one lost notification) and **not** defensible for a read model (worst case: a permanently wrong document that nothing detects).

The variant has no such window: there is nothing to keep consistent, because the mark and the effect are the same bytes in the same write. It is the *stronger* option here, not the cheaper one — which is why it is registered `'documented-variant'` rather than apologised for.

Cost accepted: `apps/projector` gains no MySQL and therefore cannot ever adopt the canonical pair, so OI12's byte-identity branch will never cover it. That is exactly the gap `impl_oi12_behavioural_parity.md` closed by making the behavioural suite mandatory for variants — `PR25`.

### 9.2 Why `processedEventKeys` and not `events[].eventId`

The brief's suggestion — the `eventId` is already in the timeline, use it — is the smaller design and was seriously considered. It fails on one point: `R17`'s key is the **pair**, and conformance case 5 checks it. A timeline entry has no consumer field and must not grow one (`TimelineEntry` is a client-facing schema in `openapi.yaml`). Storing the pair in its own array costs at most thirteen short strings per order, keeps `OrderDetail` untouched, and decouples the dedup from the incidental fact that today every projected fact happens to append an entry.

Recorded as open point 5 (no approval needed): the redundancy is real and deliberate.

### 9.3 One command class, not thirteen

Notifications has seven `@CommandHandler`s because it has seven templates and seven decisions. The projector's behaviour does not vary with `eventType` at all — the variation is entirely inside `projectFact`, a pure function. Thirteen command classes would be thirteen empty subclasses routed to identical handlers. `PR27`. Open point 6, informational.

### 9.4 `apps/seed` stays the seeder

`R54` says the projector is the only writer. `apps/seed` writes `order_timeline`. Rather than pretend otherwise, `PR20` allow-lists it **by name with its reason in the guard**: an offline fixture loader, never deployed, run before the system runs, writing documents in the shape this design fixes. The guard's value is that a *fourth* writer cannot appear quietly. **Open point 4 — flagged**, because it is a stated exception to a shared requirement's literal wording.

---

## 10. Testing approach

Levels, per `CLAUDE.md` and `test-matrix.md`:

- **Pure unit, no container:** `domain/` (`projectFact`, ranks, summaries, money formatting) and `delta-to-pipeline.ts` (pipeline stages are plain objects — assert the emitted stage tree, which is where `$sortArray`/`$ifNull`/`$cond` correctness is cheapest to pin). Coverage gate ≥80% on `domain/`.
- **Structural text-scan guards, no container:** `PR1`, `PR2`, `PR5`, `PR20`, `PR21` — the `notifications-consumes-only.spec.ts` / `billing-consumes-no-facts.spec.ts` shape, each with its non-vacuity proven against a temporary fixture rather than asserted.
- **Integration, Testcontainers, real MongoDB + real Kafka + real NATS:** everything else. No mocked broker, no mocked driver, ever.

Two rules bind every integration spec here:

1. **Synchronise only on terminal or monotonic evidence.** A projector is a race by construction: the document passes through many intermediate states a correct system is *allowed* to be in. Poll for `events.length === N` (monotone) or `status === 'completed'` (terminal) or `processedEventKeys` containing a specific key (monotone) — never for `status === 'confirmed'` on an order that will continue, and never a bare `sleep`.
2. **`N10` (feature 21).** *An assertion that a rolled-back or absent side effect did not happen proves nothing about whether it was attempted.* Here that lands squarely on `PR18` and `R51`: "no duplicate timeline entry after a redelivery" is satisfied by a projector that applies twice and happens to overwrite. The **attempt** must be observed — assert on `findOneAndUpdate`'s returned `null` and on the post-apply callback not being invoked (a counter), not only on the document's final contents.

### 10.1 The fact-emission rule

The projector emits no domain fact, so the rule lands on its analogue — **the update signal**, which is this service's only outward emission, and on the two deliberate *suppressions*:

| Branch | Armed deletion the implementer must run | Expected failure |
|---|---|---|
| `PR18` emit-on-applied | delete the `afterApplied` invocation | `update-signal.integration.spec.ts` › *publishes exactly one signal pair for a first delivery…* |
| `PR18` suppress-on-duplicate | make `runOnce` invoke `afterApplied` unconditionally | the *…and none at all for a suppressed redelivery* case |
| `PR19` swallow-not-rethrow | replace the catch with a rethrow | `projection-apply.service.spec.ts` › *logs and swallows a signal publication failure…* |
| `PR4` unknown-type log | replace the log with a bare `return` | `projector-facts.controller.spec.ts` › *logs and acknowledges an unknown eventType instead of discarding it silently* |

Each arming, its failing test name and its verbatim failure message go in `progress/impl_projector_read_model.md`. A branch whose emission survives its own deletion on a green suite is **not done**.

### 10.2 The replay-determinism spec (`PR15`) — how it is made to bite

Not "run it twice and compare". The sequence:

1. Produce the full fact set of one seeded saga to the three real topics, consume, snapshot the document (`_id` excluded from nothing — the whole document, `statusRank` and `processedEventKeys` included).
2. Drop the collection.
3. Produce the **same set** shuffled by a seeded PRNG, with each fact duplicated a deterministic number of times (0 extra, 1 extra, 2 extra), across the three topics, consume, snapshot again.
4. `expect(second).toEqual(first)` on the whole document.

Step 3's shuffle is what makes it a determinism test rather than a repeatability test, and the duplication is what makes it also an `R51` test. If the assertion is ever weakened to compare a projection of the document, the spec has stopped proving the acceptance criterion.

---

## 11. Live boot expectation, stated in advance

Against the running compose stack with `apps/seed` already applied, starting the projector with `fromBeginning: true` on a fresh `projector` consumer group:

- It replays every fact the previous phases wrote to the three topics.
- Documents for **seeded** orders are *re-derived over the seeded ones*, and this is the sharpest live interaction in the feature. `apps/seed` writes `headerComplete: true` documents with **no `statusRank` and no `processedEventKeys`**. Against such a document: `$setUnion`/`$concatArrays` on a missing field *error*; and a missing `$statusRank` compares as null, which BSON orders below every number, so `order.placed.v1` (rank 1) would satisfy `$gt` and **regress a seeded `completed` order to `placed`** — a live `R52` violation caused entirely by the pre-existing rows. §5.3's `$ifNull` guards fix the first half. The second half — plus a third, below — needs a **one-shot, idempotent backfill** run by the boot bootstrap before any consumption.
- **The third half is the one that actually bites.** A seeded document already contains its nine or so timeline entries, but its `processedEventKeys` is empty, so the dedup filter suppresses **nothing** and the replay would append every seeded fact a *second* time. The backfill therefore derives the ledger from the document's own timeline — which is exactly the "the `eventId` is already in the timeline, use it" observation, applied where it genuinely belongs: `processedEventKeys: { $sortArray: { input: { $map: { input: { $ifNull: ['$events', []] }, as: 'e', in: { $concat: ['projector:', '$$e.eventId'] } } }, sortBy: 1 } }`, together with `statusRank` derived by a `$switch` from the document's own `status`.
- Filter: `{ statusRank: { $exists: false } }` — idempotent by construction, a no-op on its second run and on every document this projector wrote itself. It must be **tested against a seeded fixture**, not assumed: task **B6**, and its acceptance is that replaying a seeded order's facts leaves `events.length` unchanged and `status` unchanged.
- The tidier long-term alternative — have `apps/seed` write both fields itself — is folded into open point 1, since that file is already being opened for the index. The backfill is kept regardless, because a dev database seeded *before* this feature exists in the wild.
- Expected steady state: every seeded order's document unchanged in its client-visible fields, with the two projector fields backfilled; every live order placed since has a complete document; `events.length` equals the number of facts on the topics for that order.
- Expected **absence**: no new order, no new fact, no `saga_commands` row. The projector produces nothing but signals.

---

## 12. Out of scope — restated

`requirements.md` §5. In particular: no HTTP query surface, no SSE, no DLQ handling, no OpenTelemetry, no `apps/orders` edit, no `apps/web` edit. The single file touched outside `apps/projector` is `apps/seed/src/writers/mongo.writer.ts` (§3.1, open point 1) — and only if the gate approves it.
