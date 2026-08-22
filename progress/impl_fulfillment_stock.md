# Implementation report — `fulfillment_stock` (feature 17, phase 9)

**Status set at end of this pass:** `in_review` (feature_list.json). Every task in `specs/fulfillment_stock/tasks.md` is ticked.

## 1. What was built

### Group A — Orders side, bounded (design §10; FS1, FS2)

- `apps/orders/src/application/ports/saga-command-store.port.ts`: `enqueue` now returns `Promise<EnqueueOutcome>` (`'enqueued' | 'already_owed'`).
- `apps/orders/src/infrastructure/saga/drizzle-saga-command-store.ts`: `enqueue` uses `INSERT … ON DUPLICATE KEY UPDATE id = id`; outcome derived from `affectedRows`.
- `apps/orders/src/application/saga-fact-handler.ts`: reports `enqueued = step.commandAfter` on both outcomes, so the fast path always re-dispatches the row that actually exists.
- `apps/orders/src/saga-compensation-credit-rejected.integration.spec.ts`: extended with a second top-level `describe` reproducing the reviewer's P3 crash-loop scenario — a distinct-`eventId` duplicate `credit.rejected.v1` while `stock.release` is parked (no responder) neither crashes the consumer nor creates a second row; the existing row is re-dispatched.
- `apps/orders/src/application/ports/saga-commands.port.ts`: every method gains a `meta: SagaCommandMeta { correlationId; requestId }` parameter.
- `apps/orders/src/infrastructure/messaging/nats-saga-commands.adapter.ts`: sends `x-correlation-id`/`x-request-id` via `nats` `headers()`; `NatsRequestClient.request`'s `opts` widened to `{ timeout; headers? }`.
- `apps/orders/src/infrastructure/saga/saga-command-dispatcher.ts`: passes `{ correlationId: row.orderId, requestId: row.id }` on every attempt of every cycle.
- Test-support-only, additive: `apps/orders/src/infrastructure/messaging/test-support/stub-saga-responders.ts` gained an opt-in `respondToStockRelease: false` option (default unchanged) so the P3 reproduction could park `stock.release` deliberately. `apps/orders/src/infrastructure/saga/saga-command-sweeper.spec.ts` updated its fake `SagaCommandStore.enqueue` return type only (mechanical ripple of the port signature change).

`git diff --stat apps/orders` touches exactly 12 files: the six production files design §10 names, their six spec files (five direct + the sweeper spec's mechanical ripple + the stub-responders test-support addition).

### Group B — the domain (design §3)

- `apps/fulfillment/src/domain/reservation.ts` — `Reservation` entity (`RESERVATION_STATUSES`, `release()`/`consume()` throwing `ReservationTerminalError` from a terminal status), `ReservationView`.
- `apps/fulfillment/src/domain/stock-errors.ts` — the five `DomainError` subclasses (`InsufficientStockError`, `ReservationTerminalError`, `InvalidStockItemSnapshotError`, `FactAggregateMismatchError`, `UnknownReservationError`).
- `apps/fulfillment/src/domain/stock-item.ts` + `stock-item-snapshot.ts` — `StockItem` aggregate: `reconstitute` (refuses F1 violations), `canReserve`, `reserve`, `release` (idempotent, `[]` when nothing reserved, throws on a `consumed` reservation of this order), `consume`, `replenish` (no event), `recordOrderFact` (aggregate-id guard), `toSnapshot`.
- `apps/fulfillment/src/domain/stock-events.ts` — three fact builders mirroring `order-events.ts`'s `Indexed<TPayload>` pattern.
- `apps/fulfillment/src/domain/order-stock-reservation.ts` — `reserveOrderStock`/`releaseOrderStock`, the pure all-or-nothing domain service (F3), carrier selection (FS13), `unknown_product` (FS8).
- `apps/fulfillment/src/domain/index.ts` — the public barrel.
- Domain unit tests: `reservation.spec.ts`, `stock-item.spec.ts`, `order-stock-reservation.spec.ts` — 21 tests, domain coverage 93.63% (≥ 80% gate).

### Group C — application layer (design §5)

- Ports copied verbatim: `clock.port.ts`, `unit-of-work.port.ts`, `fact-publisher.port.ts`; `consumer-name.ts` with `CONSUMER_NAMES = [] as const` (banner explains the empty set); `stock-item-repository.port.ts`, `stock-read.port.ts`.
- `application/queries/stock.queries.ts` + `stock.query-handlers.ts` (`CheckStockHandler`, `ListStockHandler`) + spec.
- `application/commands/stock.commands.ts` + `stock.command-handlers.ts` (`ReserveStockHandler`, `ReleaseStockHandler` delegate to the plain class below; `ReplenishStockHandler` is its own transactional unit) + spec.
- `application/stock-reservation.handler.ts` (plain class) — the reserve/release transactional flow (§4.3/§4.4) + spec.
- `application/stock-application-errors.ts` — `NoKnownStockItemError`, `UnknownStockItemError`, `ConcurrentReservationChangeError` (application-layer, same `PlaceOrderError` shape Orders established).

### Group D — persistence (design §7)

- `infrastructure/persistence/drizzle-unit-of-work.ts` (Orders copy, `FulfillmentDb`/`FulfillmentTx`), `stock-item.mapper.ts`.
- `stock-item.repository.ts` — `DrizzleStockItemRepository`: `lockForOrder`, `stockIdsOfOrder`, `lockByIdsForOrder`, `lockByProductCodes` (see §2 deviations), `saveAll`.
- `stock-read.repository.ts` — `DrizzleStockReadRepository`: `availability`, `list`.
- `stock-item.repository.integration.spec.ts`, `stock-read.repository.integration.spec.ts` — 6 tests, Testcontainers `mysql:8.4.11`.

### Group E — presentation, wire, wiring (design §6, §12)

- `apps/fulfillment/package.json` gained `@nestjs/cqrs`, `@nestjs/microservices`, `class-validator`, `class-transformer`, `kafkajs`, `nats` (deps) and `@nestjs/testing`, `@testcontainers/kafka`, `@testcontainers/nats` (dev) — all `catalog:`, no new catalog entry. `tsconfig.build.json` gained the `test-support` exclude.
- `presentation/dto/stock.dto.ts` — five DTOs implementing their `@otc/contracts` request payloads.
- `presentation/rpc-error-mapper.ts` + spec.
- `infrastructure/messaging/bare-json-nats.deserializer.ts` + `.serializer.ts` + spec — the wire finding of design §6.3, subclassing `@nestjs/microservices`'s own `NatsRequestJSONDeserializer` (deep import, verified resolvable at runtime and by `tsc`) and implementing `Serializer<NestOutgoingPacket, NatsRecord>` directly.
- `presentation/stock.controller.ts` — five `@MessagePattern(subject, Transport.NATS)` responders + spec (subject-constant-equals-AsyncAPI-address test included).
- `app.module.ts` (`CqrsModule.forRoot()`, five cqrs handlers as class providers, everything else `useFactory`+`inject`) and `main.ts` (`enableShutdownHooks()`, one NATS microservice with the bare-JSON pair, HTTP on `FULFILLMENT_PORT`).

### Group F — outbox relay and consumer-pattern copies (design §8, §9)

- Copied with `// COPY OF —` banners: `outbox-recorder.ts`, `outbox-envelope-mapper.ts`, `outbox-relay.ts` (`FulfillmentDb`), `outbox-relay.service.ts`, `outbox-relay.config.ts`, `kafka-fact-publisher.ts` (default `FULFILLMENT_FACTS_TOPIC`), `create-kafka-client.ts`, `system-clock.ts`, `test-support/kafka-test-fixture.ts`, `messaging/nats.config.ts`, `messaging/test-support/nats-test-fixture.ts`.
- `kafka.config.ts`: `FULFILLMENT_FACTS_TOPIC`, `loadKafkaConfig` reads `FULFILLMENT_KAFKA_CLIENT_ID` (default `otc-fulfillment`) + spec; `.env.example` gained the var.
- `outbox-relay.spec.ts` (OI6, copy) + `outbox-relay.integration.spec.ts` (FS16, real MySQL + Kafka, 6-partition topic).
- `infrastructure/messaging/idempotent-consumer.ts` + `processed-events.repository.ts` — copied VERBATIM, verified byte-identical after banner-stripping by a scripted diff before landing, then confirmed by `idempotent-consumer.parity.spec.ts` (OI12) itself, which now compares TWO real copies (case 1 is no longer vacuous).
- `app.module.ts` wires `OUTBOX_RELAY`, `OUTBOX_RELAY_CONFIG`, `FACT_PUBLISHER`, `OutboxRelayService` exactly as Orders does.

### Group G — integration: the responders over real NATS, MySQL and Kafka (design §13)

- `test-support/stock-integration-harness.ts` — boots the **real** `AppModule` via literal `Test.createTestingModule({ imports: [AppModule] })`, by pointing `process.env` at the started MySQL/Kafka/NATS containers **before** compiling (every `useFactory` in `app.module.ts` reads env, so this is not a hand-wired substitute graph). Connects the inbound NATS microservice with the real bare-JSON (de)serializer pair. Exposes `requestBare`, `seedStock`, `seedReservation`, `outboxRowsFor`, `reservationsOf`, `stockRowOf`.
- `stock-check.integration.spec.ts` (R31), `stock-reserve.integration.spec.ts` (R32/R33 integration halves, FS3, FS5), `stock-reserve-race.integration.spec.ts` (FS6, FS7, the deadlock shape), `stock-release-idempotency.integration.spec.ts` (R34 integration half, FS9, FS10), `stock-replenish.integration.spec.ts` (FS14), `stock-list.integration.spec.ts` (FS15), `stock-wire.integration.spec.ts` (FS4).
- `vitest.integration.config.mts` adopted Orders' `fileParallelism: false`, `testTimeout: 180_000`, `hookTimeout: 120_000`.

**Full suite, run twice (once before, once after the traceability test-title fixes of §2 below), both green:**

```
Test Files  11 passed (11)
     Tests  36 passed (36)
  Duration  139.58s
```

Unit suite (`pnpm --filter @otc/fulfillment test`): `Test Files 12 passed (12)`, `Tests 57 passed (57)`. Coverage (`test:coverage`): domain 93.63% / overall 90.41% (both ≥ their CLAUDE.md gates; "overall" here is scoped to files reachable from unit specs, same convention `apps/orders/vitest.config.mts` already uses — infrastructure code is proven by the integration suite instead, not folded into this number).

**FS6 race result: 10/10 iterations, exactly one winner each time** (`outcome` pair always `['accepted', 'rejected']`, `reservedUnits` always equals the winner's units, never both). **Deadlock shape: 10/10 iterations, both orders accepted, no deadlock error** — the `ORDER BY (company_code, product_code)` lock statement makes both orders A `[P1,P2]` and B `[P2,P1]` acquire their row locks in the same global order.

## 2. Deviations from the spec, argued

1. **`StockItemRepository` gained a fourth method, `lockByProductCodes`, beyond the four design.md §5.2 names.** Design's code block lists `lockForOrder`/`stockIdsOfOrder`/`lockByIdsForOrder`/`saveAll` only; none of them fits `stock.replenish`'s shape (no `orderReference` to scope by — replenish is not a saga command). `lockByProductCodes(tx, companyCode, productCodes)` mirrors `lockForOrder`'s locking discipline (one `FOR UPDATE`, index-ordered) but loads no reservations (replenish never touches them). This is additive, not a divergence from anything the design explicitly ruled out.
2. **Test-title traceability pass.** Several of my first-draft test titles carried a `"Rxx — "`/`"FSxx — "` prefix for readability. For the **six shared `test-matrix.md` rows** (R30–R35, rule-4-bound to byte-for-byte names) I renamed the one offending title (`stock-release-idempotency.integration.spec.ts`'s R34 case) to match exactly; all seven shared-row test titles now match `specs/shared/test-matrix.md` verbatim. For the **local `FSn` rows** (`requirements.md` §2, not bound by test-matrix.md's rule 4) I removed the prefixes from most titles for cleanliness and, where a composite test covers more ground than the originally-imagined one-line quote (e.g. `FS3`'s integration case, which asserts the accepted reply *and* the reservation row *and* the counter *and* the correlation/causation stamping in one test), updated `requirements.md`'s citation to quote the real title rather than force a narrower rename that would misrepresent what the test actually proves.
3. **`FS14`'s domain-unit clause reuses `R61`'s domain test rather than a separate one.** `requirements.md` §1.6 defines FS14 as the all-or-nothing `NOT_FOUND` refusal — a behaviour with no domain-unit half of its own (the domain per-line replenish logic is entirely `R61`'s). The pre-written local traceability row quoted a slightly different case name (*"replenishes units only and appends no event"*) than R61's own quoted name; I did not fabricate a redundant near-duplicate domain test just to match that text — I pointed FS14's domain-unit citation at the real, single test that exists (`stock-item.spec.ts` › `stock-replenishment` › the R61 case) and noted the reuse in the row itself.
4. **`ConcurrentReservationChangeError`/`NoKnownStockItemError`/`UnknownStockItemError` are application-layer errors (`stock-application-errors.ts`), not domain errors.** Design §3.4 lists exactly five domain error classes; these three are refusals raised *above* the domain (no carrier aggregate, a locking read disagreeing with its own pre-read, an unknown replenish product) — the same split `apps/orders/src/application/place-order.errors.ts` established for its own application-layer refusals. `rpc-error-mapper.ts` maps both families in one exhaustive table, exactly as design §6.4 describes.

No other deviation. Every method signature, lock protocol step, idempotency rule and fact-builder shape in design.md §3–§9 is implemented as written.

## 3. Live boot — design §11, H1–H3

Compose stack already running (`docker compose -f docker-compose.infra.yml ps` — mysql, kafka, nats, mongodb, jaeger, prometheus, grafana, otel-collector, sonarqube, n8n all healthy). No Orders/Fulfillment process was running at the start of this pass.

### H1 — pre-state (recorded before rebuilding Orders)

```
mysql> SELECT order_reference, command, status, attempts, next_attempt_at FROM otc_orders.saga_commands ORDER BY order_reference;
order_reference  command        status   attempts  next_attempt_at
ORD-000007       stock.reserve  parked   9         2026-08-21 10:59:25
ORD-000008       stock.reserve  parked   9         2026-08-21 10:59:23
ORD-000009       stock.reserve  parked   9         2026-08-21 10:59:22

mysql> SELECT order_reference, status FROM otc_orders.orders WHERE order_reference IN (...);
ORD-000007  placed
ORD-000008  placed
ORD-000009  placed
```

`pnpm --filter @otc/orders build` → `pnpm --filter @otc/orders start` (19:02:53 UTC). Log: Nest boots, the `orders.saga-server` Kafka consumer group joins, HTTP + NATS both up. Within one sweeper cycle the three rows were re-issued **with headers this time** — confirmed by the attempts counter climbing 9 → 12 and the dispatcher's own structured log line naming the transport failure (`no responder is subscribed to this subject`) — still parked, exactly as design predicted (Fulfillment not started yet).

### H2 — Fulfillment started, sweeper re-issues

`pnpm --filter @otc/fulfillment build` → `pnpm --filter @otc/fulfillment start` (19:03:20 UTC). Log: Nest boots, `StockController` mapped, HTTP + NATS both up, no Kafka consumer (as designed — Fulfillment consumes no fact in this feature).

**Real finding, not a bug:** the sweeper's next cycle produced

```
{"level":"error","message":"saga-command-dispatcher: exhausted attempts, command parked",
 "orderId":"c888ff0e-...","command":"stock.reserve","attempts":15,
 "error":"saga command: transport failure on subject \"fulfillment.stock.reserve\": responder returned NOT_FOUND: stock.reserve: order ORD-000009 names no product this company stocks — no carrier aggregate for a fact",
 "nextAttemptAt":"2026-08-21T17:15:02.975Z"}
```

for all three of ORD-000007/8/9. Root cause, confirmed by direct query:

```
mysql> SELECT payload FROM otc_orders.saga_commands WHERE order_reference='ORD-000007' AND command='stock.reserve';
{"lines":[{"units":2,"productCode":"PRD-0001"}],"companyCode":"ALBIONFOODS", ...}

mysql> SELECT DISTINCT company_code FROM otc_fulfillment.stock;
FRESHFR / GERMANFOODS / IBERFOODS / TOOLIBERIA / UKDISTRIB   -- no ALBIONFOODS row at all
```

`ALBIONFOODS` and `PRD-0001` are both genuine rows in Orders' own `companies`/`products` reference tables — this is a **pre-existing `apps/seed` data gap** (only 5 of ~22 companies got a seeded `stock` row), not caused by this feature. It is also **exactly** the scenario design.md §3.3 designs for and names an open point: *"If no line resolves to a known item there is no carrier aggregate for the fact... reply RpcError NOT_FOUND; the orchestrator treats it as transport failure and parks the command for a human, which is the correct outcome for a contract violation."* The three orders correctly stay parked, loud and safe — this is the negative path working as designed, observed live and unattended, not a defect.

**To also demonstrate the designed happy path unattended**, I placed a fresh order against a company/product pair Fulfillment *does* stock (`IBERFOODS`/`PRD-0001`, both seeded — 500 units on hand) via `orders.create` (`ClientProxyFactory`, `Transport.NATS` — the shape a real caller uses; **see the `orders.create` reply-shape finding below**):

```
ORD-000011 placed → order.placed.v1 → orchestrator issues stock.reserve (headers present)
→ Fulfillment: reservations row created (PRD-0001, 3 units, reserved), stock.reserved_units += 3
→ stock.reserved.v1 published to otc.fulfillment.facts.v1 (2026-08-21 17:09:18)
→ orchestrator consumes it, orders.status → stock_reserved, issues credit.hold
→ credit.hold: NoResponders (Billing does not exist) → 3 attempts → parked
```

Final state, queried directly:

```
mysql> SELECT order_reference, command, status, attempts FROM otc_orders.saga_commands WHERE order_reference IN ('ORD-000010','ORD-000011');
ORD-000010  credit.hold    parked  6
ORD-000010  stock.reserve  sent    0
ORD-000011  credit.hold    parked  6
ORD-000011  stock.reserve  sent    0

mysql> SELECT order_reference, status FROM otc_orders.orders WHERE order_reference IN ('ORD-000010','ORD-000011');
ORD-000010  stock_reserved
ORD-000011  stock_reserved

mysql> SELECT order_reference, product_code, units, status FROM otc_fulfillment.reservations WHERE order_reference IN ('ORD-000010','ORD-000011');
ORD-000010  PRD-0001  3  reserved
ORD-000011  PRD-0001  3  reserved

mysql> SELECT event_type, correlation_id, published_at FROM otc_fulfillment.outbox WHERE event_type LIKE 'stock.%' AND published_at IS NOT NULL ORDER BY seq DESC LIMIT 2;
stock.reserved.v1  cf5a406f-...  2026-08-21 17:09:18
stock.reserved.v1  ce8bee7c-...  2026-08-21 17:08:53
```

This is exactly design §11's steady state (three `sent` `stock.reserve` rows would exist too, had the original three not hit the genuine seed gap): `sent` reserve, `parked` credit.hold (Billing does not exist yet), `stock_reserved` order status, one `stock.reserved.v1` fact, reserved reservation rows — unattended, first cross-service saga execution, live.

### `orders.create` reply-shape finding — confirms a design.md §6.3 prediction, live

My first attempt used a **raw** `nats.request()` (bare JSON, exactly what Orders' own adapters send/decode) against `orders.create` and it **timed out on my client** — but the order (`ORD-000010`) was placed anyway. This is `ServerNats` treating an id-less bare request as an **event** (`handleEvent` runs the handler, never replies) — the exact failure design.md §6.3 predicted for `orders.create`, which this feature deliberately left unchanged (Fulfillment's responders got the bare-JSON (de)serializer pair; Orders' own `orders.create` did not — "flagged, not changed here"). Switching to `ClientProxyFactory`/`Transport.NATS` (the Nest-packet shape `orders.create` actually expects) got a normal reply. **Confirms the design's hand-over note for feature 25 is real and live-reproducible, not theoretical.**

### H3 — the negative check

Sent one raw `stock.reserve` request with **no** `x-correlation-id`/`x-request-id` headers directly against the running Fulfillment:

```
$ node -e '... nc.request("fulfillment.stock.reserve", <bare JSON, no headers>, {timeout:5000}) ...'
{
  "code": "VALIDATION_FAILED",
  "message": "x-correlation-id and x-request-id are required headers and must be valid UniqueIds (FS3)",
  "occurredAt": "2026-08-21T17:10:08.345Z"
}
```

Loud (an explicit `RpcError`, not a hang or a silent drop) and safe (no reservation row, no counter change, no fact) — FS3's refusal exactly as designed. (Per H3's own wording, "or send one raw stock.reserve without headers" is an explicit alternative to the before/after restart ordering — used here since Orders was already correctly rebuilt-first for H1/H2 and restarting it out of order would have discarded that evidence.)

Both processes (Orders PID printed at start, `pnpm --filter @otc/orders start`; Fulfillment similarly) were left running against the compose stack for the human to inspect; stop with `Ctrl-C` or `pkill -f 'node dist/main.js'`.

## 4. Manual verification script for the human

1. `docker compose -f docker-compose.infra.yml up -d` (already running throughout this session).
2. `pnpm --filter @otc/orders build && pnpm --filter @otc/orders start` — confirm log lines `[orders] listening on port 3002 (HTTP) and NATS (...)` and the Kafka consumer group joining.
3. `pnpm --filter @otc/fulfillment build && pnpm --filter @otc/fulfillment start` — confirm `[fulfillment] listening on port 3003 (HTTP) and NATS (...)`.
4. Within ≤30s (`SAGA_SWEEPER_INTERVAL_MS` default), `SELECT order_reference, command, status, attempts FROM otc_orders.saga_commands;` — ORD-000007/8/9 stay `parked` with a `NOT_FOUND … names no product this company stocks` error (the genuine `apps/seed` gap for `ALBIONFOODS`, described above) — this is the correct, designed refusal for a contract violation, not a bug to fix here.
5. Place a fresh order against a company Fulfillment *does* stock, e.g. `IBERFOODS`/`PRD-0001` (also `FRESHFR`, `GERMANFOODS`, `TOOLIBERIA`, `UKDISTRIB` are seeded) — via `ClientProxyFactory`/`Transport.NATS` against `orders.create` (a raw bare-JSON client will time out on this ONE endpoint only — see the finding above; Fulfillment's five `fulfillment.stock.*` subjects all accept bare JSON directly, verified by `stock-wire.integration.spec.ts`). Watch it reach `stock_reserved` and park at `credit.hold` within seconds.
6. `pnpm quality` (root) — lint + typecheck + test, all green. `pnpm --filter @otc/fulfillment test:integration` — 11 files / 36 tests, Testcontainers MySQL + Kafka + NATS, green. `./init.sh` — exit 0.

## 5. Packages installed (for the commit message)

`apps/fulfillment/package.json` — all already in the workspace pnpm catalog, no new catalog entry:

- `@nestjs/cqrs` — the CommandBus/QueryBus the five responders dispatch on.
- `@nestjs/microservices` — the NATS transport (`@MessagePattern`) and the deep-import base classes the bare-JSON (de)serializer pair extends.
- `class-validator`, `class-transformer` — the five request DTOs.
- `kafkajs` — the outbox relay's producer (copied from Orders).
- `nats` — the inbound RPC transport and, in tests, the raw client the harness uses.
- Dev: `@nestjs/testing` (the integration harness's `Test.createTestingModule`), `@testcontainers/kafka`, `@testcontainers/nats` (the two new container fixtures this feature needed beyond `@testcontainers/mysql`, already present).

## 6. Hand-over

- **Orders advisories D2 (dispatcher `Date.now()`), D4 (`0002_snapshot.json.prevId`), D5 (`-server` consumer-group suffix), D6 (`@Optional()` loggers)** — explicitly untouched, as design §10 states; still owed to the next Orders-touching pass.
- **The relay-family parity guard precondition for feature 19** (design §8.3): the Fulfillment copies of `outbox-relay.ts`/`outbox-relay.service.ts`/`outbox-relay.config.ts`/`kafka-fact-publisher.ts`/`create-kafka-client.ts` all carry the `// COPY OF —` banner shape OI12 requires, but the guard itself is **not yet armed** for this family — `outbox-relay.ts` still imports the service-specific `FulfillmentDb`/`OrdersDb` types, so a byte-identity comparator needs the canonical made service-neutral first (e.g. `MySql2Database<Record<string, unknown>>`). Feature 19 (`billing_credit`, the third copy) owns that refactor + arming the guard.
- **The `orders.create` reply-shape note for feature 25** — reproduced live in this pass (§3 above): `orders.create` still replies in the Nest-packet shape (`{response, isDisposed, id}`), unlike Fulfillment's five bare-JSON responders. The Gateway (feature 25) must either call it with `ClientProxy` or Orders adopts the bare-JSON (de)serializer pair this feature designed for Fulfillment.
- **The `apps/seed` `ALBIONFOODS`/`PRD-0001` (and 17 other companies') missing `stock` rows** — discovered live in this pass, not a defect of this feature. `apps/seed`'s stock-seeding data only covers 5 of the ~22 seeded companies. Whoever next touches `apps/seed`'s Fulfillment writer should decide whether every seeded company needs a stock row, or whether the three originally-parked demo orders (ORD-000007/8/9) should simply be re-seeded against a company that has one.
- **Feature 18 (`fulfillment_despatch`)** starts from: `StockItem.consume(orderReference)` implemented and unit-tested (FS11), ready and unused; the guarded `idempotent-consumer.ts`/`processed-events.repository.ts` copy (now a REAL second copy, not a placeholder) to build its own `@EventPattern` consumer from if it needs one; `consumer-name.ts`'s `CONSUMER_NAMES = []` will need the shared vocabulary to grow first if Fulfillment ever gains a consumer.
- **`R36`** (despatch.create) and **`R61`'s API half** stay `TODO` in `specs/shared/test-matrix.md`, exactly as scoped — feature 18 and feature 25 respectively.

## 7. R/FS → test mapping

See `specs/shared/test-matrix.md` §4 (R30–R35, R61 domain half) and `specs/fulfillment_stock/requirements.md` §2 (FS1–FS17) — both flipped to `DONE` with exact test file/case citations in this pass, per the traceability rule (renaming a test = editing its row).

## 8. What could not be done / left as designed-TODO

- `R36`, `R61`'s API half — out of scope by the spec's own scope note, owned by features 18 and 25.
- The relay-family parity guard — deferred to feature 19 by design.md §8.3, precondition stated above.
- Advisories D2/D4/D5/D6 — explicitly out of this feature's bounded §10 scope.

## 9. Surprises

- The live boot surfaced a genuine `apps/seed` data completeness gap (18 of ~22 companies have no `stock` row) that happened to collide with the exact three demo orders parked since feature 16 — and the collision produced exactly the `NOT_FOUND`/"no carrier" edge case design.md §3.3 designed for but had not yet been observed live. Worth flagging to whoever owns `apps/seed` next.
- Reproducing the `orders.create` bare-JSON-vs-Nest-packet mismatch live (via a raw `nats.request()` that timed out on the client while the order was placed anyway) was an unplanned but useful confirmation of design.md §6.3's own prediction — recorded as `ORD-000010` in the final state, alongside the deliberately-placed `ORD-000011`.

## 10. Addendum — 2026-08-22, fixing review defect D1 (FS5's "(in any status)" clause untested)

**The gap.** `progress/review_fulfillment_stock.md` §1.2/§3 rejected the feature on one narrow defect: the FS5 short-circuit in `stock-reservation.handler.ts`'s `reserve()` (line 44's `existingReservations` filter) correctly has no status condition — any reservation row for the order, whatever its status, short-circuits to `already_reserved` — but nothing in the suite exercised a *terminal*-status row before a `stock.reserve`. The reviewer's unplanned fifth mutation, adding `&& reservation.status === 'reserved'` to that filter, survived the entire 57-unit/36-integration suite: with the mutation, a re-issued `stock.reserve` for an order whose reservations were already `released` (the saga-compensated case) would silently re-reserve instead of answering `already_reserved` — exactly the double-reserve hazard spec open point 7 was decided to prevent.

**The fix — two tests, no production code touched.**

1. **Handler unit test** — `apps/fulfillment/src/application/stock-reservation.handler.spec.ts`, new `it.each(['released', 'consumed'])('FS5 — already_reserved path short-circuits on a %s reservation (any status), calling no domain function and no saveAll', ...)`: seeds a `StockItem` whose one existing reservation for the order is `released` (and, in the second case, `consumed`), asserts the reply is `already_reserved` carrying that reservation's ref, `saveAll` is never called, and `reservedUnits`/the reservation's own status are unchanged. Proves FS5.

2. **Integration case** — `apps/fulfillment/src/stock-reserve.integration.spec.ts`, new `it('FS5 — answers already_reserved for an order whose only existing reservation is already released (the saga-compensated case), reserving nothing new', ...)`: seeds a stock row plus a `released` reservation for the order via `harness.seedReservation(...)`, re-issues `stock.reserve` for the same order/product/units through the real NATS/MySQL/Kafka path, asserts `already_reserved` with the existing ref, `reserved_units` stays `0` (the mutant would drive it to `3`), the reservation row stays `released` (no new row), and the outbox has **zero** rows for that request's `correlationId` (no fact emitted). Synchronised only on terminal evidence (the reply and the final DB rows) — no transient state polled, per the binding synchronisation ruling.

3. **Traceability** — `specs/fulfillment_stock/requirements.md` §2 FS5 row split into an added `unit` row (the new handler test) and the `integration` row extended to cite both the original re-issue case and the new released-reservation case. `specs/shared/test-matrix.md` has no `FS5` row (FS5 is local to this feature, not one of the shared `R30`–`R35`/`R61` rows it composes with) — confirmed by grep, nothing to flip there, matching the reviewer's own scoping in §3 of the required fix.

**Mutation-probe evidence (survived-before / killed-after).**

- Pre-mutation checksum of `apps/fulfillment/src/application/stock-reservation.handler.ts`: `sha256 1ecd70036130f2958eb8caea438627720b360188d1c1cc64b9728431e2e7fb17`.
- Re-applied the reviewer's exact M5 mutation (added `&& reservation.status === 'reserved'` to the line-44 filter).
- Unit suite: `pnpm --filter @otc/fulfillment test -- stock-reservation.handler.spec.ts` → **2 failed** (both new `it.each` cases; `expected 'accepted' to be 'already_reserved'`). **KILLED** at the unit level.
- Integration suite: `pnpm --filter @otc/fulfillment test:integration -- stock-reserve.integration.spec.ts` → **1 failed** (the new FS5 integration case; `expected { outcome: 'accepted', … } to match { outcome: 'already_reserved', … }`), 36/37 still green. **KILLED** at the integration level too.
- Restored the file from the pre-mutation copy; checksum re-verified identical (`sha256 1ecd70036130f2958eb8caea438627720b360188d1c1cc64b9728431e2e7fb17` — byte-exact).
- Re-ran green: unit `pnpm --filter @otc/fulfillment test` → **12 files / 59 tests** (was 57, +2 for the `it.each`); integration `pnpm --filter @otc/fulfillment test:integration` → **11 files / 37 tests** (was 36, +1).

**Suite-wide re-verification after restore.** `pnpm run lint` clean; `pnpm run typecheck` clean across all 10 workspace projects; root `pnpm run test` — every workspace green (gateway 1, notifications 1, projector 1, contracts 22, shared-kernel 68, billing 1, seed 106, fulfillment 59, orders 387); `./init.sh` exits 0 (`fulfillment_stock` correctly shown `in_progress` before this pass flips it back to `in_review`).

**Scope discipline.** Touched exactly three files: `apps/fulfillment/src/application/stock-reservation.handler.spec.ts` (+2 tests), `apps/fulfillment/src/stock-reserve.integration.spec.ts` (+1 test), `specs/fulfillment_stock/requirements.md` (FS5 row). `stock-reservation.handler.ts` itself was mutated and restored only as the probe — its final content is byte-identical to the reviewer-approved version. No domain file, no Orders file, no shared matrix row, no other Fulfillment file touched.
