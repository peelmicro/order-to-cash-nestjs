# impl: observability_dashboards (feature 35, phase 22)

`sdd: false`. Acceptance (`feature_list.json`): panels for saga duration, per-service
latency, consumer lag, outbox lag, DLQ depth; dashboard auto-provisioned; one
distributed-trace screenshot.

## 1. Consumer-lag decision

**Not instrumented in-app.** Confirmed by grep (`consumer_lag|consumerLag` across `apps/*/src`
— nothing) before touching anything. Only `apps/orders` and `apps/gateway` run an OTel
`MeterProvider` at all (per `observability_reliability/design.md` §4.5's own scoping); no
service computes or reports its own Kafka consumer-group lag.

**Chosen fix: a Kafka exporter container**, not in-app instrumentation. Added
`danielqsj/kafka-exporter:v1.9.0` to `docker-compose.infra.yml` (`kafka-exporter` service,
`--kafka.server=kafka:29092`, port 9308, healthcheck on `/metrics`), scraped by Prometheus as
a second job (`infra/prometheus/prometheus.yml`). This is the broker's own real truth —
`kafka_consumergroup_lag{consumergroup,topic,partition}` — the actual definition of consumer
lag (committed offset vs. topic high-water mark via the Kafka admin API), not a proxy metric
relabelled to sound like one. Rejected in-app instrumentation because it would mean touching
four services' Kafka consumer paths (orders, projector, notifications each run a
`@EventPattern` consumer group) for a phase whose remit is dashboards/config, and every one
of those consumer groups is already visible, for free, to an off-the-shelf broker-side
exporter.

Verified real: `sum(kafka_consumergroup_lag) by (consumergroup, topic)` returns 54 series
covering all three real consumer groups (`orders.saga-server`, `projector-server`,
`notifications-server`) against all three fact topics — all `0` (fully caught up), which is
the honest state of a healthy dev stack, not a stub.

Left running and healthy: `otc-kafka-exporter` (19th container).

## 2. Trace-linkage root cause and fix

**Root cause (confirmed by reading every service's tracing code, not assumed):** `apps/billing`
and `apps/fulfillment` never created a single OTel span of their own, anywhere. Their NATS
`@MessagePattern` responders (`credit.controller.ts`, `invoice.controller.ts`,
`stock.controller.ts`, `despatch.controller.ts`) extract the inbound `traceparent` and run the
handler inside `otelContext.with(extracted, …)` — so the trace ID is genuinely carried forward
— but never call `tracer().startSpan(...)`. Their `outbox-relay.ts` forwarded a row's stored
`trace_parent` **verbatim** as the outbound Kafka header (each file's own comment said so
explicitly: *"no manual 'publish' span here, unlike apps/orders' own relay"* — a documented,
deliberate scope cut from an earlier feature, feature 27/28, never closed since). Net effect:
`credit.approved.v1`/`stock.reserved.v1`/etc. carried the CORRECT trace ID onward, but zero
spans of billing's or fulfillment's own were ever exported — so neither service ever appeared
as a Jaeger participant, and the causal chain jumped straight from Orders' own
`saga.consume` span to Orders' own NEXT `saga.consume` span, skipping the two services that
actually did the work in between.

(`apps/orders`' own `orders.create` NATS responder has the identical "extract, no span" shape
— consistent with the rest of the codebase — but Orders still appears because its
`outbox-relay.ts` already creates an `outbox.publish` span, per feature 27's original, narrower
scope: "the outbox relay's publish call is one of the two points this feature creates a manual
span at.")

**Fix — surgical, mirrors Orders' existing pattern exactly, nothing else touched:**
- `apps/billing/src/infrastructure/observability/trace-context.ts`,
  `apps/fulfillment/src/infrastructure/observability/trace-context.ts`: added
  `contextFromTraceParent`/`startChildSpan`, copied verbatim from Orders' own file of the same
  name (previously these two services carried only the NATS-extraction half).
- `apps/billing/src/infrastructure/outbox/outbox-relay.ts`,
  `apps/fulfillment/src/infrastructure/outbox/outbox-relay.ts`: `runOnce()` now creates a
  `SpanKind.PRODUCER` "`outbox.publish <eventType>`" span per row that stored a `traceParent`
  — same guard, same error handling (`spans[index]` read per-row on batch failure, same as
  Orders), same "the span's own fresh span id, not the raw header, is what gets injected" —
  copied from `apps/orders/src/infrastructure/outbox/outbox-relay.ts` almost line for line.
  Deliberately did **not** copy Orders' `outboxLagGauge`/`dlqDepthGauge` metric recording —
  neither service runs a `MeterProvider` (out of this phase's scope; the DLQ-depth/outbox-lag
  panels below are proven with Orders' own existing metric, which already reflects the whole
  system since Orders owns the saga's outbox/DLQ topics).

**Before (live-stack observation, opened the phase):** placing an order and fetching its
gateway trace from Jaeger showed `spans=1, services=['gateway']` — the trace never left the
Gateway's own root span.

**After the fix**, a fresh real order (`ORD-000186`, placed via `POST /orders` through the
Gateway after rebuilding/restarting `billing`+`fulfillment`) produced trace id
`e9274e562630dc9d5da07325d866a947` — **6 services, 19–22 spans** (grew to 22 as
`notifications` finished its slower consumer catch-up), one continuous trace:

```
gateway        POST                                (root)
 └ orders       outbox.publish order.placed.v1
    ├ projector     fact.consume order.placed.v1
    ├ notifications fact.consume order.placed.v1
    └ orders        saga.consume order.placed.v1
       └ fulfillment  outbox.publish stock.reserved.v1        ← NEW, was invisible before
          └ orders       saga.consume stock.reserved.v1
             ├ projector    fact.consume stock.reserved.v1
             └ billing       outbox.publish credit.approved.v1  ← NEW, was invisible before
                └ orders        saga.consume credit.approved.v1
                   ├ projector     fact.consume credit.approved.v1
                   ├ orders         outbox.publish order.confirmed.v1
                   │   └ projector      fact.consume order.confirmed.v1
                   └ fulfillment    outbox.publish order.despatched.v1  ← NEW
                      └ orders          saga.consume order.despatched.v1
                         ├ projector       fact.consume order.despatched.v1
                         ├ notifications   fact.consume order.despatched.v1
                         └ billing         outbox.publish invoice.issued.v1  ← NEW
                            ├ orders          saga.consume invoice.issued.v1
                            ├ projector       fact.consume invoice.issued.v1
                            └ notifications   fact.consume invoice.issued.v1
```

Every `billing`/`fulfillment` span above is correctly parented on the upstream Orders
`saga.consume` span that triggered the NATS RPC call (the RPC hop itself still creates no
span, consistent with every service's existing convention — not something this fix widened),
and every downstream Orders `saga.consume`/projector/notifications `fact.consume` span is in
turn parented on the NEW billing/fulfillment `outbox.publish` span, not skipping over it as
before.

## 3. Panels — PromQL and proof (real Prometheus query output, captured live)

Dashboard: `infra/grafana/dashboards/order-to-cash-overview.json`, provisioned by
`infra/grafana/provisioning/dashboards/dashboards.yml` (`type: file`, reads
`/var/lib/grafana/dashboards`, mounted from `infra/grafana/dashboards/` —
`docker-compose.infra.yml`'s `grafana` service gained this second bind mount).

1. **Saga duration** — `histogram_quantile(0.95, sum(otc_saga_completion_ms_milliseconds_bucket) by (le, outcome))`
   → `{outcome="completed"} 10000` (real: a saga was driven end to end, `ORD-000185` placed,
   invoiced, then paid via `POST /invoices/{id}/payments`, which is what makes `outcome:
   completed` exist at all — `SagaFactHandler` only records this metric when a transition
   lands the order on `completed`/`cancelled`, never on an intermediate step).
2. **Per-service latency** — two series in one panel (Orders/Gateway are the only two services
   with a `MeterProvider`, per design.md §4.5's own scope):
   `histogram_quantile(0.95, sum(otc_request_latency_ms_milliseconds_bucket) by (le, exported_job, endpoint))`
   → e.g. `{exported_job="gateway", endpoint="OrdersController.placeOrder"} 72.5`
   `histogram_quantile(0.95, sum(otc_fact_processing_latency_ms_milliseconds_bucket) by (le, exported_job, consumer))`
   → `{exported_job="orders", consumer="orders.saga"} 35`
3. **Consumer lag** — `sum(kafka_consumergroup_lag) by (consumergroup, topic)` → 9 series (3
   groups × 3 topics), all real, all `0` (see §1).
4. **Outbox lag** — `max by (exported_job) (otc_outbox_lag_ms_milliseconds)` →
   `{exported_job="orders"} 0` (real gauge, genuinely caught up).
5. **DLQ depth** — `otc_dlq_depth_ratio` → `{topic="otc.billing.facts.v1.dlq"} 183`,
   `{topic="otc.fulfillment.facts.v1.dlq"} 96`, `{topic="otc.orders.facts.v1.dlq"} 445` — real,
   accumulated backlog from this dev stack's history (a real `KafkaDlqDepth` admin-client
   partition-offset query, not a synthesised value).

Every query above was run against `http://localhost:9090/api/v1/query` and returned the
literal values shown before being placed in a panel — no "No data" panels committed.

## 4. Dashboard auto-provisioning — verified

- `GET /api/search?query=Order` (Grafana API, basic auth) → 1 result, `uid: otc-overview`,
  after a **full container recreate** (`docker rm -f otc-grafana && docker compose … up -d
  grafana`) — proves it survives a cold start, not just an in-memory reload.
- Repeated after a **plain `docker compose restart grafana`** → still 1 result, same uid — no
  manual import at any point.
- One provisioning wrinkle found and reverted: initially pinned an explicit `uid:` on the
  `Prometheus`/`Jaeger` datasources in `datasources.yml` so the dashboard JSON could reference
  them by uid. This crash-looped Grafana at boot (`Datasource provisioning error: data source
  not found`) — this environment's `grafana_data` named volume already held datasource rows
  from earlier phases' `docker compose up` with Grafana-assigned UIDs, and the file provisioner
  couldn't reconcile a different literal uid for the same `name` against that existing state.
  Reverted the datasource change; the dashboard JSON now references `"datasource": "Prometheus"`
  by name instead, which is robust regardless of whatever UID Grafana already assigned.

## 5. Screenshot

`docs/screenshots/jaeger-single-order-trace.png` — Jaeger's trace-detail UI for
`e9274e562630dc9d5da07325d866a947`, captured with Playwright (`apps/web`'s already-installed
`@playwright/test`, via a throwaway script, not committed). Shows "Services 6", "Total Spans
22", and the waterfall visibly crossing gateway → orders → fulfillment → orders → billing →
orders → projector/notifications.

## 6. Files touched

- `docker-compose.infra.yml` — `kafka-exporter` service added; `grafana` gained a second bind
  mount (`infra/grafana/dashboards` → `/var/lib/grafana/dashboards`).
- `infra/prometheus/prometheus.yml` — second scrape job, `kafka-exporter:9308`.
- `infra/grafana/provisioning/datasources/datasources.yml` — comment update only (uid attempt
  reverted, documented why).
- `infra/grafana/provisioning/dashboards/dashboards.yml` — new, the dashboard provider.
- `infra/grafana/dashboards/order-to-cash-overview.json` — new, the 5-panel dashboard.
- `apps/billing/src/infrastructure/observability/trace-context.ts`,
  `apps/fulfillment/src/infrastructure/observability/trace-context.ts` — added
  `contextFromTraceParent`/`startChildSpan`.
- `apps/billing/src/infrastructure/outbox/outbox-relay.ts`,
  `apps/fulfillment/src/infrastructure/outbox/outbox-relay.ts` — manual `outbox.publish` span,
  mirroring `apps/orders`' own relay.
- New tests: `apps/billing/src/infrastructure/outbox/outbox-relay-trace-linkage.integration.spec.ts`,
  `apps/fulfillment/src/infrastructure/outbox/outbox-relay-trace-linkage.integration.spec.ts`
  (Testcontainers: real MySQL + real Kafka, real `NodeTracerProvider` +
  `InMemorySpanExporter`) — each proves (a) a row written inside an active span is published
  with the service's OWN fresh "outbox.publish" span, same trace id, parented on the writer's
  span, consumed with a DIFFERENT span id than the writer's (not the raw header forwarded
  verbatim — the pre-fix behaviour), and (b) an untraced row still produces no header/no span
  (no spurious trace fabricated). These are the mechanism-level proof; the Jaeger trace in §2
  is the live, composed-system proof.
- `README.md` — Grafana dashboard + kafka-exporter mentioned in the infra section.
- `docs/screenshots/jaeger-single-order-trace.png` — new.

Not touched (per brief's explicit constraint): `feature_list.json`, `specs/**`, application
domain logic.

## 7. Gate results

- `apps/billing`: unit `npx vitest run` → 29 files / 148 tests passed. Integration
  (`vitest.integration.config.mts`, Testcontainers) → 22 files / 74 tests passed, including
  the 2 new trace-linkage tests.
- `apps/fulfillment`: unit → 18 files / 83 tests passed. Integration → 15 files / 50 tests
  passed, including the 2 new trace-linkage tests.
- `npx eslint` on every touched file → clean.
- `pnpm --filter @otc/billing typecheck`, `pnpm --filter @otc/fulfillment typecheck` → clean.
- `pnpm quality` (root: lint + typecheck + test:coverage across all 8 workspace packages) →
  **exit 0**. No coverage-threshold failures, no lint/type errors.
- `./init.sh` → exit 0, all `[OK]`, 12 uncommitted changes flagged as expected mid-session.
- All 19 containers `Up ... (healthy)` at the end, including the newly added
  `otc-kafka-exporter` and the rebuilt `otc-billing`/`otc-fulfillment`/recreated `otc-grafana`.

## What I could not do / left honest

- Per-service latency for `fulfillment`/`billing`/`projector`/`notifications` is not in the
  dashboard as its own panel series — those four services still run no `MeterProvider`
  (design.md §4.5's original, still-standing scope decision; out of this phase's remit to
  widen). The panel is honestly two real series (Gateway request latency, Orders fact-consume
  latency), not a fabricated per-service breakdown.
- Consumer lag is per consumer-group/topic/partition (the broker's own granularity), not
  labelled by the four business service names directly — `orders.saga-server` /
  `projector-server` / `notifications-server` map 1:1 to `orders`/`projector`/`notifications`,
  documented in the panel description rather than relabelled.

## D1-D5 — the N11 question and documentation corrections

**N11 verdict: REAL DEFECT, reproduced on demand — not a flake.** `apps/billing/src/infrastructure/persistence/invoice.repository.ts`'s
`markPaid()` catches ONLY `error.cause.code === 'ER_DUP_ENTRY'` (`isDuplicateEntryError`) around
the `payments` INSERT, then throws `PaymentReferenceConflictError` → `rpc-error-mapper.ts` maps
that to `CONFLICT`. Any OTHER driver error on that INSERT — including `ER_LOCK_DEADLOCK` —
is not recognised, falls through every `instanceof` branch and lands on the generic
`INTERNAL_ERROR` fallback. MySQL's own documented InnoDB locking behaviour is that concurrent
sessions inserting the same row CAN produce a deadlock instead of a duplicate-key error, not
just when racing the identical key but under general concurrent-insert pressure on the same
table. Reproduction: a temporary probe (`apps/billing/src/_probe-n11-race.integration.spec.ts`,
written, run, then deleted — never landed, `git status --porcelain apps/billing` clean
afterwards) reused the real `startBillingIntegrationHarness()` (real MySQL/NATS/Kafka via
Testcontainers) to fire many concurrent `billing.payment.register` pairs sharing one
`paymentReference` across different invoices, escalating from 30 to 220 total race trials
across four runs, the last two under artificial host CPU load (6-8 parallel `yes > /dev/null`
workers). A temporary diagnostic line in `toRpcError` (added, exercised, then reverted
byte-exact — `git diff apps/billing/src/presentation/rpc-error-mapper.ts` empty after revert)
logged every mapped error's raw `cause.code`. Result across all runs: `ER_LOCK_DEADLOCK`
appeared repeatedly (56, 93, then more instances), each time surfacing as `INTERNAL_ERROR` on
the wire — first on `credit_items` (the `release` ledger row, same transaction, different
statement), then on the `outbox` insert (same transaction, still a different statement) — and
finally, in a 70-pair run with `payments` insert contention maximised (all fixtures pre-created
serially, then all 140 payment-register RPCs fired in one `Promise.all` so every write lands
on the SAME table at once), directly on the exact statement N11 tests:
`insert into \`payments\` (...) values (...) params: ...,PAY-MASS-27-ce7552,...` failed with
`causeCode=ER_LOCK_DEADLOCK`, and the losing side of that pair received `INTERNAL_ERROR`
instead of `CONFLICT`. This is the literal scenario the reviewer asked about, on demand, not by
luck: `git grep -n "ER_LOCK_DEADLOCK"` across `apps/*/src` finds zero handling anywhere in the
codebase — `isDuplicateEntryError`-style guards check `ER_DUP_ENTRY` only, in every service that
has one. **Not fixed** — this is a decision on the payment path and the brief was explicit that
it stops here. The two possible directions (broaden `isDuplicateEntryError` to also retry once
on `ER_LOCK_DEADLOCK` before giving up; or catch `ER_LOCK_DEADLOCK` generically at the handler/
controller boundary and retry the whole transaction) are both real work with a decision to make
about retry-vs-surface semantics — left for the human.

**apps/web's 10s Nuxt hook timeout: confirmed load-only, not investigated further** — `pnpm
quality` passed clean, twice, in this session (see below); the reviewer's own isolated re-run
of the same 2 files (15/15, 74/74) already showed the failure does not reproduce outside
contention, and nothing under `apps/web` was touched by this feature or this pass.

**D2 — README container counts.** `README.md` line 39 `Docker Compose (~18 containers)` →
`~19`; line 146 `pnpm dc:up:infra   # 10 containers + a one-shot kafka-init job` → `11
containers`.

**D3 — kafka-exporter's resource cost, now documented in two places.** Added "Measured resource
cost: **7.4 MiB RSS, 0.00% CPU**" to `README.md`'s dashboard paragraph and to the `kafka-exporter`
service comment block in `docker-compose.infra.yml`, both citing the reviewer's measurement.

**D4 — `infra/grafana/provisioning/datasources/datasources.yml`'s comment corrected.** It used
to claim the failure was "Grafana assigning arbitrary UIDs". Rewritten to state what the
reviewer's zero-state cold start actually proved: the UIDs (`PBFA97CFB590B2093` /
`PC9A941E8F2E49454`) are deterministic, derived from the datasource `name`, reproduced
identically on a brand-new empty volume — the real cause was a literal pinned `uid` in this
file not matching the UID Grafana had already deterministically assigned and persisted in this
environment's existing `grafana_data` volume, an update-vs-insert identity mismatch, not
randomness. The fix (reference by name) is unchanged and still correct.

**D5 — `outbox-relay.parity.spec.ts`'s `TRACE_DIVERGENT_FILES` docblock updated.** Corrected in
`apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts` (the file the finding
actually names — not under `apps/billing`/`apps/fulfillment`, which own no copy of this parity
guard). It no longer claims billing/fulfillment "gained no OTel bootstrap of their own" —
feature 35 gave both their own `outbox.publish` span in `outbox-relay.ts`, guarded by each
service's `outbox-relay-trace-linkage.integration.spec.ts`. States plainly that `outbox-recorder.ts`
was untouched (still no OTel bootstrap in either service) and that retiring the exception now
requires billing/fulfillment to ALSO gain a `MeterProvider` bootstrap plus the
`recordOutboxLag`/`recordDlqDepth`/`DlqDepthPort` wiring — the span catch-up alone does not
converge `outbox-relay.ts` to byte-identical with `orders`'s copy, which still carries that
metrics half. `pnpm quality`'s lint/typecheck/OB1 test still pass with this docblock-only change.

**Verification.** `pnpm quality` run twice: **exit 0**, then **exit 0** (no `apps/web` timeout,
no other failure — a quiet-machine result consistent with D1's own "flake under load, clean
otherwise" reading for the web side). `./init.sh` — exit 0. All 18 previously-running
containers still `Up (healthy)` (19 total with `otc-kafka-exporter`, matching the corrected
README count) plus no leftover Testcontainers from the N11 probe (`docker ps -a --filter
label=org.testcontainers=true` empty). `git status --porcelain` for everything touched this
pass is exactly: `README.md`, `docker-compose.infra.yml`,
`infra/grafana/provisioning/datasources/datasources.yml`,
`apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts` — the probe spec and the
diagnostic log line are both gone, byte-exact reverted where they touched tracked files. No
commit made.
