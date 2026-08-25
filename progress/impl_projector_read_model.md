# `projector_read_model` (feature 24, phase 12) — implementation record

Status set on close: **not flipped** in `feature_list.json` (reviewer-owned). Currently `spec_ready` from the prior spec pass; this pass is the implementation and is submitted `in_review`-ready.

---

## What was built

`apps/projector` turned from a four-file scaffold into the third fact consumer and the sole runtime writer of the `order_timeline` read model, per `specs/projector_read_model/design.md`.

**Domain (`apps/projector/src/domain/`, zero framework/driver imports, ESLint-enforced):**
- `order-status-rank.ts` — PR12's thirteen-row table, `impliedStatusOf`/`rankOf`, throws `UnknownEventTypeForRankError` rather than defaulting.
- `money-format.ts` — integer-minor-units-only rendering with thousands grouping, never converted to major units (`formatMinorUnits(24900, 'EUR') → "24 900 EUR"`, design.md §4's own worked example).
- `summaries.ts` — the thirteen summary/detail builders (PR16), voice-matched to `apps/seed/src/data/sagas.data.ts`.
- `projection-delta.ts` — the store-agnostic `ProjectionDelta` value, self-contained (does not import `OrderTimelineDocument` from infrastructure).
- `fact-projection.ts` — `projectFact(envelope): ProjectionDelta`, a thirteen-arm switch with no silent default; unknown types throw `UnknownFactTypeError` before any PR12 lookup happens.

**Persistence (`apps/projector/src/infrastructure/persistence/`):**
- `order-timeline.document.ts`, `mongo.config.ts`, `mongo-client.ts` — the document shape and connection, adopted from `apps/seed`'s own shape plus `statusRank`/`processedEventKeys`.
- `read-model-indexes.ts` — `ensureReadModelIndexes`: the partial unique index on `orderReference`, plus `{status:1, updatedAt:-1}`; fails loudly (naming the offending index) on `IndexOptionsConflict`.
- `legacy-document-backfill.ts` — the one-shot boot backfill (PR29), filtered on `{statusRank: {$exists: false}}`.
- `delta-to-pipeline.ts` — `ProjectionDelta → $set` stage, every array/rank operand `$ifNull`-guarded.
- `mongo-read-model-writer.ts` — `MongoReadModelWriter`: Phase 1 `$setOnInsert` upsert (E11000 retry-exactly-once, here and only here) then Phase 2 via `MongoIdempotentConsumer`.

**Messaging (`apps/projector/src/infrastructure/messaging/`):**
- `kafka.config.ts` + spec — the three topic constants, text-scanned against `asyncapi.yaml`.
- `idempotent-consumer.ts` — `MongoIdempotentConsumer`, the documented variant (PR23-PR26), banner carrying the canonical path, `Divergence:` and `Behavioural conformance:` lines.
- `test-support/idempotent-consumer-conformance.ts` — copied verbatim from `apps/orders`, banner added.
- `idempotent-consumer.parity.integration.spec.ts` — the copied conformance suite run against the real variant over real MongoDB, plus PR23/PR26 direct assertions.

**Signal (`apps/projector/src/infrastructure/signal/`):**
- `nats.config.ts`, `nats-client.ts` — copied shapes from `apps/orders`.
- `nats-update-signal.publisher.ts` — `NatsUpdateSignalPublisher`, two fire-and-forget publishes per applied fact, `x-correlation-id` in headers.

**Application (`apps/projector/src/application/`):**
- `ports/consumer-name.ts`, `ports/clock.port.ts`, `ports/read-model-writer.port.ts`, `ports/update-signal.port.ts`.
- `commands/project-fact.command.ts` + `.command-handler.ts` — one command, one handler, delegation only (PR27).
- `projection-apply.service.ts` — `projectFact → writer.apply(...)` with the signal publication as the writer's post-apply callback; PR18/PR19's ordering lives here.

**Presentation:**
- `presentation/projector-facts.controller.ts` — three `@EventPattern(TOPIC, Transport.KAFKA)` handlers, `parseFactEnvelope`, PR3/PR4 log-and-acknowledge branches.

**Wiring:**
- `app.module.ts` — `CqrsModule.forRoot()`, `useFactory` + explicit tokens throughout; `MONGO_DB` and `NATS_CONNECTION` exported (plain symbols, not domain ports) so `main.ts` can run the boot steps against the same connection and so Kafka+MongoDB-only integration specs can override the NATS connection without a broker.
- `main.ts` — `ensureReadModelIndexes` + `backfillLegacyDocuments` **before** `startAllMicroservices()`; `fromBeginning: true`, commented against Notifications' opposite choice.

**Structural guards:** `projector-consumes-only.spec.ts` (PR1/PR21), `main-kafka-options.spec.ts` (PR5), `read-model-sole-writer.spec.ts` (PR20).

**`apps/seed/src/writers/mongo.writer.ts`** (open point 1, approved per the leader's briefing) — `uq_order_reference` is now partial (`partialFilterExpression: { orderReference: { $type: 'string' } }`), and `toTimelineDocument` now writes `statusRank` (derived from a **local, non-imported** copy of PR12's table — the two apps must never share source) and `processedEventKeys` (derived from the fixture's own `events[].eventId`).

**Test-support** (`apps/projector/src/test-support/`): `envelope-fixtures.ts` (all thirteen facts), `kafka-test-fixture.ts` (copied), `mongo-test-fixture.ts` (a **standalone**, auth-enabled variant added — see "Surprises" below), `nats-test-fixture.ts` (copied), `projector-app-test-harness.ts` (boots the real `AppModule` against Testcontainers Kafka+MongoDB with the NATS connection overridden by a fake, for the group-G specs that are about `R50`-`R53`, not the signal).

---

## R<n> / PR<n> to test mapping

Full traceability tables are in `specs/shared/test-matrix.md` §7 (`R50`-`R55`) and `specs/projector_read_model/requirements.md` §3 (`PR1`-`PR29`), both updated in this pass. Summary:

- **R50** — `apps/projector/src/timeline-projection.integration.spec.ts` › *R50 — appends an entry carrying eventId, eventType, occurredAt and a summary, and presents the timeline ordered by occurredAt rather than by arrival*.
- **R51** — same file › *R51 — leaves the read-model document unchanged when a fact with an already-present eventId is redelivered*, reinforced by genuine concurrency in `projection-concurrency.integration.spec.ts` and the shuffled/duplicated replay in `replay-determinism.integration.spec.ts`.
- **R52** — `apps/projector/src/out-of-order-facts.integration.spec.ts` › *R52 — order.despatched.v1 delivered BEFORE order.placed.v1 appends both entries; status ends at despatched...*.
- **R53** — `apps/projector/src/placeholder-document.integration.spec.ts` › *R53 — creates a placeholder document...* and *two DIFFERENT orders' placeholders coexist, both with orderReference: null*.
- **R54/R55** — projector half only (producer side); gateway/web halves owed to features 25/26 — see the test-matrix rows' Status cells.
- **PR1-PR29** — see `requirements.md` §3; all flipped `DONE` with real case names.

---

## The four armed deletions (task group H)

All four were mutated on the live source file, run against the real spec (Testcontainers where relevant), confirmed to fail, then restored — `diff` confirmed byte-identical to the pre-mutation backup after each restore.

### H1 — `PR18` emit-on-applied
**Mutation:** deleted the `await afterApplied(applied);` call in `MongoIdempotentConsumer.runOnce` (idempotent-consumer.ts).
**Test:** `apps/projector/src/infrastructure/signal/update-signal.integration.spec.ts` › *publishes EXACTLY ONE signal pair for a first delivery, and NONE AT ALL for a suppressed redelivery*.
**Verbatim failure:**
```
AssertionError: expected +0 to be 1 // Object.is equality
- Expected: 1
+ Received: 0
 ❯ src/infrastructure/signal/update-signal.integration.spec.ts:110:28
```
(All three cases in the file failed under this mutation, including a timeout on the two wildcard/single-subscriber cases since no signal was ever published to satisfy their subscriptions.)

### H2 — `PR18` suppress-on-duplicate
**Mutation:** made `runOnce` invoke `afterApplied` **unconditionally**, even when `applied` is `null` (a synthetic stand-in document was passed on the duplicate branch, since `afterApplied`'s signature needs a document).
**Test:** same file › *publishes EXACTLY ONE signal pair for a first delivery, and NONE AT ALL for a suppressed redelivery*.
**Verbatim failure:**
```
TypeError: Cannot read properties of undefined (reading 'eventId')
 ❯ toAppliedOrderTimeline src/infrastructure/persistence/mongo-read-model-writer.ts:70:24
 ❯ MongoIdempotentConsumer.runOnce src/infrastructure/messaging/idempotent-consumer.ts:70:11
```
The crash is itself the proof: `afterApplied` fired on the duplicate branch and its (real) callback tried to read a field of a document that does not exist for a suppressed redelivery.

### H3 — `PR19` swallow-not-rethrow
**Mutation:** replaced the `try/catch` around `signalPublisher.publish(document)` in `projection-apply.service.ts` with a bare `await this.signalPublisher.publish(document);` (no catch).
**Test:** `apps/projector/src/application/projection-apply.service.spec.ts` › *PR19 › logs and swallows a signal publication failure, acknowledging the fact rather than entering a retry that could never re-emit*.
**Verbatim failure:**
```
AssertionError: promise rejected "Error: NATS unreachable" instead of resolving
 ❯ src/application/projection-apply.service.spec.ts:64:55
Caused by: Error: NATS unreachable
```

### H4 — `PR4` unknown-type log
**Mutation:** replaced the `this.logger.error(...)` call inside the `UnknownFactTypeError` branch of `projector-facts.controller.ts`'s `route` method with a bare `return;`.
**Test:** `apps/projector/src/presentation/projector-facts.controller.spec.ts` › *PR4 › logs and acknowledges an unknown eventType instead of discarding it silently (CommandBus called once, no rethrow)*.
**Verbatim failure:**
```
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times
 ❯ src/presentation/projector-facts.controller.spec.ts:48:26
```

All four files were restored and diffed byte-identical against their pre-mutation backups; `pnpm --filter @otc/projector typecheck && pnpm --filter @otc/projector test` were re-run green after restoring all four (110→111 tests passing, the +1 being the PR13 case added in this same pass).

---

## B7's own armed deletion (task group B, added after N3)

`H1`-`H4` above arm design §10.1's four fact-emission branches; they are not `B7`'s own deletion, which the reviewer correctly flagged as missing (N3). `B7` requires *deleting the backfill call* and confirming `legacy-document-backfill.integration.spec.ts` fails, and the reviewer independently verified the underlying hazard live against the actual database, so this was done as two separate armed deletions covering both halves the reviewer named:

### B7a — delete the backfill **call** (`main.ts`)
**Mutation:** removed `const backfilled = await backfillLegacyDocuments(db); console.log(...)` from `main.ts`'s `bootstrap()`, keeping `ensureReadModelIndexes(db)` in place.
**Test:** `apps/projector/src/main-kafka-options.spec.ts` › *runs ensureReadModelIndexes and backfillLegacyDocuments BEFORE startAllMicroservices (design.md §11)*.
**Verbatim failure:**
```
AssertionError: expected -1 to be greater than -1
 ❯ src/main-kafka-options.spec.ts:27:26
    25|
    26|     expect(indexesCall).toBeGreaterThan(-1);
    27|     expect(backfillCall).toBeGreaterThan(-1);
```

### B7b — neuter the backfill **body** (`legacy-document-backfill.ts`)
**Mutation:** replaced `backfillLegacyDocuments`'s entire implementation with `void db; return 0;` — no collection touched, unconditionally reports zero backfilled.
**Test:** `apps/projector/src/infrastructure/persistence/legacy-document-backfill.integration.spec.ts` — **both** cases.
**Verbatim failures:**
```
AssertionError: expected +0 to be 1 // Object.is equality
 ❯ src/infrastructure/persistence/legacy-document-backfill.integration.spec.ts:96:24
    95|       const modified = await backfillLegacyDocuments(db);
    96|       expect(modified).toBe(1);
```
```
AssertionError: expected +0 to be 1 // Object.is equality
 ❯ src/infrastructure/persistence/legacy-document-backfill.integration.spec.ts:145:22
    144|     const firstRun = await backfillLegacyDocuments(db);
    145|     expect(firstRun).toBe(1);
```

Both `main.ts` and `legacy-document-backfill.ts` were restored and `diff`-confirmed byte-identical to their pre-mutation backups. Re-confirmed green afterward: `pnpm --filter @otc/projector typecheck` (clean), the unit suite (111/111, including `main-kafka-options.spec.ts` 3/3), and `legacy-document-backfill.integration.spec.ts` (2/2, Testcontainers MongoDB).

---

## D7 — the OI12 subversion probe

1. `pnpm --filter @otc/orders exec vitest run idempotent-consumer.parity.spec` — **green, 11/11** (recorded before mutating anything).
2. Mutated `MongoIdempotentConsumer.runOnce` (banner untouched) to drop the `processedEventKeys: { $ne: dedupKey }` clause from the `findOneAndUpdate` filter — the exact N5 mutation shape ("dedup nothing").
3. Ran `apps/projector/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts` (Testcontainers MongoDB) — **4 of 7 cases failed**, all with the same signature:
```
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality
Expected: "duplicate"
Received: "processed"
```
   Failed: *a second call for the same (eventId, consumer) pair does NOT run the work and reports duplicate*; *a consumer constructed fresh over the SAME backing store still returns duplicate*; *the same eventId under a DIFFERENT consumer name runs*; *the post-apply callback runs exactly once on processed and NOT AT ALL on duplicate*.
4. Restored the file; `diff` confirmed byte-identical to the pre-mutation backup.

**This is OI12's variant branch's first real subject, and the probe confirms the guard is genuinely armed** — not merely reading a banner comment, per the N5 amendment's whole purpose. No file under `apps/orders` was touched at any point (confirmed by `git diff --stat apps/orders` being empty throughout).

---

## Concurrency proof (PR7, the reviewer's second explicit check)

`apps/projector/src/infrastructure/persistence/projection-concurrency.integration.spec.ts` drives **genuinely concurrent** deliveries with `Promise.all` against the real `MongoReadModelWriter` over real MongoDB (Testcontainers), never sequential calls and never a mocked driver:

- *two concurrent deliveries of ONE eventId apply exactly once and report the loser duplicate* — asserts on the **returned outcomes** (`['duplicate', 'processed']`, never `['processed', 'processed']`) **and** a post-apply counter (`afterAppliedCalls === 1`) — the N10 half (feature 21's binding rule: an assertion that a duplicate entry did not appear proves nothing about whether the write was attempted).
- *two concurrent deliveries of DIFFERENT eventIds for an ABSENT order end with one document holding both entries, no duplicate-key error escaping* — proves the Phase 1 upsert race and its exactly-once E11000 retry (`mongo-read-model-writer.ts`) never surfaces to the caller.

Both cases pass, run twice as part of the two full integration-suite runs recorded below.

---

## The E11000 and backfill behaviours, as observed

- **E11000 retry:** exercised live by `projection-concurrency.integration.spec.ts`'s second case — two concurrent Phase-1 upserts for the same absent order race; one wins the insert, the other's `updateOne(..., {upsert:true})` throws E11000, is retried exactly once (now matching the winner's document), and returns without surfacing the error. Never observed to retry more than once or to swallow any other error class.
- **Backfill, live:** against the running compose stack's pre-existing `otc_read_model` database (6 seeded documents, `uq_order_reference` **non-partial**, no `statusRank`/`processedEventKeys` on any document — verified before touching anything), booting the projector logged `[projector] legacy-document-backfill: 6 document(s) backfilled`, and a restart against the same (now-backfilled) database logged `0 document(s) backfilled` — confirming the filter-on-absence idempotency by construction, live, not just in the integration spec.

---

## Live boot record (task group I)

**I1 — before:** `otc_read_model.order_timeline` had **6** documents; `uq_order_reference` was a **plain** unique index (not partial); the one sampled document (`ORD-000001`) had **no** `statusRank`, **no** `processedEventKeys`, `events.length === 9`, `status === 'completed'` — matching design.md §11's stated expectation exactly. `saga_commands` row count: **80**. Fact-topic total offsets: orders 51 + fulfillment 46 + billing 50 = **147**.

Per the briefing's explicit instruction, the old non-partial index was dropped by hand before boot: `db.order_timeline.dropIndex('uq_order_reference')`.

**I2 — after first boot** (`pnpm --filter @otc/projector start` against the live compose stack, `.env`'s real credentials, a fresh `projector` consumer group with no prior offsets):
- Documents: **6 → 35** (every fact on the three topics for every order ever placed against this stack was replayed and projected).
- The sampled seeded document (`ORD-000001`): **every client-visible field byte-identical** to before (status `completed`, `events.length === 9`, same references, same totals) — **and** now carries `statusRank: 98`, `processedEventKeys` with exactly 9 entries, sorted, each `projector:<eventId>` matching the document's own nine event ids.
- Indexes: `uq_order_reference` now **partial** (`partialFilterExpression: {orderReference: {$type: 'string'}}`), plus the new `ix_status_updatedAt`.

**I3 — the expected absence, and one live order placed end-to-end:**
A `nats sub`-equivalent (a small script using the `nats` package already a dependency, subscribing `readmodel.>`) was started **before** boot. One genuinely new `order.placed.v1` fact was published directly to `otc.orders.facts.v1` (no live `orders`/`gateway` app service was running in this environment to place an order through the full stack — this is the one substitution from the literal brief, recorded honestly). The projector produced both signal frames for it:
```
readmodel.order.updated.58251443-9f6d-47ad-8d04-74c3a194973d:
  {"eventId":"6bff4852-...","orderId":"58251443-...","orderReference":"ORD-LIVEBOOT-1787593298996","status":"placed",...}
readmodel.timeline.appended.58251443-9f6d-47ad-8d04-74c3a194973d:
  {"eventId":"6bff4852-...","orderId":"58251443-...","eventType":"order.placed.v1","summary":"Order ORD-LIVEBOOT-1787593298996 placed for RETAILER01"}
```
`saga_commands` row count **unchanged at 80** before and after — the projector produced nothing but the read-model document and the two signal frames, no write-model side effect of any kind.

**I4 — restart, no duplicate (the single most important observation):**
Before restart: `order_timeline` count **36**, seeded doc `events.length === 9`, the newly-placed doc `events.length === 1`. Killed the process, restarted it (**same** `projector` consumer group, committed offsets — a normal restart, not a fresh group). Log: `legacy-document-backfill: 0 document(s) backfilled` (idempotent no-op, as designed). After restart: count **still 36**, seeded doc **still 9** events, new doc **still 1** event. A full scan across all 36 documents' `events[].eventId` arrays found **zero** intra-document duplicates. This is exactly the defect class feature 23 shipped in its in-memory form (N1) — absent here because the ledger and the effect are the same bytes in the same write.

---

## Surprises / decisions found while implementing (none change an open point's *decision*, all are implementation-level findings worth recording)

1. **`@testcontainers/mongodb`'s `MongoDBContainer` always adds `--replSet rs0`**, auth or not (verified against its source). A replica-set member advertises its **own container hostname** during SDAM topology discovery, which is unreachable from the test host outside `directConnection: true` — production `connectMongo()` (no `directConnection`) genuinely cannot talk to that container. Fixed by adding a second, **standalone**, auth-enabled fixture (`test-support/mongo-test-fixture.ts`'s `startAuthenticatedMongoTestFixture`, a plain `GenericContainer` built directly from the same pinned `mongo:8.3.8` image with the same `MONGO_INITDB_ROOT_USERNAME/PASSWORD` env vars `docker-compose.infra.yml` uses) for the group-G specs that boot the real `AppModule` through `loadMongoConfig()`'s env-var path. The plain, non-auth `MongoDBContainer`-based fixture is kept for every other spec (D-group, backfill, indexes) that talks to Mongo directly with `directConnection: true`.
2. **The official `mongo` image's entrypoint logs "Waiting for connections" TWICE** when `MONGO_INITDB_ROOT_USERNAME/PASSWORD` are set — once for a temporary, no-auth mongod that runs init scripts (creating the root user), once for the real, auth-enabled server. `Wait.forLogMessage(/Waiting for connections/)` (the first occurrence) connects to the temporary instance moments before it shuts down. Fixed with `Wait.forLogMessage(pattern, 2)`.
3. **`PR8`'s placeholder skeleton needed `updatedAt` seeded from the triggering fact's own `occurredAt`**, not left absent — `openapi.yaml` `OrderDetail.required` includes `updatedAt`, and `PR9` requires the document to be a valid `OrderDetail` the instant it exists, even in the small window between the Phase-1 insert and the Phase-2 atomic apply. Never the wall clock (`PR14`) — the same fact's `occurredAt` is used at both steps, so they never disagree.
4. **A test-authoring correction, not a code defect:** an early draft of `placeholder-document.integration.spec.ts` asserted the placeholder's status stayed `"placed"`/rank `0` after applying `stock.reserved.v1` — but PR8's skeleton is a baseline the SAME atomic apply immediately raises per the triggering fact's own implied status (PR12). The test's expectation was wrong, not the code; corrected to `status: 'stock_reserved'`, `statusRank: 2`.
5. **A second test-authoring correction:** a shared Kafka topic across every `it` in one `describe` block (`fromBeginning: true`, a fresh consumer group per test) means a later test's consumer replays **every** fact published by earlier tests in the same file, including their placeholder-creating facts. A blanket `countDocuments({orderReference: null})` assertion in `placeholder-document.integration.spec.ts`'s second case was contaminated by an earlier test's in-flight placeholder; scoped to `{_id: {$in: [orderA, orderB]}, ...}` to test only the property the case exists to prove.
6. **PR13 had no dedicated test in the first draft** — `out-of-order-facts.integration.spec.ts` covered PR11 (references) but not PR13 (`cancellationReason`, only-while-null). Added `delta-to-pipeline.spec.ts`'s *PR13 — order.cancelled.v1 applies $ifNull ONLY to cancellationReason* case before closing out.

---

## `pnpm quality` and integration suite — final state

- `pnpm quality` (root): **green**. `pnpm run lint && pnpm run typecheck && pnpm run test` across all 11 workspace packages — 0 lint errors, 0 typecheck errors, every package's fast suite green (`apps/projector`: 111/111; `apps/orders`: 399/399, unmodified; `apps/seed`: 119/119, including the `mongo.writer.ts` change; every other service unaffected).
- `pnpm --filter @otc/projector test:integration` — **run twice**, both green: **10 files / 28 tests passed** each run (Testcontainers, real Kafka `apache/kafka:4.3.1`, real MongoDB `mongo:8.3.8`, real NATS `nats:2.14.5-alpine` for the signal spec).
- `pnpm --filter @otc/projector test:coverage` — domain layer **97.59%** statements (≥80% gate), overall **93.93%** statements / **83.15%** branches (≥60% gate) on the files the fast suite touches — consistent with every other service's convention in this repo (integration-only files are outside this report by design).
- `./init.sh` — exits 0.

---

## Open points whose decision **did not** change

All 21 open points from `progress/spec_projector_read_model.md` stand as decided at the gate. Row 1 (the `apps/seed` edit) was approved and implemented exactly as specified. Row 2 (NATS core publish for the signal) was approved and implemented exactly as specified — `PR17`/`PR18` are proven against real NATS. Row 3 (the `R54`/`R55` split) is reflected in `specs/shared/test-matrix.md` as instructed: the projector halves are `DONE`-worthy evidence appended to the Status cell, the rows themselves stay `TODO` pending features 25/26. No open point's *decision* changed during implementation — only the six implementation-level findings above, none of which contradict a decision already taken.

---

## First review round — N1 and N3 (reviewer's `review_projector_read_model.md`)

The first review pass was rejected on paperwork only — **zero code defects found**, including under a materially harder concurrency attack than this feature's own spec ran (12 independent `MongoClient`s, 8 rounds, restart-mid-stream, full replay twice), a repeated D7 subversion probe (4 failed / 3 passed of 7, same four cases), and byte-identical verification of all six live seeded documents. Two findings were mine to fix (N2, the reviewer's own `progress/current.md`, and N4-N8 are carried, untouched by this pass):

- **N1 (blocking, mechanical) — `tasks.md` was 0/63 ticked.** Fixed: all **63** boxes ticked. Ten items were reworded to reality rather than ticked against stale prose (listed in full in the "What survived / was reworded" note the calling agent's response carries) — the substance of every one of those ten was already true; the wording just described a narrower or different mechanism than what was actually built (e.g. `A2`/`J1`'s "route to `test_maintainer`/`suite_runner`" describes a leader-level delegation this implementer invocation cannot perform; `E2` described `delta-to-pipeline` being called directly from the application service when it is in fact called from the infrastructure writer behind the port; `G3` claimed a `PR13` case that actually lives in `D4`). No box was ticked against work that was not done. Task **I3**'s box records its own substitution (no live `orders`/`gateway` service in this environment; substituted with a direct Kafka publish — see below) directly on the box, per the reviewer's instruction.
- **N3 (major) — `B7`'s own armed deletion was missing.** `H1`-`H4` armed design §10.1's four fact-*emission* branches; `B7` needed its own two-part deletion (delete the backfill call; neuter the backfill body) and it had not been run. Fixed — see "B7's own armed deletion" above for both mutations, both verbatim failures, both restorations confirmed byte-identical and re-confirmed green. The reviewer had already verified the underlying hazard live against the real database independently; this pass supplies the standing rule's requirement that the **implementer** arm its own deletions, not merely rely on the reviewer's confirmation.

Scope of this follow-up pass: `specs/projector_read_model/tasks.md` and this file only, plus the two B7 mutations (temporary, restored). No source file under `apps/projector/src` differs from before this pass except the two files touched and restored by the B7 probe (`main.ts`, `legacy-document-backfill.ts` — both `diff`-confirmed identical). `apps/seed`, `specs/shared/`, `feature_list.json` and `progress/current.md` were not touched.

---

## What was not done, and why

- **Task I3's "place one order end to end"** was substituted with a direct Kafka publish of one `order.placed.v1` fact, because no live `orders`/`gateway` app service was running in this environment (only the infra containers from `docker-compose.infra.yml`). The substitution proves the identical thing the literal instruction wants (a genuinely new fact reaching the projector and producing both signal frames), recorded honestly above rather than silently worked around.
- **Nothing else in the task brief was skipped.** Every task group (A-J) has real, run, green evidence above or in the file list below.

---

## File list (all under the bounded scope)

**`apps/projector/**`** — every file listed under "What was built" above (new files use `?tag`, modified use `M` in `git status`; see the close-out commit's own diff for the exhaustive list).
**`apps/seed/src/writers/mongo.writer.ts`** — the one licensed edit (open point 1/row 1).
**`specs/shared/test-matrix.md`** — `R50`-`R55` rows only, plus the §"Coverage summary" row/total for `projector_read_model` (4/6 green).
**`specs/projector_read_model/requirements.md`** — §3's `PR1`-`PR29` traceability table, all flipped `DONE`.
**`.env.example`** — `PROJECTOR_KAFKA_CLIENT_ID`/`PROJECTOR_CONSUMER_GROUP` added beside `NOTIFICATIONS_*`.
**`pnpm-lock.yaml`** — additive only (new importer entries for `apps/projector`'s already-catalogued dependencies; `git diff --stat` shows insertions only, no version changed).
**`progress/impl_projector_read_model.md`** — this file.

`apps/orders` is byte-unmodified (`git diff --stat apps/orders` is empty throughout this session). No file under `packages/`, `apps/fulfillment`, `apps/billing`, `apps/notifications` or `apps/gateway` was touched. `feature_list.json` was not touched by this session (its one line, `pending → spec_ready`, predates this implementation pass).
