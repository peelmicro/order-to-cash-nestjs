# `observability_reliability` — Design (assessment #7, NestJS)

> Realises `requirements.md`'s `R56`–`R60`, `R62`, `R16` and `R29`'s dead-letter clause, plus local `OR1`–`OR6` and `RI1`–`RI4`, in this assessment's stack: NestJS, `@nestjs/cqrs`, Drizzle/MySQL, Kafka (`@nestjs/microservices`), NATS core, MongoDB (projector only).

## 1. The seam between the two halves — one pass or two task groups?

**Recommendation: two independent task groups inside one `tasks.md`, not two features.** They were folded into one `feature_list.json` entry at the human's explicit request, and `requirements.md` §1 already states the reason the request gave (both are "don't repeat an effect on redelivery/retry" in different guises, and F1 of feature 25's review is the same failure shape RI closes for `orders.create` directly). But mechanically:

- **Half A** (`OR1`–`OR6`) touches `apps/orders/src/infrastructure/messaging/`, `apps/orders/src/infrastructure/observability/` (new), `apps/orders/src/presentation/health.controller.ts` (new), the equivalent files in `apps/fulfillment`/`apps/billing`/`apps/notifications`/`apps/projector`/`apps/gateway`, and `infra/otel-collector`/`infra/prometheus`.
- **Half B** (`RI1`–`RI4`) touches exactly `apps/orders/src/application/place-order.handler.ts`, `apps/orders/src/infrastructure/persistence/schema/orders.schema.ts`, one migration, and their tests.

The two halves share **zero files** and zero runtime call paths — Half B never calls the retry-then-DLQ dispatcher, Half A never touches `PlaceOrderHandler`. `tasks.md` therefore groups them as **Group A** (reliability/observability) and **Group B** (requestId replay), sequenced B before A (Group B is small, self-contained, and unblocks nothing in Group A — doing it first de-risks the smaller, better-understood half before the larger cross-service one) but either could be implemented independently by a different pass without merge conflict. This is a recommendation, not a requirement of `requirements.md` itself, and is flagged at the gate: if the human prefers strict sequencing (one PR-shaped unit per approval), split Group A and B into two `in_progress` cycles instead of one.

## 2. Do request-id dedup and dead-lettering share a mechanism? — No, and here is why

Both are instances of "don't repeat an effect under retry/redelivery," but the *effect being guarded* and the *concurrency shape* are different in every dimension that matters to an implementation:

| | Dead-lettering (`OR1`–`OR3`) | Request-id replay (`RI1`–`RI4`) |
|---|---|---|
| What is retried | The **same** operation, by the **transport** (Kafka redelivery, or this feature's own in-process retry loop) | A **client's** retry of an HTTP/RPC call the client cannot itself tell succeeded |
| What proves "already done" | `processed_events` (existing, `R17`/`R18`, unchanged) | A **new** column (`RI1`) — `processed_events` dedups by `eventId`, which a fresh client retry never carries the same value of twice |
| What happens on a repeat | Acknowledge, do nothing (`R18`) | Return the **original result** (`R62`) — the caller is waiting synchronously for a reply, "do nothing" is not an answer |
| Failure mode being guarded | A **poison** message that can never succeed (`R16`) — the guard is bounding retry, not deduplicating | A **healthy** request retried after an ambiguous outcome (timeout, connection drop) — the guard is deduplicating, retry is unbounded and client-driven |

`IdempotentConsumer` (the `R17`/`R18` mechanism) is deliberately **not** reused for `RI1`–`RI3`: it is keyed by `(eventId, consumer)` inside a fact-consumption transaction and its "duplicate" outcome is silence, which is the wrong shape for an RPC responder that must answer with the original order synchronously. `RI1`–`RI3` instead follow `billing_invoicing`'s `payments.payment_reference` unique-constraint precedent (§3 below) — a **different**, RPC-shaped idiom that happens to share the *principle* (a unique index is the serialisation point, not a read-then-write check) but not the *mechanism*. **Verdict: orthogonal.** They are sequenced together in `tasks.md` only because they were folded into one feature by human decision, not because either implementation depends on the other.

## 3. Half B — `orders.create` requestId idempotent replay

### 3.1 Schema

`apps/orders/src/infrastructure/persistence/schema/orders.schema.ts` gains one column:

```ts
requestId: char('request_id', { length: 36 }),   // nullable
```

with a unique index (`uniqueIndex('uq_orders_request_id').on(table.requestId)`) — MySQL's `UNIQUE` on a nullable column admits any number of `NULL`s (the common case: `requestId` omitted) while still admitting at most one row per non-null value. One migration, `apps/orders/drizzle/0004_<name>.sql`, `drizzle-kit`-generated, following `order_saga_orchestrator`'s own precedent of a warm-database migration needing no backfill procedure (every existing row's `request_id` is legitimately `NULL`).

`requestId` is already validated `@IsUUID('4')` at the DTO layer (`orders-create.dto.ts`) before it ever reaches `PlaceOrderCommand` — confirmed by reading the file. `PlaceOrderHandler.resolveCausationId`'s try/catch fallback for a non-parsing `requestId` is therefore dead code in production today (the DTO already guarantees UUID-v4 shape or absence); it is left in place (defensive, harmless, and used by its own existing unit test) rather than removed, since removing it is not in this feature's scope.

### 3.2 `PlaceOrderHandler` — the two checks

```ts
async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
  if (command.requestId) {
    const existing = await this.orders.findByRequestId(command.requestId);   // RI2 — fast path, no lookup/stock-check cost
    if (existing) {
      return this.toResult(existing);
    }
  }
  // ... existing reference-data resolution, stock check, unchanged ...
  return this.unitOfWork.execute(async (tx) => {
    // ... existing order-number allocation, Order.place(...), unchanged ...
    try {
      await this.orders.save(order, tx);      // now writes requestId too
    } catch (error) {
      if (isDuplicateRequestIdError(error) && command.requestId) {           // RI3 — the concurrent-first-request race
        const winner = await this.orders.findByRequestId(command.requestId, tx);
        if (winner) return this.toResult(winner);
      }
      throw error;
    }
    return this.toResult(order);
  });
}
```

`OrderRepository` (the port) gains `findByRequestId(requestId: string, tx?: TransactionContext): Promise<Order | null>` — one query, `orderNumbers`' allocator and everything else in the transaction is unchanged. `isDuplicateRequestIdError` narrows a Drizzle/`mysql2` `ER_DUP_ENTRY` on `uq_orders_request_id` specifically — **not** the existing `orderReference` unique constraint, which must still propagate as a genuine (if practically unreachable given `order-number-allocator.ts`'s serialised allocation) error.

### 3.3 RI3's concurrency resolution — deliberately not `billing_invoicing`'s conflict shape

`billing_invoicing`'s `PaymentReferenceConflictError` (`payment-register.handler.ts`, `payments.payment_reference` unique constraint) is the established precedent for "a unique index catches a race the row lock alone cannot" — but its answer to the race is an **error**, because two different `paymentReference`s racing the *same* value are genuinely, irreconcilably about **different invoices**; there is no "original" to fall back to. Two `orders.create` requests racing the *same* `requestId` are, by construction, the *same logical request* — the caller sent the identical idempotency key on purpose, expecting exactly the behaviour `R62` names. So RI3 takes the unique-constraint catch and, instead of raising, **re-reads and returns the winner's order** — the same "insert races, the index is the serialisation point" idiom, a different ending. This divergence is stated explicitly (`requirements.md` §4, `RI3`) rather than silently copying Billing's error shape, and is flagged as a promotion candidate (`requirements.md` §6) since #8/#9 will hit the identical fork.

**Why the counter-row lock (D7, `place-order.handler.ts:100`) does not already solve this "for free."** Every `orders.create` transaction serialises behind `order-number-allocator.ts`'s `SELECT ... FOR UPDATE` on the single counter row for its entire duration — so two concurrent same-`requestId` requests are, today, incidentally sequential by the time the second one reaches allocation. Relying on this would be fragile for two reasons: (a) D7's own design note flags the counter as a candidate for sharding if acceptance throughput is ever load-tested, at which point this incidental serialisation disappears silently; (b) it only protects the *window from allocation to commit* — the RI2 fast-path lookup happens *before* the transaction opens, so two requests can both pass RI2 (neither commits yet) before either even requests the counter lock. The unique index on `request_id`, not lock ordering, is the actual correctness mechanism; D7's serialisation is irrelevant to it either way.

### 3.4 What RI4 changes: nothing

`requestId` omitted → `command.requestId` is `undefined` → RI2's lookup is skipped, `orders.save` writes `requestId: null`, no constraint is ever consulted. This is the existing code path today, verified unchanged by a regression test rather than assumed.

## 4. Half A — the dead-letter mechanism

### 4.1 The retry-then-DLQ dispatcher — a second OI12-guarded canonical pattern

`outbox_and_idempotency` design.md §7 states the seam precisely: *"wrap `IdempotentConsumer.runOnce(...)`. A rejection is already the failure signal; feature 27 adds attempts, backoff and the dead-letter publication around it, and only then acknowledges. Nothing in §6 needs to change."* This feature adds exactly that wrapper, one layer **above** `IdempotentConsumer` (never inside it) at the `@EventPattern` controller's own dispatch point — `SagaFactsController.route`'s `await this.commandBus.execute(...)` in Orders, and the equivalent single dispatch call in `apps/notifications`/`apps/projector`.

```ts
// apps/orders/src/infrastructure/messaging/fact-retry-dispatcher.ts — CANONICAL,
// second OI12-guarded pair alongside idempotent-consumer.ts. Copied verbatim
// (after its own banner) into apps/projector, apps/notifications — the same
// three services that already own an idempotent-consumer.ts copy, since a
// service with no fact consumer has nothing to wrap.
export interface DlqPublisher {
  publish(sourceTopic: string, envelope: Envelope, meta: {
    failedConsumer: ConsumerName;
    attempts: number;
    error: unknown;
    firstFailedAt: Date;
    failedAt: Date;
  }): Promise<void>;
}

export class FactRetryDispatcher {
  constructor(
    private readonly clock: Clock,
    private readonly delay: DelayPort,             // same "Clock-port-style delay abstraction" SO4 already uses, so unit tests run instantly
    private readonly dlq: DlqPublisher,
    private readonly policy: { maxAttempts: number; backoffBaseMs: number },
  ) {}

  async dispatch(sourceTopic: string, envelope: Envelope, consumer: ConsumerName, process: (e: Envelope) => Promise<void>): Promise<void> {
    const firstFailedAt = this.clock.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt++) {
      try {
        await process(envelope);
        return;                                     // success — caller (the @EventPattern handler) returns normally, offset commits
      } catch (error) {
        lastError = error;
        if (attempt < this.policy.maxAttempts) {
          await this.delay.for(this.policy.backoffBaseMs * 2 ** (attempt - 1));
        }
      }
    }
    await this.dlq.publish(sourceTopic, envelope, {
      failedConsumer: consumer, attempts: this.policy.maxAttempts, error: lastError,
      firstFailedAt, failedAt: this.clock.now(),
    });
    // deliberately does NOT rethrow — the @EventPattern handler returns
    // normally, @nestjs/microservices commits the offset (R16's "acknowledge
    // the original fact so the partition is not blocked").
  }
}
```

`process` is exactly the existing per-topic body of `SagaFactsController.route` (envelope already parsed by `parseFactEnvelope` — a structurally malformed envelope is still handled by that pre-existing, unwrapped, log-and-ack path; `OR1` only widens what happens **after** a syntactically valid envelope fails **semantically**, which is the live incident's exact shape). `DlqPublisher`'s concrete adapter reuses the existing Kafka publisher client each service already has for its own outbox relay, targeting `<source-topic>.dlq` with `DeadLetterHeaders` (`asyncapi.yaml`, unchanged by this feature — the schema was already written for this).

**OI12 widened, not duplicated.** `idempotent-consumer.parity.spec.ts` (the existing `OI12` guard) gains a second canonical pair check for `fact-retry-dispatcher.ts` (no second `.repository.ts` sibling — it has no store of its own), using the exact same byte-identity-after-banner mechanism, the exact same `SERVICE_IDEMPOTENCY_MODE` registry (a `mysql-copy` service now also needs this second file; `documented-variant`/`no-consumer` are unaffected since the projector's and notifications' banners already document their own divergence points and gateway/seed/web consume no fact). This directly satisfies the brief's binding instruction: dead-lettering "must go through OI12's registry, not create a sixth silent variant."

**Fulfillment and Billing are out of scope for this file today.** Their `ConsumerName` unions are `never` (confirmed by reading `consumer-name.ts` in both) — neither consumes a fact yet (`saga.md` §5), so `FactRetryDispatcher` would be uncallable there exactly as `IdempotentConsumer` already is, and OI12's own case 3 already enforces "a copy only where there is a handler to wrap." No new file lands in either service by this feature.

### 4.2 `R29`'s dead-letter clause — the `saga_commands` park hook

`order_saga_orchestrator` design.md §6.5 names this seam directly: *"Attach DLQ publication + timeline saga-failure entry to the park transition. Nothing in this section needs to change shape for that."* Two additions to the **existing, unmodified** `SagaCommandStore`/`SagaCommandDispatcher`/sweeper (`SO3`–`SO5`, all `DONE`, none redesigned here):

1. **`saga_commands` schema gains two nullable columns**, captured at `enqueue` time (not derived later, so nothing this feature does depends on a cross-service read — `saga_commands.schema.ts`'s own header already names `triggering_event_id` as "the join key for feature 27's eventual dead-lettering"; these two columns are how that join key is actually resolved to something publishable without querying another service's database):
   - `triggering_event_envelope` (`json`) — the **full, unmodified** `Envelope` that `SagaFactHandler.handle` already holds in memory at the moment it calls `commandStore.enqueue(...)`, threaded through as a new parameter.
   - `triggering_event_topic` (`varchar(64)`) — the Kafka topic constant `SagaFactsController.route` already knows for the same call (`ORDERS_FACTS_TOPIC` / `FULFILLMENT_FACTS_TOPIC` / `BILLING_FACTS_TOPIC`), threaded the same way.
   - `dead_lettered_at` (`datetime`, nullable) — OR3's "at most once" marker: `NULL` until the first park, set exactly once, in the same transaction as the `park(...)` call, guarded by `WHERE dead_lettered_at IS NULL` so a concurrent/later sweep cycle that re-parks the row cannot double-publish.
2. **`SagaCommandDispatcher.park(...)`** (called from both the in-line path and the sweeper, `SO4`/`SO5`, unchanged) gains one conditional step, run only when the row's `dead_lettered_at` was `NULL` immediately before this park: publish `triggering_event_envelope` to `triggering_event_topic + '.dlq'` (via the same `DlqPublisher` §4.1 defines — reused, not a third variant), then append **one** `order.saga_failed.v1` fact via the existing outbox pipeline (`Order.recordSagaFailure(...)`, a new aggregate method appending one domain event without touching `status`/lines/totals — symmetric to how `Order.cancel(...)` appends `OrderCancelled`), then set `dead_lettered_at`. All in the row's own short transaction; `SO5`'s indefinite capped-backoff retry schedule for the **underlying command** is untouched — parking still recurs, dead-lettering fires exactly once.

**Open point, stated for the gate (not resolved unilaterally here): is `order.saga_failed.v1` the right mechanism at all?** `requirements.md` §1 already flags the two options design considered:

- **Option 1 (recommended, and what §4.2 above assumes): mint a 14th domain fact.** Faithful to `R29`'s literal wording — "order timeline" is `R50`'s defined term, the projector's read model, and only a normal fact the projector consumes can land there. Cost: `asyncapi.yaml`'s "thirteen facts" framing (its channel/overview descriptions, `domain-model.md` §7.2's event table, `saga.md`'s prose) becomes stale by exactly one everywhere it appears, and the projector needs a 14th summary builder (`apps/projector`'s `summaries.ts`, following the existing `PR16` pattern). This spec pass adds the new `OrderSagaFailedPayload`/`OrderSagaFailedEvent`/`OrderSagaFailed` schemas to `asyncapi.yaml` (so this design is concrete) but **deliberately does not** touch any existing "thirteen" reference or register the message on the `ordersFacts` channel — that sweep is Group A's own first task, done consciously, once the gate has actually chosen this option (see `tasks.md` A1).
- **Option 2 (cheaper, smaller blast radius): an Orders-owned side channel.** A `saga_failures` read exposed by Orders over NATS RPC (mirroring the shape of `fulfillment.stock.check`, a synchronous query, not a fact), merged into the human-facing order view only at the Gateway — never touching the projector, `domain-model.md`, or the "thirteen" count. Cost: the saga-failure entry is then **not**, technically, "in the order timeline" as `R50` defines the term — a real, stated divergence from `R29`'s literal wording, acceptable only if the gate reads "the order timeline" loosely as "what a human sees about this order," not strictly as the projector's document.

This choice is listed in `progress/spec_observability_reliability.md`'s open-points table as a flagged row requiring conscious approval before Group A's implementer starts on `OR3`.

### 4.3 Trace propagation (`OR4`, `R57`)

Packages: `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/exporter-metrics-otlp-grpc`, `@opentelemetry/instrumentation-http`, one instrumentation per protocol actually in play (Express for the Gateway; `kafkajs`/`nats` have no official OTel auto-instrumentation as of this writing, so their spans are created **manually** at the two points that matter: the outbox relay's publish call and `SagaFactsController.route`'s consume call — the same two points R57 already names, and the same two points `outbox_and_idempotency` design.md §7's point 3 already earmarked ("the publisher already builds a header map; feature 27 injects `traceparent`/`tracestate` into it")).

- **NATS RPC (`nats-saga-commands.adapter.ts`, `nats-rpc-client.adapter.ts`, the Gateway's own RPC client):** `requestHeaders(meta)` already sets `x-correlation-id`/`x-request-id` (confirmed by reading `nats-rpc-client.adapter.ts`); this feature adds `traceparent`/`tracestate` alongside them, read from the active OTel context via `propagation.inject(context.active(), headers, natsHeadersCarrier)`. The responding side extracts and continues via `propagation.extract(...)` before handling the request, inside the same `@MessagePattern` handler — no port signature changes, only the header-building/-reading helper functions.
- **Kafka facts:** the outbox relay populates the already-provisioned, currently-`NULL` `trace_parent` column (`outbox_and_idempotency` migration, design.md §3.3) at the moment a domain event is pulled into an outbox row — captured from the active trace context of the command handler that produced it — and injects it as the `traceparent` fact header when publishing (`FactHeaders.traceparent`, already `required` in the schema; until this feature, `outbox_and_idempotency` "knowingly publishes facts without" it, per that feature's own design note). Consumers extract it in `SagaFactsController.route`/the notifications and projector equivalents, wrapping the whole per-fact processing (including the `FactRetryDispatcher` call) in the extracted context, so every retry attempt and the eventual DLQ publish (if any) stay on the same trace.
- **HTTP → NATS, the Gateway's own hop:** `@opentelemetry/instrumentation-http` auto-instruments Express and out-going Node HTTP; the NATS RPC client above carries the resulting context onward, closing R56's HTTP→NATS→MySQL→Kafka→consumers chain end to end **as a mechanism** — see §5's amendment on what "end to end" means as an *observation* versus a mechanism.

### 4.4 Structured logging (`R58`)

Every service's existing `console.log`/`console.error` JSON call sites (already structured — `problem-json.filter.ts`, `SagaFactsController`'s logger, the outbox relay's failure logs, all confirmed JSON-shaped by reading them) gain `traceId` alongside the `correlationId` each already carries, read from `trace.getActiveSpan()?.spanContext().traceId`. **One existing inconsistency, found while reading the required files and worth fixing in the same pass rather than leaving as a second, undocumented gap:** `apps/gateway/src/presentation/problem-json.filter.ts` currently mints a **fresh** `UniqueId.generate()` as `correlationId` on every thrown exception rather than reusing the request's own already-established correlation id — so two log lines about the *same* failing request today do not share a `correlationId` unless the exception filter is the only thing that ever logs. This feature's structured-logging pass replaces that generated id with the request-scoped one (present on every inbound request via the same middleware/interceptor that already stamps it for successful responses), since `R58`'s "every line" guarantee is meaningless if the error-path line uses a different identifier than the rest of the request's lines. Named as its own task (`tasks.md` A6) so it is not silently bundled into the OTel wiring and lost in review.

### 4.5 Metrics (`R59`, `OR5`)

An OTel `Meter` per service, five instruments: `otc_request_latency_ms` (histogram, Gateway only, per endpoint), `otc_fact_processing_latency_ms` (histogram, per consumer), `otc_saga_completion_ms` (histogram, Orders only, recorded when `order.completed.v1`/`order.cancelled.v1` closes a saga started by a captured `order.placed.v1` timestamp), `otc_outbox_lag_ms` (gauge, age of the oldest unpublished outbox record — the exact query the `(published_at, occurred_at)` index was already provisioned for), `otc_dlq_depth` (gauge, per topic — a broker admin-client partition-offset query against each `.dlq` topic, polled on the same interval as the outbox relay). All exported over OTLP to the collector; none exposed as a local `/metrics` HTTP endpoint.

**Open point, flagged for the gate:** `infra/prometheus/prometheus.yml`'s commented-out per-application `static_configs` block (`gateway:3001`, `orders:3002`, … `catalog:3006`) is **superseded**, not activated, by this design — every metric already reaches Prometheus via the single `otel-collector` scrape job (`infra/otel-collector/otel-collector-config.yaml`'s `metrics` pipeline already exports to `:8889`, already scraped), distinguished per service by the OTel `service.name` resource attribute rather than by scrape target. Two further things that block simply uncommenting it as written even if the gate prefers the direct-scrape model: it targets a `docker-compose.apps.yml` that does not exist (services run via `pnpm dev:*` against `docker-compose.infra.yml`'s containers, confirmed — there is no apps compose file in this repository today), and it names a `catalog` service that does not exist in `apps/` (six real services: gateway, orders, fulfillment, billing, notifications, projector — `catalog` appears nowhere else in this codebase, a stale placeholder from before the projector was named). `tasks.md` A9 removes the stale block with a comment recording why, rather than leaving it to rot further.

### 4.6 Liveness and readiness (`R60`, `OR6`)

`apps/gateway`'s existing `HealthCheck`/`READINESS_CHECKS`/`HealthController` (`GET /health/live` always 200, `GET /health/ready` 503 on any failing check, confirmed by reading all three files) is the reference shape — not shared runtime code (it is ~30 lines per service, the same "nothing beyond `shared-kernel`/`contracts`" reasoning `OI12` already argues for the idempotent-consumer pattern), copied and adapted per service:

| Service | Readiness checks |
|---|---|
| Gateway | read model (MongoDB), RPC transport (NATS) — **unchanged**, already built |
| Orders | write model (MySQL ping), fact stream (Kafka producer/admin ping), RPC transport (NATS) |
| Fulfillment, Billing | write model (MySQL ping), RPC transport (NATS) — neither consumes a fact yet (§4.1), so no fact-stream check |
| Notifications, Projector | fact stream (Kafka), plus their own store (MySQL for Notifications, MongoDB for the Projector) — neither issues RPC, so no RPC-transport check |

Each check's `up`/`down` boolean is a real reachability probe (a ping/admin call with a short timeout), never a cached or optimistic value — the API-level proof (`R60`'s named test) stops a **real** dependency container mid-suite rather than mocking a failure.

## 5. R56 — the amendment, restated from the shared matrix

`specs/shared/test-matrix.md` §8 now carries this amendment directly (see that file). Restated here because it governs Group A's scope: this feature proves the **mechanism** — every hop injects and every hop continues, verified per-hop against an `InMemorySpanExporter` in each service's own Testcontainers suite (`OR4`'s named test). It does **not** stand up the composed stack (Gateway + Orders + a real Fulfillment + a real Jaeger) to *observe* one continuous trace end to end; that composed-stack proof belongs to `saga_e2e_verification` (feature 28, phase 15), the first feature actually positioned to run every service together. This is the same ratified-deferral shape as `R16`/`R29` and is flagged at the gate rather than silently narrowing `R56`'s row.

## 6. Configuration and new dependencies

| Package | Purpose |
|---|---|
| `@opentelemetry/api` | Trace/context/propagation API, used directly for the manual NATS/Kafka instrumentation (§4.3) |
| `@opentelemetry/sdk-node` | Node SDK bootstrap, per service `main.ts`, before any other import (mirrors the existing `reflect-metadata`-first convention) |
| `@opentelemetry/exporter-trace-otlp-grpc` | Spans → `otel-collector:4317` |
| `@opentelemetry/exporter-metrics-otlp-grpc` | Metrics → `otel-collector:4317` |
| `@opentelemetry/instrumentation-http` | Auto-instruments the Gateway's Express layer and outbound Node `http` |
| `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` | `service.name` resource attribute per service, the label the collector's Prometheus exporter differentiates on |

No `@nestjs/terminus`: the existing hand-rolled `HealthCheck` port already satisfies `R60` for the Gateway with zero framework dependency and is generalised, not replaced (§4.6). No `prom-client`: metrics are OTLP-pushed, never locally scraped (§4.5, §5's open point).

New env vars (all with dev-stack defaults, following `SAGA_COMMAND_*`'s existing naming convention): `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4317`, since services run via `pnpm dev:*` against host-mapped container ports, not container DNS names — confirmed no `docker-compose.apps.yml` exists), `FACT_RETRY_MAX_ATTEMPTS` (default `3`), `FACT_RETRY_BACKOFF_MS` (default `500`).

## 7. Migrations

- `apps/orders/drizzle/0004_<name>.sql` — `orders.request_id` (nullable, unique) + `saga_commands.triggering_event_envelope`/`triggering_event_topic`/`dead_lettered_at`. One migration, both changes, since both are Orders-only and there is no reason to force two coordinated deploys for unrelated columns in the same table set.
- No Fulfillment/Billing/Notifications/Projector schema change — `FactRetryDispatcher` needs no store of its own (§4.1); `MongoDB`'s read model is untouched unless/until Option 1 of §4.2 is chosen, at which point the projector's summary-builder addition needs no schema migration (MongoDB, schemaless by construction here).

## 8. Testing approach

Domain unit tests pure (`Order.recordSagaFailure`, if Option 1 is chosen; `FactRetryDispatcher`'s attempt/backoff/DLQ-call logic with a fake clock/delay/publisher; `PlaceOrderHandler`'s two new branches with faked ports). Integration tests Testcontainers, real MySQL + Kafka + NATS, extending the existing per-service harness (`saga-integration-harness.ts` for Orders). `R59`/`R58`/`OR4` are proven against OTel's own `InMemorySpanExporter`/`InMemoryMetricExporter` test utilities rather than a live collector — faster, deterministic, and exactly what `saga_e2e_verification` (feature 28) is positioned to prove against the real Jaeger/Prometheus stack instead. `R60` is the one row proven against a **stopped real container**, not a fake, per the API-level test convention this matrix already uses elsewhere (e.g. `R54`'s gateway-half evidence). Every branch that emits or suppresses a fact/DLQ entry — the exhausted-retry DLQ publish, the "at most once" park-hook guard, `order.saga_failed.v1`'s emission (if Option 1), RI3's re-read-and-return-winner path — gets a test that fails when the emission is deleted, armed by the implementer, per `CLAUDE.md`'s binding rule; `tasks.md` names each one explicitly.

## 9. Out of scope — restated

- `sonarqube_quality_gates`, `observability_dashboards` (feature ids after 27) — this feature makes the data exist; building actual Grafana/dashboard content is later.
- Fulfillment's and Billing's own fact consumers, if either ever gains one — `FactRetryDispatcher` is ready to be copied in per OI12's existing "requires a copy from every write model that consumes facts" case, but neither has an `@EventPattern` handler today, so no copy lands here.
- Any change to `SO1`–`SO8`, `R19`–`R28`'s step table, or the sweeper's retry policy itself — only the park **hook** is new.
