# `projector_read_model` — Requirements (assessment #7)

> **The normative requirements for this feature are `R50` – `R55` in [`specs/shared/requirements.md`](../shared/requirements.md) §7**, elaborated by [`specs/shared/domain-model.md`](../shared/domain-model.md) §7.1 (the envelope), §7.2 (all **thirteen** facts) and §7.3 (the consumption map — the projector is the only consumer that takes every fact); [`specs/shared/saga.md`](../shared/saga.md) §6 (the three idempotency layers, layer 1 in particular) and §7 (the ordering guarantees, including *"the read model tolerates disorder"*); [`specs/shared/asyncapi.yaml`](../shared/asyncapi.yaml) (the three fact topics, their `correlationId` partition key, and the `projectorConsumes*` operations); and [`specs/shared/openapi.yaml`](../shared/openapi.yaml) (`OrderDetail`, `TimelineEntry`, `ProjectionPending`, `OrderStreamUpdate`, `TimelineStreamEntry`). Those six are **not restated here** — this file adds only the local requirements (`PR<n>`) for the gaps the shared spec leaves to each assessment, and their traceability.

> **`R11`, `R12`, `R17`, `R18` are inherited, not re-owned.** `R11`/`R12` are the producers' obligation and are already `DONE`; this feature *depends* on them — the projector renders a human summary for all thirteen facts from the envelope alone, exactly as Notifications proved possible for seven, and it keys every document on `correlationId` because `R12` makes that the order id. `R17`/`R18` are the idempotency contract this feature satisfies in a **documented variant** of the canonical pattern (`PR20` – `PR23`); their matrix rows are already `DONE` and are not re-flipped.

> **`R54` and `R55` are shared between this feature and feature 25 (`gateway_rest_auth`).** This feature owns the *producer* half of both — the projector is the sole writer (`R54`) and it emits the update signal (`R55`). It owns **none** of the consumer half: the `GET /orders` / `GET /orders/{id}` read path, the `202 ProjectionPending` body, the `/orders/stream` SSE endpoint, its bounded replay buffer and `Last-Event-ID` resume are all feature 25's. §4 below states the seam precisely and open point 3 of [`progress/spec_projector_read_model.md`](../../progress/spec_projector_read_model.md) carries the matrix consequence to the gate.

---

## 1. Vocabulary local to this feature

| Term | Meaning here |
|---|---|
| **read-model document** | One MongoDB document in the `order_timeline` collection of database `otc_read_model`, `_id` = the order id (`= correlationId`, `R12`). The unit of everything below. |
| **placeholder** | A read-model document created by a fact other than `order.placed.v1`, whose header fields are not yet known. Distinguished by `headerComplete: false` (`R53`, `PR9`). |
| **complete document** | `headerComplete: true` — `order.placed.v1` has been applied and every header field is filled. |
| **implied order status** | The order status a fact proves has been reached, or `null` for a fact that proves nothing about the order's status. The full mapping is `PR12`'s table. |
| **status rank** | An integer that totalises the implied statuses so "precedes" in `R52` is decidable by a `$max`, not by a state-machine walk the projector is not allowed to own. `PR12`. |
| **dedup key** | The string `` `${consumer}:${eventId}` ``, stored in the document's `processedEventKeys` array. The pair of `R17`, never the `eventId` alone. `PR20`. |
| **the atomic apply** | The single `findOneAndUpdate` whose **filter is the idempotency check** and whose aggregation-pipeline update is the whole projection of one fact. `PR6`. |
| **update signal** | A NATS core **publish** (no reply subject, no responder, at-most-once) announcing that a read-model document changed. Not a fact and not a command — see §4 and `PR16`. |
| **the variant** | `apps/projector`'s MongoDB implementation of the idempotent-consumer pattern, registered `'documented-variant'` in `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` (OI12). `PR20` – `PR23`. |

---

## 2. Local requirements

### 2.1 The consumer surface

**PR1.** THE SYSTEM SHALL consume the three fact topics `otc.orders.facts.v1`, `otc.fulfillment.facts.v1` and `otc.billing.facts.v1` through exactly three event-pattern handlers, each **explicitly bound to the Kafka transport**, under the single consumer group `projector`; and the projector SHALL register **no** request-reply responder of any kind (no `@MessagePattern`, no NATS subscription that carries a reply subject), because the projector answers no query — the Gateway reads the read model directly (`R54`, feature 25). IF a responder or a fourth topic subscription is introduced, THEN the structural guard of `PR1` SHALL fail.

**PR2.** THE SYSTEM SHALL handle **all thirteen** `eventType`s of `domain-model.md` §7.2 — it is the first and only consumer that must, `domain-model.md` §7.3 — and SHALL prove that coverage structurally: the handler table's key set, compared against the thirteen `eventType` strings read as text from `domain-model.md` §7.2, SHALL be equal, and the comparison SHALL fail when a type is added to the shared catalogue and not to the table, and when a type is present in the table and not in the catalogue.

**PR3.** IF a message arrives on a fact topic whose value cannot be parsed as a complete envelope — not valid JSON, not an object, or missing any of the seven `R11` fields — THEN THE SYSTEM SHALL log one structured error carrying the topic and the reason, SHALL write **nothing** to the read model, SHALL publish **no** update signal, and SHALL acknowledge the message; a producer bug is not repairable by redelivery and must not block a partition.

**PR4.** IF a message arrives carrying a well-formed envelope whose `eventType` is not one of the thirteen, THEN THE SYSTEM SHALL log one structured error naming the unknown type, SHALL write nothing, SHALL publish no signal and SHALL acknowledge — and SHALL NOT silently discard it. A silent `return` is the failure mode `PR2` exists to make impossible at build time and `PR4` exists to make visible at run time.

**PR5.** THE SYSTEM SHALL subscribe from the **beginning** of every fact topic (`fromBeginning: true`), deliberately the opposite of Notifications' choice and the same as the saga orchestrator's, because the read model is a **derived** store whose defining property is that replaying the topics reconstructs it (`PR15`) — a projector that starts at the log head produces a permanently and silently incomplete read model, which is a correctness violation, not a missed notification.

### 2.2 The document, and the write that maintains it

**PR6.** THE SYSTEM SHALL apply each fact to the read model in exactly **two** MongoDB operations and no others:

1. an `updateOne(..., { $setOnInsert: <skeleton> }, { upsert: true })` that brings the document into existence and, by construction, changes nothing when it already exists (`R53`, `PR8`); then
2. **one** `findOneAndUpdate` whose **filter** is `{ _id: <orderId>, processedEventKeys: { $ne: <dedupKey> } }` and whose update is a single aggregation pipeline carrying the *entire* projection of that fact — the dedup key, the timeline append, the status, the references, the header and `updatedAt`.

THE SYSTEM SHALL NOT read the document in order to decide what to write. IF any code path performs a `find`/`findOne` on `order_timeline` and then issues a write derived from what it read, THEN this requirement is violated **even if every test passes**: idempotency here is a property of the query, never of a read-then-write.

**PR7.** WHEN two deliveries of the **same** `eventId` for the same order are applied concurrently, THE SYSTEM SHALL apply exactly one of them and SHALL report the other as a duplicate: the losing operation's filter is re-evaluated by the storage engine after the write conflict, finds its dedup key already present, matches nothing and returns `null`. WHEN two deliveries of **different** `eventId`s for the same **absent** order are applied concurrently, THE SYSTEM SHALL end with exactly one document containing both timeline entries: at most one insert wins, and IF the losing upsert surfaces a duplicate-key error on `_id`, THEN THE SYSTEM SHALL retry that operation exactly once — after which it can only match — and SHALL NOT surface the error to the consumer.

**PR8.** WHEN a fact is applied to an order that has no document, THE SYSTEM SHALL create one whose `_id` and `orderId` are the fact's `correlationId`, whose `headerComplete` is `false`, whose `status` is `placed` with `statusRank` **0**, whose `events`, `processedEventKeys` and `items` are empty, and whose `orderReference`, `orderDate`, `retailer`, `company`, `cancellationReason`, `currency`, `totals` and every entry of `references` are `null`; and SHALL then apply the fact to it by the same pipeline it would have applied to a pre-existing document (`R53`). The displayed `placed` with rank `0` is the weakest statement that is certainly true — every fact of an order's saga is causally downstream of the order being placed — and rank `0` is strictly below `order.placed.v1`'s own rank `1`, so the real fact still writes.

**PR9.** THE SYSTEM SHALL set `headerComplete` to `true` **only** when `order.placed.v1` is applied, and SHALL set it in the same atomic apply that writes `orderReference`, `orderDate`, `retailer`, `company`, `currency`, `totals` and `items`; WHILE `headerComplete` is `false` the document SHALL still be a valid `OrderDetail` (`orderId`, `status`, `events` and `updatedAt` present, `openapi.yaml` `OrderDetail.required`) so that it can be served rather than hidden.

**PR10.** THE SYSTEM SHALL store the `events` array **sorted by `occurredAt` ascending, then by `eventId` ascending**, re-sorted inside the atomic apply itself on every write, so that `R50`'s ordering is a property of the stored document and not of the query that reads it; the secondary `eventId` key SHALL make the order of two facts sharing one `occurredAt` deterministic rather than dependent on arrival.

**PR11.** THE SYSTEM SHALL write a reference field (`references.despatchReference`, `references.invoiceReference`, `references.paymentReference`) **only while it is `null`**, evaluated inside the atomic apply, and SHALL never overwrite a non-null reference (`R52`). References are assigned once by their owning context and never reissued, so "first writer wins" and "newest wins" agree, and only the first is expressible without a wall clock.

**PR12.** THE SYSTEM SHALL derive each fact's implied order status and status rank from exactly this table, SHALL raise `status`/`statusRank` to the new value **only when the new rank is strictly greater** than the stored rank, and SHALL leave both untouched for every fact whose implied status is `null` (`R52`):

| `eventType` | Implied status | Rank |
|---|---|---:|
| `order.placed.v1` | `placed` | 1 |
| `stock.reserved.v1` | `stock_reserved` | 2 |
| `credit.approved.v1` | `credit_approved` | 3 |
| `order.confirmed.v1` | `confirmed` | 4 |
| `order.despatched.v1` | `despatched` | 5 |
| `invoice.issued.v1` | `invoiced` | 6 |
| `payment.received.v1` | `paid` | 7 |
| `order.completed.v1` | `completed` | 98 |
| `order.cancelled.v1` | `cancelled` | 99 |
| `stock.rejected.v1` | *(none)* | — |
| `stock.released.v1` | *(none)* | — |
| `credit.rejected.v1` | *(none)* | — |
| `credit.released.v1` | *(none)* | — |

Ranks 1 – 7 are the order state machine's own linear progression (`domain-model.md` §3), so on that segment "precedes" is a **total** order and `R52` is decidable by comparison. `completed` and `cancelled` are both terminal and mutually unreachable, so no correct history contains both; ranking them highest and distinct makes the projection **total** anyway — once terminal, nothing regresses it, and if both were somehow delivered the outcome is deterministic rather than arrival-dependent. The four status-less facts are the compensation and internal-credit mechanics: their *outcome* reaches the document as `order.cancelled.v1`, exactly as `domain-model.md` §7.3 says it reaches Notifications, so projecting a status from them would invent a state the order was never in.

**PR13.** THE SYSTEM SHALL set `cancellationReason` from `order.cancelled.v1`'s payload only, and only while it is `null`.

**PR14.** THE SYSTEM SHALL set `updatedAt` to the **greatest `occurredAt` applied so far** to the document, never to the wall clock and never to an arrival timestamp. `updatedAt` therefore answers *"as of which instant in the domain's own timeline is this document true"*, which is both deterministic under replay (`PR15`) and the value `apps/seed` already writes (its `saga.updatedAt` is the last fact's `occurredAt`).

**PR15.** THE SYSTEM SHALL make every field of a read-model document a **pure function of the set of facts applied to it** — independent of the order in which they arrived, of how many times each was delivered, of the wall clock, and of any generated identifier. Consuming a topic twice, or consuming a shuffled permutation of it with arbitrary duplicates, SHALL produce a byte-identical document. Specifically: `updatedAt` comes from `occurredAt` (`PR14`), `events` is stored sorted by a deterministic key (`PR10`), `processedEventKeys` SHALL be stored **sorted** (a set union's element order is not otherwise specified), `_id` is the fact's `correlationId` and no identifier is generated anywhere in this service, and no counter, arrival index or "last seen partition/offset" field exists on the document.

### 2.3 The human-readable summary (`R50`)

**PR16.** THE SYSTEM SHALL build the timeline entry's `summary` — and its optional `detail` — for each of the thirteen facts from the **envelope alone**, in a pure function with no read-model access, no write-model access and no clock; SHALL render every monetary value from integer minor units together with the payload's own `currency`, never as a floating-point number and never converted; and SHALL produce a summary for every one of the thirteen, not for the seven Notifications renders. IF a fact type has no builder, THEN `PR2`'s structural guard SHALL fail at build time.

### 2.4 The update signal (`R55`)

**PR17.** THE SYSTEM SHALL announce every applied change by **publishing** two messages on the RPC transport's connection using core NATS *publish* — fire-and-forget, no reply subject, no responder, at-most-once — on the subjects `readmodel.order.updated.<orderId>` and `readmodel.timeline.appended.<orderId>`, carrying respectively the `OrderStreamUpdate` and `TimelineStreamEntry` shapes of `openapi.yaml`. The subject's `<orderId>` token SHALL make feature 25's `GET /orders/stream?orderId=…` filter a **subscription** (`readmodel.order.updated.<id>`) rather than a client-side filter over a firehose, and its omission a wildcard subscription (`readmodel.order.updated.*`).

**PR18.** THE SYSTEM SHALL publish the update signal **only after** the atomic apply has been acknowledged by MongoDB **and only when it matched** — a redelivery that the filter suppressed (`R51`) changes nothing and SHALL therefore produce no signal at all.

**PR19.** IF publishing the update signal fails, THEN THE SYSTEM SHALL log one structured error carrying `eventId`, `orderId` and the subject, SHALL **not** rethrow, and SHALL acknowledge the fact. Rethrowing would be strictly worse than losing the signal: the projection has already applied, so Kafka's redelivery is suppressed by `PR6`'s filter and could never emit the signal on a later attempt — a guaranteed-failing retry loop that also blocks the partition. The loss is bounded and already accounted for by the shared contract: `openapi.yaml` `/orders/stream` states that the stream is a notification channel with a bounded buffer, that the read model is the source of truth, and that a client which missed frames re-fetches.

### 2.5 Sole writer, and no write-model reads (`R54`)

**PR20.** THE SYSTEM SHALL make `apps/projector` the only **runtime** writer of `order_timeline`: within `apps/`, only `apps/projector` and `apps/seed` may import `mongodb` at all, `apps/seed` being allow-listed by name with its reason recorded in the guard itself (an offline fixture loader that runs before the system runs, is never deployed, and writes documents in exactly the shape this feature specifies). The guard SHALL fail when any other app acquires a MongoDB import, and its non-vacuity SHALL be proven against a temporary fixture rather than asserted.

**PR21.** THE SYSTEM SHALL give the projector **no** access to any write model: no MySQL connection, no Drizzle dependency in its `package.json`, and no NATS request to any `orders.*`, `fulfillment.*`, `billing.*` or `catalog.*` subject. Everything the read model contains SHALL come from fact payloads. Structurally guarded alongside `PR1`.

**PR22.** THE SYSTEM SHALL create the read model's indexes idempotently at boot, and the uniqueness index on `orderReference` SHALL be **partial** — unique only over documents where `orderReference` is a string — because a placeholder (`PR8`) carries `orderReference: null` and MongoDB compares two indexed nulls equal, so a plain unique index would reject the **second** placeholder with a duplicate-key error. IF `apps/seed`'s existing non-partial `uq_order_reference` index is left in place, THEN the projector SHALL fail to start rather than silently run against an index that will reject its own placeholders. *(This obliges a one-line change in `apps/seed/src/writers/mongo.writer.ts` and a re-creation of the index on any existing dev database — open point 1.)*

### 2.6 The idempotent-consumer variant, and OI12

**PR23.** THE SYSTEM SHALL implement the idempotent-consumer pattern (`R17`, `R18`, `saga.md` §6 layer 1) as a **documented variant** whose ledger is the read-model document itself: the pair `` `${consumer}:${eventId}` `` in the document's `processedEventKeys` array, written by the same single operation that applies the projection (`PR6`). The projector SHALL therefore satisfy `R17`'s *"in the same transaction as every state change"* more strongly than any two-store scheme could — the mark and the effect are not two writes in one transaction, they are **one write** — and this is why a fifth MySQL database was rejected (design §9.1).

**PR24.** THE SYSTEM SHALL keep the OI12 registry (`apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts`, `SERVICE_IDEMPOTENCY_MODE`) true of itself at its already-registered value `'documented-variant'`: `apps/projector` SHALL own **no** `src/infrastructure/persistence/schema/processed-events.schema.ts`, and SHALL own `src/infrastructure/messaging/idempotent-consumer.ts` whose leading banner cites the canonical path `apps/orders/src/infrastructure/messaging/idempotent-consumer.ts`, carries a `Divergence:` line stating what differs and why, and carries a `Behavioural conformance: apps/projector/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` line naming a file that exists. **No file under `apps/orders` is modified by this feature** — the registry already reads `'documented-variant'`; this feature is what makes that entry true instead of aspirational.

**PR25.** THE SYSTEM SHALL prove the variant against the generic behavioural conformance suite (`apps/orders/src/infrastructure/messaging/test-support/idempotent-consumer-conformance.ts`, copied per that file's own instruction) running over **real MongoDB via Testcontainers**, passing all five of its cases — in particular case 3 (*a consumer constructed fresh over the same backing store still returns duplicate*), which is the property `N1` was found to violate live and `N15` records as load-bearing, and case 5 (*the same `eventId` under a different consumer name runs*), which is why `PR23`'s key is the pair and not the bare `eventId` already present in `events[]`.

**PR26.** WHILE the conformance suite is running, the subject SHALL be the **real** variant class over the **real** driver, adapted only in its parameter list: the suite's `work` callback SHALL be the variant's post-apply callback (the one `PR18` uses for the signal), invoked exactly once on `'processed'` and **not at all** on `'duplicate'`, and the projection pipeline SHALL be a no-op set of the dedup key alone. Idempotency is what this suite proves; `R50` – `R53` prove the projection.

### 2.7 The application shape

**PR27.** THE SYSTEM SHALL route every fact through `@nestjs/cqrs` (`CLAUDE.md`, binding since feature 16) as **one** `ProjectFactCommand` carrying the envelope, handled by **one** `@CommandHandler` — not thirteen command classes, because the projector's behaviour is uniform in `eventType`: all thirteen variations live inside the pure `projectFact` function, so thirteen command classes would be thirteen empty subclasses. Every constructor parameter of every Nest-decorated class SHALL carry an explicit `@Inject(TOKEN)`, and module wiring SHALL use `useFactory` + `inject: [...]`.

**PR28.** THE SYSTEM SHALL keep `apps/projector/src/domain/` free of every framework and store import — no `@nestjs/*`, no `mongodb`, no `kafkajs`, no `nats` — by expressing a fact's effect as a store-agnostic **`ProjectionDelta`** value (the timeline entry, the implied status and rank, the reference and header fields it may fill), which infrastructure alone translates into the aggregation-pipeline stages of `PR6`. The delta builder SHALL be unit-testable with no container.

**PR29.** WHEN the projector starts against a read model containing documents written before this feature existed — every document `apps/seed` has ever written — THE SYSTEM SHALL, **before consuming any fact**, backfill `statusRank` from each such document's own `status` and `processedEventKeys` from each such document's own `events[].eventId`, in one idempotent operation filtered on the absence of `statusRank`; and a subsequent replay of those orders' facts SHALL leave `events.length`, `status` and every reference of those documents **unchanged**. IF the backfill is omitted, THEN a seeded order's facts are appended to its timeline a second time and its terminal `status` is regressed to `placed` — a live `R51` and `R52` violation caused entirely by pre-existing rows, and one that no unit test and no clean-database integration test can reach.

---

## 3. Traceability — local requirements to named tests

Shared `R50` – `R55` are traced in [`specs/shared/test-matrix.md`](../shared/test-matrix.md) §7. `R50` – `R53` are flipped by this feature. `R54` and `R55` carry a **projector half** flipped here and a **gateway/web half** owed to features 25 and 26 — see §4 and open point 3.

| Id | Level | Test file › case | Status |
|---|---|---|---|
| **PR1** | unit (structural) | `apps/projector/src/projector-consumes-only.spec.ts` › *registers exactly three explicitly transport-bound @EventPattern(TOPIC, Transport.KAFKA) handlers* and *registers no RPC responder (@MessagePattern) anywhere in the projector* | DONE |
| **PR2** | unit (structural) | `apps/projector/src/domain/fact-projection.spec.ts` › *the handler table covers exactly the thirteen eventTypes the shared catalogue declares* (both-direction failure proven by *fails when the catalogue has an eventType the handler table does not* and *fails when the handler table has an eventType the catalogue does not*) | DONE |
| **PR3** | unit | `apps/projector/src/presentation/projector-facts.controller.spec.ts` › *PR3 › logs and acknowledges a malformed envelope without writing to the read model (CommandBus never called)* | DONE |
| **PR4** | unit | `apps/projector/src/presentation/projector-facts.controller.spec.ts` › *PR4 › logs and acknowledges an unknown eventType instead of discarding it silently (CommandBus called once, no rethrow)* | DONE |
| **PR5** | unit | `apps/projector/src/main-kafka-options.spec.ts` › *subscribes fromBeginning: true (never false) — the read model is a derived store rebuilt by replay* | DONE |
| **PR6** | integration | `apps/projector/src/projection-write.integration.spec.ts` › *applies one fact in exactly one upsert (update) and one filtered findOneAndUpdate (findAndModify), issuing NO read of order_timeline* | DONE |
| **PR7** | integration | `apps/projector/src/infrastructure/persistence/projection-concurrency.integration.spec.ts` › *two concurrent deliveries of ONE eventId apply exactly once and report the loser duplicate* and *two concurrent deliveries of DIFFERENT eventIds for an ABSENT order end with one document holding both entries, no duplicate-key error escaping* | DONE |
| **PR8** | integration | `apps/projector/src/placeholder-document.integration.spec.ts` › *R53 — creates a placeholder document keyed by correlationId, headerComplete false, status placed, rank 0; fills in the header fields (and sets headerComplete true, PR9) when order.placed.v1 is consumed later* | DONE |
| **PR9** | integration | `apps/projector/src/placeholder-document.integration.spec.ts` (same case as PR8 — the header-fill and headerComplete assertions) | DONE |
| **PR10** | integration | `apps/projector/src/timeline-projection.integration.spec.ts` › *R50 — appends an entry carrying eventId, eventType, occurredAt and a summary, and presents the timeline ordered by occurredAt rather than by arrival* | DONE |
| **PR11** | integration | `apps/projector/src/out-of-order-facts.integration.spec.ts` › *PR11 — a reference is written only while null: a later invoice.issued.v1 never overwrites an already-set despatchReference* | DONE |
| **PR12** | unit + integration | `apps/projector/src/domain/order-status-rank.spec.ts` › *maps each of the thirteen facts to the implied status and rank of PR12's table, with the four compensation and credit facts implying none*; `apps/projector/src/out-of-order-facts.integration.spec.ts` › *R52 — order.despatched.v1 delivered BEFORE order.placed.v1 appends both entries; status ends at despatched...* | DONE |
| **PR13** | unit | `apps/projector/src/infrastructure/persistence/delta-to-pipeline.spec.ts` › *PR13 — order.cancelled.v1 applies $ifNull ONLY to cancellationReason, written only while it is null* | DONE |
| **PR14** | unit + integration | `apps/projector/src/domain/fact-projection.spec.ts` › *PR14 unit half › never reads a clock, timestamps come from occurredAt alone*; `apps/projector/src/timeline-projection.integration.spec.ts` › *PR14 integration half — updatedAt is the GREATEST occurredAt applied* (inline assertion in the R50 case) | DONE |
| **PR15** | integration | `apps/projector/src/replay-determinism.integration.spec.ts` › *replaying the same nine facts, shuffled and duplicated, reproduces a BYTE-IDENTICAL document* | DONE |
| **PR16** | unit | `apps/projector/src/domain/summaries.spec.ts` › *renders a human-readable summary for each of the thirteen facts from the envelope alone, with every amount in integer minor units and its own currency* | DONE |
| **PR17** | integration | `apps/projector/src/infrastructure/signal/update-signal.integration.spec.ts` › *publishes order.updated and timeline.appended on readmodel.order.updated.<orderId>/readmodel.timeline.appended.<orderId>, received by BOTH a wildcard subscriber and a single-order subscriber* | DONE |
| **PR18** | integration | `apps/projector/src/infrastructure/signal/update-signal.integration.spec.ts` › *publishes EXACTLY ONE signal pair for a first delivery, and NONE AT ALL for a suppressed redelivery* | DONE |
| **PR19** | unit | `apps/projector/src/application/projection-apply.service.spec.ts` › *PR19 › logs and swallows a signal publication failure, acknowledging the fact rather than entering a retry that could never re-emit* | DONE |
| **PR20** | unit (structural) | `apps/projector/src/read-model-sole-writer.spec.ts` › *permits a mongodb import in apps/projector and apps/seed only* and *genuinely fires when a THIRD app (never allow-listed) acquires a mongodb import* | DONE |
| **PR21** | unit (structural) | `apps/projector/src/projector-consumes-only.spec.ts` › *PR21 › issues no NATS request to any orders.\*/fulfillment.\*/billing.\*/catalog.\* RPC subject (publish-only)* and *PR21 › declares no Drizzle dependency in package.json (no write-model access)* | DONE |
| **PR22** | integration | `apps/projector/src/infrastructure/persistence/read-model-indexes.integration.spec.ts` › *creates the orderReference uniqueness index PARTIALLY so two placeholders with a null reference both insert* and *refuses to start (fails loudly, naming the offending index) against a non-partial index of the same name* | DONE |
| **PR23** | integration | `apps/projector/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` › *records the consumer:eventId pair in the SAME single write that applies the projection* | DONE |
| **PR24** | unit (structural) | Enforced by the existing `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` › *keeps the idempotency mode registry honest against what is actually on disk* and › *requires a documented divergence banner, naming an existing behavioural-conformance spec file, from a copy that cannot share the canonical's transaction* — **not re-implemented here**, and confirmed green without editing `apps/orders` (`pnpm --filter @otc/orders exec vitest run idempotent-consumer.parity.spec` — 11/11 passed) | DONE |
| **PR25** | integration | `apps/projector/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` › `idempotent-consumer behavioural conformance — the MongoDB variant over real MongoDB` (all five cases of the copied suite) | DONE |
| **PR26** | integration | `apps/projector/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` › *the post-apply callback runs exactly once on processed and NOT AT ALL on duplicate* | DONE |
| **PR27** | unit | `apps/projector/src/application/commands/project-fact.command-handler.spec.ts` › *delegates to ProjectionApplyService.apply(envelope) with no branching on eventType*; DI shape enforced by the existing ESLint `no-restricted-syntax` guard (confirmed firing — see `progress/impl_projector_read_model.md`) | DONE |
| **PR28** | unit (structural + pure) | `apps/projector/src/domain/fact-projection.spec.ts` › *no domain/ source file imports a framework, a driver, or reads the wall clock* — the import half additionally enforced by the existing ESLint domain-purity rule (confirmed firing — see `progress/impl_projector_read_model.md`) | DONE |
| **PR29** | integration | `apps/projector/src/infrastructure/persistence/legacy-document-backfill.integration.spec.ts` › *backfills statusRank from status and processedEventKeys from events[].eventId, and a replay of all nine facts leaves events.length, status and references UNCHANGED* and *is a no-op on its second run, and on a document this projector wrote itself* | DONE |

---

## 4. The `R54` / `R55` seam with feature 25 (`gateway_rest_auth`)

Stated here so neither feature assumes the other built it.

| Concern | Owner | Why |
|---|---|---|
| Writing `order_timeline` | **24** (`PR6` – `PR15`) | `R54`'s "only writer" |
| The `mongodb`-import allow-list guard | **24** (`PR20`) | The guard belongs with the writer |
| Emitting the update signal | **24** (`PR17` – `PR19`) | `R55`'s producer half |
| Creating the read model's indexes | **24** (`PR22`) | Only the writer knows the placeholder's shape |
| `GET /orders`, `GET /orders/{id}` served from Mongo, no write-model read | **25** | `R54`'s consumer half; `feature_list.json` id 25 acceptance bullet 3 |
| `202 ProjectionPending` for an order with **no** document | **25** | `openapi.yaml` `/orders/{id}`; the projector has no HTTP surface for orders |
| Serving a `headerComplete: false` document as `200 OrderDetail` | **25** | The projector's obligation ends at setting the flag honestly (`PR9`) |
| `/orders/stream` SSE, its bounded replay buffer, `Last-Event-ID` resume, `ping` | **25** | The projector publishes; the Gateway is the only thing that holds a client connection |
| `web/components/order-detail-pending.spec` | **26** (`web_app`) | Component level |

The projector's contribution to `R55`'s *"projection pending"* clause is **structural, not behavioural**: by creating a placeholder for any fact that outruns `order.placed.v1` (`R53`), it makes the window in which no document exists as short as the first fact's arrival, and by publishing a per-order signal it gives the Gateway something to unblock on. The 202 body itself is feature 25's.

---

## 5. Out of scope — restated so it is a decision, not an omission

- **No HTTP query surface in the projector.** It exposes only the existing health controller. Feature 25 reads Mongo directly (`R54` forbids a join, not a shared read).
- **No SSE, no WebSocket, no replay buffer** — `PR17` publishes and stops.
- **No dead-letter handling** (`R16`) beyond the log-and-acknowledge of `PR3`/`PR4`. Retry counting and the `.dlq` topics are `observability_reliability`'s (feature 27), and adding a partial version here would have to be undone.
- **No OpenTelemetry.** `R56` – `R58` are feature 27's; the projector's logs carry `correlationId` today because every service's do, not because this feature builds the tracing.
- **No change to any fact payload, topic, subject naming for facts, or envelope.** The only new wire vocabulary is `PR17`'s two signal subjects.
- **No `apps/orders` edit.** `PR24`.
- **No `apps/web` edit.**
