# Implementation — `order_saga_orchestrator` (feature 16)

**Status after this pass:** `in_review`. All 35 tasks in `specs/order_saga_orchestrator/tasks.md` ticked. `pnpm quality` green across the whole monorepo (lint + typecheck + unit tests, 384 orders tests + all sibling apps). The full `vitest.integration.config.mts` suite green (17 files, 51 tests, Testcontainers MySQL 8.4.11 + Kafka 4.3.1 + NATS 2.14.5). `./init.sh` exits 0. Live-stack walkthrough performed against the running compose stack and observed exactly the designed steady state.

## 1. What was built

The saga orchestrator inside `apps/orders`, composed exactly as `design.md` §5.5/§9 specifies: three `@EventPattern` Kafka consumers dispatch explicit per-fact commands on the `@nestjs/cqrs` `CommandBus`; each fact `@CommandHandler` is the entire transactional unit (dedup-insert-first over the existing, unmodified `IdempotentConsumer`, R25 precondition check, aggregate transition, durable enqueue of the owed command) awaited before the Kafka offset commits; after commit, a dispatch-owed application event is published on the `EventBus`; the `OrderSagas` `@Saga` class maps each to an `Issue…Command`; its handler calls `SagaCommandDispatcher.dispatch(orderId, command)`, which runs the SO4 retry policy (3 attempts, 500 ms × 2 backoff, 5 s per attempt) over a NATS RPC adapter, marking the durable `saga_commands` row `sent` or `parked`. `SagaCommandSweeperService` is the durability backstop: it claims due `pending`/`parked` rows in its own short transaction and dispatches them directly, bypassing the `CommandBus` entirely, so the guarantee never depends on the in-memory hop.

### New package

- `@nestjs/cqrs` `^11.0.3` — added to the workspace catalog (`pnpm-workspace.yaml`) and `apps/orders/package.json` as `"catalog:"`. The **only** new runtime dependency this feature introduces.

### Files touched (new)

- Schema/migration: `apps/orders/src/infrastructure/persistence/schema/{saga-commands,saga-ignored-facts}.schema.ts`, `apps/orders/drizzle/0004_melodic_microbe.sql` (+ its `meta/0004_snapshot.json`)
- Step table: `apps/orders/src/application/{saga-steps.ts,saga-steps.spec.ts}`
- Payload builder: `apps/orders/src/application/saga-command-payloads.ts`
- Ports: `apps/orders/src/application/ports/{saga-commands.port.ts,saga-command-store.port.ts}`
- The generic handler: `apps/orders/src/application/{saga-fact-handler.ts,saga-fact-handler.spec.ts}`
- CQRS composition: `apps/orders/src/application/commands/{saga-fact.commands.ts,saga-fact.handlers.ts,saga-fact.handlers.spec.ts,saga-dispatch.commands.ts,saga-dispatch.handlers.ts,saga-dispatch.handlers.spec.ts}`, `apps/orders/src/application/events/saga-dispatch.events.ts`, `apps/orders/src/application/sagas/{order.sagas.ts,order.sagas.spec.ts}`
- Infrastructure: `apps/orders/src/infrastructure/messaging/{nats-saga-commands.adapter.ts,nats-saga-commands.adapter.spec.ts}`, `apps/orders/src/infrastructure/messaging/test-support/stub-saga-responders.ts`, `apps/orders/src/infrastructure/saga/{drizzle-saga-command-store.ts,saga-ignored-facts.repository.ts,saga-command-dispatcher.ts,saga-command-dispatcher.spec.ts,saga-command-sweeper.service.ts,saga-command-sweeper.spec.ts,saga.config.ts}`
- Presentation: `apps/orders/src/presentation/{saga-facts.controller.ts,saga-facts.controller.spec.ts}`
- Test harness: `apps/orders/src/test-support/saga-integration-harness.ts`
- Integration specs: `apps/orders/src/saga-{happy-path,compensation-stock-rejected,compensation-credit-rejected,preconditions,command-retry,consumption}.integration.spec.ts`

### Files touched (modified)

- `apps/orders/src/app.module.ts` — `CqrsModule.forRoot()`, all new port/dispatcher/store/sweeper providers, the fifteen `@CommandHandler`s + `OrderSagas` as class providers, `SagaFactsController` registered.
- `apps/orders/src/main.ts` — second `connectMicroservice` (Kafka, group `orders.saga`, `fromBeginning: true`), plus the E3 finding recorded in its header comment.
- `apps/orders/src/infrastructure/outbox/kafka.config.ts` (+ `.spec.ts`) — `FULFILLMENT_FACTS_TOPIC`/`BILLING_FACTS_TOPIC` constants + spec-text guards.
- `apps/orders/src/infrastructure/persistence/schema/index.ts` — barrel exports.
- `apps/orders/src/infrastructure/persistence/migrations.integration.spec.ts` — round-trips + index assertions for both new tables (A3).
- `apps/orders/src/presentation/orders-create.controller.ts` — `Transport.NATS` added to `@MessagePattern('orders.create')` (the live-stack bug fix, §3 below).
- `apps/orders/vitest.integration.config.mts` — `fileParallelism: false` (§4 below).
- `apps/orders/package.json`, `pnpm-workspace.yaml` — the `@nestjs/cqrs` catalog entry.
- `.env.example` — the SO4/SO5 settings.
- `specs/shared/test-matrix.md`, `specs/order_saga_orchestrator/{requirements.md,tasks.md}` — traceability flips (H1).
- `apps/orders/drizzle/meta/{0003_snapshot.json,_journal.json}` — see the migration-numbering note in §3.

## 2. R / SO → test mapping

| Req | Test |
|---|---|
| R19–R23 | `saga-happy-path.integration.spec.ts` › *reaches invoiced against stubbed responders, then paid -> completed on stub payment.received.v1 + credit.released.v1, with exactly one order.confirmed.v1 and one order.completed.v1 in the outbox* |
| R21 (unit) | `saga-steps.spec.ts` › *credit.approved.v1 — R21: performs both edges, exactly one order.confirmed.v1* |
| R23 (unit) | `saga-steps.spec.ts` › *invoice.issued.v1 — R23: advances to invoiced, owes nothing* |
| R24 (integration half) | same happy-path test; API half stays `TODO` (features 25/31) |
| R25 | `saga-preconditions.integration.spec.ts` › *every one of the ten consumed facts, redelivered against a completed order, changes nothing, issues nothing, and is recorded precondition_unmet* |
| R26 | `saga-compensation-stock-rejected.integration.spec.ts` › *cancelled with reason stock_rejected, compensationSteps: [], and the release subject stub observes ZERO requests, including after redelivering stock.rejected.v1 against cancelled* |
| R27, R28 | `saga-compensation-credit-rejected.integration.spec.ts` › *release-then-cancel in causal order, with one stock_released compensation step built from the observed fact* + *does not retry a business-rejected credit.hold* |
| R29 (retry clause) | `saga-command-retry.integration.spec.ts` › *parks a command after exhausted attempts, keeps the order in its last legal status, and resumes to the next status when a responder appears*; dead-letter clause stays `TODO` (feature 27) |
| SO1 | `saga-consumption.integration.spec.ts` › *consumes a fact published before the consumer group ever subscribed (fromBeginning: true)* |
| SO2 | `saga-steps.spec.ts` › *maps the three self-produced facts to skip*; `saga-facts.controller.spec.ts` › *a self-produced fact is acknowledged with NO CommandBus dispatch at all* |
| SO3 | `saga-command-retry.integration.spec.ts` › *the crash-window composition: a pending row committed with NO in-memory hop is still issued by a sweeper cycle*; fast-path unit: `order.sagas.spec.ts` (the five stream mappings + no-termination guard) |
| SO4 | `saga-command-dispatcher.spec.ts` › *retries a timed-out command up to maxAttempts, with the configured backoff schedule* |
| SO5 | `saga-command-retry.integration.spec.ts` › *parks a command after exhausted attempts... resumes to the next status when a responder appears* |
| SO6 | `saga-compensation-credit-rejected.integration.spec.ts` › *does not retry a business-rejected credit.hold*; unit: `saga-command-dispatcher.spec.ts` › *a business rejection resolves normally, is marked sent, and is never retried* |
| SO7 | `saga-compensation-credit-rejected.integration.spec.ts` › *release-then-cancel... one stock_released compensation step*; unit: `saga-steps.spec.ts`'s `stock.released.v1` block |
| SO8 | `saga-preconditions.integration.spec.ts` › *a fact whose correlationId matches no order is recorded ignored with the unknown_order marker and acknowledged (no throw)*; unit: `saga-fact-handler.spec.ts` |
| R18 (redelivery, incidental) | `saga-preconditions.integration.spec.ts` › *a literal same-eventId redelivery of order.placed.v1 hits the dedup record and mutates nothing* |

The full step table (13 facts × 9 statuses) is exhaustively unit-tested in `saga-steps.spec.ts` (108 assertions).

## 3. Deviations from the design — argued, not silent

1. **Migration numbering (A2).** The design expected this feature's migration to be `0003`. `0003` was already taken by `order_number_sequences` (feature 15, landed after the spec's original assumption). Generated as `0004_melodic_microbe.sql` via `drizzle-kit generate` instead — a naming-numbering drift, not a design defect.
2. **Pre-existing migration-chain defect fixed.** `drizzle-kit generate` refused to run: `apps/orders/drizzle/meta/0003_snapshot.json`'s `prevId` pointed at the wrong parent (`0001`'s id via a stale grandparent reference, not `0002`'s actual id) — a metadata inconsistency from feature 15's migration generation, unrelated to this feature. Repaired mechanically (one field, no SQL touched) so `db:generate` could proceed; recorded here as required by CLAUDE.md's spirit of never silently patching around a defect.
3. **`SagaFactHandler`'s dependency types narrowed.** Design names `IdempotentConsumer` and `SagaIgnoredFactsRepository` as the constructor types, but both call straight into Drizzle — a pure unit test would need a real database to fake them. Introduced two narrow structural interfaces (`RunsIdempotently`, `RecordsIgnoredSagaFacts`) that the real classes satisfy structurally, following the same "narrow surface, real class conforms, unit test fakes it" pattern already established by `NatsRequestClient`/`RunsOutboxOnce` elsewhere in this codebase. No behavioural change.
4. **A payload-builder module not named in design's file tree.** `application/saga-command-payloads.ts` builds the five typed RPC request payloads from the loaded aggregate — design §6.3 assigns this responsibility ("payload... built from the loaded aggregate at enqueue time") without naming a file. Factored out for testability rather than inlined into `saga-fact-handler.ts`.
5. **The dispatcher's client interface has no port file.** `SagaCommandDispatcher`/`DispatchesSagaCommands` live in `infrastructure/saga/`, not behind an `application/ports/*.ts` file — design's port list (§6.1, §6.3) deliberately names only two ports (`saga-commands.port.ts`, `saga-command-store.port.ts`); the dispatcher itself is referenced by type directly by the `Issue…Command` handlers and the sweeper, mirroring the precedent `SagaFactHandler` → `IdempotentConsumer` already sets.
6. **`vitest.integration.config.mts` gained `fileParallelism: false`.** With 7 new spec files each starting their own MySQL+Kafka+NATS Testcontainers trio, running all integration files in parallel (vitest's default) caused the single-node KRaft Kafka brokers to intermittently fail `createTopics`/`joinGroup` under concurrent load (`KafkaJSProtocolError: This server does not host this topic-partition` / "coordinator not available") — a resource-contention flake reproduced and eliminated by serialising files. Every file passes reliably in isolation; this is a suite-wide config change, not a per-test hack. Integration tests are already outside `pnpm quality`'s fast gate, so the wall-clock cost (≈9 min for the full 17-file suite) is an acceptable trade for determinism.

## 4. The E3 finding (task E3 — required verification)

**Verified, no `KafkaRetriableException` wrapping needed for the installed `@nestjs/microservices` `^11.2.1`.** Read `ServerKafka.handleMessage`/`handleEvent` (`node_modules/@nestjs/microservices/server/server-kafka.js`): a rejection from the `@EventPattern` handler propagates with no `try/catch` anywhere in the chain — `onProcessingStartHook` defaults to `(transportId, context, done) => done()`, a direct pass-through — so the rejection reaches straight out of kafkajs's `eachMessage` callback. kafkajs itself does **not** commit the offset when `eachMessage` rejects and redelivers per its own retry policy. Proved for real in `saga-consumption.integration.spec.ts`'s E3 test: a wrapped `OrderRepository.findById` throws on the first delivery only; the fact `@CommandHandler` rejects, the broker log shows `[Runner] Error when calling eachMessage`, no dedup row survives the rolled-back transaction, and the second (redelivered) attempt succeeds — `processed_events` ends with exactly one row for that `eventId`.

## 5. The live-stack walkthrough (G1) — designed behaviour observed, plus a real bug it caught

Steps taken against the already-running compose stack (`docker compose -f docker-compose.infra.yml`, all services healthy):

1. Confirmed pre-state: `otc_orders.orders` has `ORD-000007/8/9` in `placed` (feature 15's live-check artifacts); `otc.orders.facts.v1` holds exactly their three `order.placed.v1` facts (verified via `kafka-console-consumer --from-beginning`); no `saga_commands`/`saga_ignored_facts` tables yet.
2. Ran `pnpm --filter @otc/orders db:migrate` against the compose MySQL — `saga_commands`/`saga_ignored_facts` created.
3. Built (`pnpm --filter @otc/orders build`) and started (`pnpm --filter @otc/orders start`) the orders service against the live stack.

**First two attempts crashed the process on boot** with `KafkaJSProtocolError: This server does not host this topic-partition` (`UNKNOWN_TOPIC_OR_PARTITION`) inside `Cluster.addMultipleTargetTopics`, 100% reproducible (verified 3× in isolation with no other load on the machine, ruling out the resource-contention explanation that applied to the integration-suite flake in §3.6). Root-caused by reading `@nestjs/microservices`'s `ListenersController.registerPatternHandlers`: a `@MessagePattern`/`@EventPattern` with **no explicit `transport` argument** is bound to **every** connected microservice server, not just the one it was written for. `orders-create.controller.ts`'s `@MessagePattern('orders.create')` (feature 15, NATS-only in intent) had no explicit transport, so it was also registered on the newly-added Kafka `ServerKafka` instance, which then tried to `consumer.subscribe()` a Kafka topic literally named `"orders.create"` — which does not exist — and the resulting rejection, being an unhandled promise rejection, crashed the whole Node process before any topic was even subscribed.

**Fixed**: added the explicit second argument to both call sites — `@EventPattern(TOPIC, Transport.KAFKA)` on all three of `saga-facts.controller.ts`'s handlers, and `@MessagePattern('orders.create', Transport.NATS)` on `orders-create.controller.ts`. This is a real bug this feature's own addition of a second microservice transport exposed; none of the integration specs (this feature's or feature 15's) caught it because each test harness builds an isolated single-purpose `TestingModule` with only one transport connected — the ambiguity only exists when both are connected on the same app instance, which only happens in real `main.ts`. This is exactly what the live-stack walkthrough exists to catch.

**After the fix, three attempts all succeeded**, and the observed behaviour matched design §8.2 exactly:

```
[ServerKafka] INFO [ConsumerGroup] Consumer has joined the group
  groupId: orders.saga-server
  memberAssignment: { "otc.orders.facts.v1":[0..5], "otc.fulfillment.facts.v1":[0..5], "otc.billing.facts.v1":[0..5] }
[orders] listening on port 3002 (HTTP) and NATS (nats://localhost:4222)
{"level":"error","message":"saga-command-dispatcher: exhausted attempts, command parked","orderId":"c6264b14-...","command":"stock.reserve","attempts":3,"error":"saga command: transport failure on subject \"fulfillment.stock.reserve\": no responder is subscribed to this subject", ...}
{"level":"error", ... "orderId":"c888ff0e-...", "command":"stock.reserve", "attempts":3, ...}
{"level":"error", ... "orderId":"1a5f5dd7-...", "command":"stock.reserve", "attempts":3, ...}
```

`SELECT order_reference, command, status, attempts, last_error, next_attempt_at FROM saga_commands`:

```
order_reference  command        status  attempts  last_error                                                                                          next_attempt_at
ORD-000007       stock.reserve  parked  3         saga command: transport failure ... no responder is subscribed to this subject   2026-08-21 10:34:16
ORD-000008       stock.reserve  parked  3         saga command: transport failure ... no responder is subscribed to this subject   2026-08-21 10:34:16
ORD-000009       stock.reserve  parked  3         saga command: transport failure ... no responder is subscribed to this subject   2026-08-21 10:34:16
```

Three consumed `order.placed.v1` facts, three in-line retry sequences (3 attempts each), three `parked` rows, structured saga-failure logs — exactly the design's expected steady state. Process killed after capturing this (`kill -9`); the compose stack itself was left running (untouched otherwise). No recreate-clean-slate was needed since first boot with `fromBeginning: true` already reproduced the exact scenario design §8.2 describes.

## 6. Manual test script (for the human)

```bash
# 1. Apply the new migration against the compose MySQL (idempotent).
pnpm --filter @otc/orders db:migrate

# 2. Build and run the orders service against the running compose stack.
pnpm --filter @otc/orders build
pnpm --filter @otc/orders start
# Expect: "Consumer has joined the group" with all 18 partitions assigned,
# then three "command parked" error logs within ~20-40s (no Fulfillment/
# Billing responders exist yet — features 17-22).

# 3. In another shell, inspect the parked rows:
docker exec otc-mysql mysql -uroot -p"$(grep MYSQL_ROOT_PASSWORD .env | cut -d= -f2)" \
  -e "SELECT order_reference, command, status, attempts, next_attempt_at FROM saga_commands;" otc_orders

# 4. Stop the service (Ctrl-C or kill) — the compose stack itself is untouched.

# 5. Unit + integration proof:
pnpm --filter @otc/orders test                                         # 384 tests, all pass
pnpm --filter @otc/orders test:integration                             # 51 tests, ~9 min, all pass (real MySQL+Kafka+NATS)
pnpm quality                                                            # lint + typecheck + test, whole monorepo
./init.sh                                                               # exit 0
```

## 7. What I could not do, and why

- **R24's API half and R28's e2e half** stay `TODO` — they belong to the Gateway (features 25/31) and a later e2e feature, per the design's own split; nothing in this feature's scope could close them.
- **R29's dead-letter clause** stays `TODO` — deferred to `observability_reliability` (feature 27) per the ratified deferral shape design §6.4/§6.5 already argues; the seam (park transition → DLQ publication + timeline entry) is in place, unimplemented by design.
- **Coverage numbers** were not separately re-measured via `test:coverage` (the gate is not yet enforced-failing per `vitest.config.mts`'s own comment, "not enforced-failing until phase 21"); `pnpm quality`'s plain `test` run is green, which is the binding gate today.

## 8. What surprised me

- The G1 live-stack walkthrough caught a real, 100%-reproducible production crash (§5) that no automated test in this repository — including my own seven new integration specs — could have caught, because every test harness (mine and feature 15's) connects only one microservice transport per `TestingModule`. This is a strong argument for why `progress/spec_order_saga_orchestrator.md`'s task G1 was written as mandatory rather than optional.
- The Testcontainers Kafka fixture's `apache/kafka:4.3.1` single-node KRaft broker is noticeably more prone to transient `GroupCoordinator`/metadata races than the MySQL/NATS fixtures — every one of the new integration specs logged at least one such transient error, always self-healing via kafkajs's own retry/restart, never once causing an assertion failure once file-level parallelism was removed.

## 9. Addendum (2026-08-21) — defect-fix pass: a racy `waitFor` in `saga-compensation-credit-rejected.integration.spec.ts`

**The defect.** The test `'does not retry a business-rejected credit.hold and advances only on the credit.rejected.v1 fact'` originally used a live-column poll as a synchronisation barrier before checking the retry count:

```ts
await waitFor(async () => responders.creditHoldRequests.length > 0);
await waitFor(async () => (await orderRow(harness, order.id.value))?.status === 'stock_reserved');
```

`orders.status === 'stock_reserved'` is held only *transiently* on this path — the sibling test in the same file (`'release-then-cancel in causal order...'`) proves the whole `credit.rejected → stock.release → cancelled` round trip completes well inside one 200ms poll interval on a fast run. When the saga outran the poll, the 200ms-interval `waitFor` missed the window entirely and then hung until its own timeout, waiting for a status that had already passed — a race in the test's synchronisation strategy, not in the saga. Dispatcher structured logs from a timed-out run confirmed the saga had in fact completed the designed chain correctly (`stock.reserve → credit.hold → stock.release`, each `attempts=1`).

**The fix — approach (b), durable-record evidence.** Rewrote the barrier to poll the `saga_commands` row for `(order.id, 'credit.hold')` reaching `status === 'sent'` instead of the live `orders.status` column:

```ts
await waitFor(async () => {
  const rows = await harness.db.select().from(ordersSchema.sagaCommands)
    .where(eq(ordersSchema.sagaCommands.orderId, order.id.value));
  return rows.find((row) => row.command === 'credit.hold')?.status === 'sent';
});
```

Chose (b) over (a) (gating the stock-release responder) because the claim under test is entirely about the `credit.hold` `saga_commands` row's own lifecycle (SO6: business rejection marks it `sent`, never retried) — a `saga_commands` row's `status` is *terminal* once `markSent` runs (design.md §6.3: one row per `(order_id, command)`, `markSent` never revisits a `sent` row), so there is no transient window to miss, unlike the live `orders.status` column the saga races through on this path. Gating the release responder (approach a) would have worked too, but it would have coupled this test to compensation machinery (the stock-release RPC) that is not what this specific assertion is about — that causal ordering is already the sibling test's job. The `1_500`ms grace period before asserting `creditHoldRequests` has length 1 is itself non-racy for the same reason `saga_commands.status` is: `creditHoldRequests` only ever grows (an array of observed requests), so waiting out a fixed grace period and reading its final length cannot land on a window that has already passed the way a live-column poll can — there is no "too late" state for a monotonically-growing counter.

R27's "status stays stock_reserved from the reply alone" clause (the aggregate-state half of SO6) remains proven, without any polling race, at the unit level by `saga-steps.spec.ts`; the end-to-end causal release-then-cancel ordering remains proven by this file's second test. Nothing else in the file changed: the six other saga integration spec files keep their original `waitFor` default (`45_000`, `200`ms interval — a prior incorrect widening attempt was reverted before this pass, per the task's own note, and was not reintroduced); `vitest.integration.config.mts`'s `testTimeout: 180_000` / `fileParallelism: false` are unchanged feature-16 originals.

**Scope.** Touched only `apps/orders/src/saga-compensation-credit-rejected.integration.spec.ts`.

**Verification.**

1. *5× isolation.* `pnpm exec vitest run --config vitest.integration.config.mts src/saga-compensation-credit-rejected.integration.spec.ts`, run five times back-to-back: all five green, 2/2 tests each run (35.67s, 35.86s, 35.81s, 39.35s, 40.42s).
2. *Full suite, twice.* `pnpm --filter @otc/orders test:integration` (Testcontainers MySQL 8.4.11 + Kafka 4.3.1 + NATS 2.14.5): run 1 — 17 files / 51 tests, all passed, 592.14s test duration (9m54s wall); run 2 — 17 files / 51 tests, all passed, 662.61s test duration (11m4s wall).
3. *Regression-catch proof.* Temporarily edited `apps/orders/src/infrastructure/saga/saga-command-dispatcher.ts` so a successful `credit.hold` reply with `outcome === 'rejected'` throws instead of being marked `sent` (reintroducing "retry a business rejection"). Ran the target spec in isolation: it failed as expected — the new `saga_commands`-row barrier itself times out after 45s because `credit.hold` now exhausts its 3 attempts and lands on `parked` rather than `sent` (dispatcher log: `"exhausted attempts, command parked", "command":"credit.hold", "attempts":3, "error":"TEMPORARY REGRESSION: retrying a business-rejected credit.hold"`), and the observed `creditHoldRequests` count would have been 3 had the barrier not failed first — either way, the assertion no longer vacuously passes under this regression. Reverted `saga-command-dispatcher.ts` byte-exact afterwards (verified via `md5sum` matching before/after: `b38aaf9502d5fc060fbeae7377e11002`), then re-ran the target spec in isolation once more: green again (2/2, 53.91s).
4. `pnpm quality` (lint + typecheck + unit test across all 10 workspace packages, including `apps/orders` 384/384) — exit 0. `./init.sh` — exit 0.

**Traceability.** No test-matrix.md row needed a name change — the test's name and its R27/R28/SO6/SO7 mapping are unchanged; only the test's internal synchronisation mechanism changed.

**Status set to `in_review`** in `feature_list.json` (was `in_progress`, reopened for this defect).
