# review: observability_dashboards (feature 35, phase 22)

**Verdict: APPROVED** — first review, 2026-08-30. Feature 35 set `done` in `feature_list.json`; effort record appended to `progress/history.md`.

`sdd: false`. The specification of record is `feature_list.json` id 35's three acceptance criteria. All three are met, and I verified each independently rather than re-reading the implementer's evidence.

## What I ran, and what I deliberately did not re-run

Per `CLAUDE.md`'s reviewer economics: I did not re-run the two services' unit suites (the implementer's 148 + 83 claim), because no claim under test was about them and `pnpm quality` covers them transitively. I did re-run both **integration** suites in full, because the brief's own second question — "confirm adding a span did not change the outbox relay's behaviour" — is exactly a claim about those suites. Everything else below is my own probe, not a repetition.

- `pnpm quality` — **twice**, exit **1** then exit **0** (see D1).
- `apps/billing` integration (Testcontainers) — 22 files, **1 failed / 73 passed**, then the failing file alone: **10/10 passed** (see D1).
- `apps/fulfillment` integration (Testcontainers) — **15 files / 50 tests passed, exit 0**. Matches the implementer's report exactly.
- One armed mutation on `apps/fulfillment/src/infrastructure/outbox/outbox-relay.ts`, restored byte-exact.
- One real order placed through the Gateway, its trace pulled from Jaeger and its parent/child graph reconstructed from the raw API.
- The Grafana dashboard opened in a real Chromium browser, logged in through the UI, all five panels read out of the DOM.
- A zero-state Grafana cold start in a throwaway container with a fresh volume.
- `./init.sh` — exit **0**.

## Acceptance criteria

### 1. "single distributed trace screenshot captured" — verified by reproducing it, not by looking at the PNG

I placed my own order (`ORD-000187`, `bda84ec1-0be4-4863-a001-4a5bc13bf0c2`, `PRD-0002` ×2 + `PRD-0003` ×1, IBERFOODS/CarrefourEs) through `POST /orders` on the Gateway, supplying my own `traceparent` so the trace id was known to me in advance rather than searched for after the fact.

**Trace `8bff871452b2503157da7674b51d9c15` — 22 spans, 6 services: `billing`, `fulfillment`, `gateway`, `notifications`, `orders`, `projector`.**

The parenting is real, not sibling spans sharing an id. Reconstructed from Jaeger's `references[].refType == CHILD_OF` edges, the tree has exactly **one** root (the gateway's `POST`, whose declared parent is my own synthetic span, correctly absent from the trace) and depth 11:

```
gateway        POST
  orders         outbox.publish order.placed.v1
    projector      fact.consume order.placed.v1
    notifications  fact.consume order.placed.v1
    orders         saga.consume order.placed.v1
      fulfillment    outbox.publish stock.reserved.v1
        orders         saga.consume stock.reserved.v1
          billing        outbox.publish credit.approved.v1
            orders         saga.consume credit.approved.v1
              orders         outbox.publish order.confirmed.v1
                projector      fact.consume order.confirmed.v1
                notifications  fact.consume order.confirmed.v1
              fulfillment    outbox.publish order.despatched.v1
                orders         saga.consume order.despatched.v1
                  billing        outbox.publish invoice.issued.v1
                    projector      fact.consume invoice.issued.v1
                    orders         saga.consume invoice.issued.v1
                    notifications  fact.consume invoice.issued.v1
                projector      fact.consume order.despatched.v1
                notifications  fact.consume order.despatched.v1
            projector      fact.consume credit.approved.v1
        projector      fact.consume stock.reserved.v1
```

This is structurally identical to the implementer's reported tree for `e9274e56…`, independently produced. `notifications` arrived last (it retries three times against Mailtrap before dead-lettering, ~5 s per fact) — at first poll the trace held 18 spans / 5 services and settled at 22 / 6.

The committed screenshot `docs/screenshots/jaeger-single-order-trace.png` is genuine: Jaeger's trace-detail view for `e9274e5…`, "Services 6", "Total Spans 22", "Depth 11", waterfall matching the tree above.

**The NATS hops: honest answer — the context crosses them, but they produce no span.** There is no `nats.request`/`nats.reply` span anywhere in the trace. What the trace proves is that the *context* survives every NATS hop, which is a strictly weaker but genuine claim, and it is proved structurally: `orders outbox.publish order.placed.v1` is a **child of** the gateway's `POST` span, and that edge can only exist because the gateway's active context travelled over the `orders.create` NATS RPC into Orders' responder and was persisted into the outbox row's `trace_parent`. Likewise `fulfillment outbox.publish stock.reserved.v1` is a child of `orders saga.consume order.placed.v1` — an edge that exists only because Orders' saga carried its context over the `fulfillment.stock.reserve` NATS RPC.

This is **not a regression and not a gap this feature opened**. `specs/observability_reliability/design.md` §4.3 rules explicitly that `kafkajs` and `nats` have no OTel auto-instrumentation and that spans are therefore created manually at exactly two points — the outbox relay's publish and the consume call — with the NATS adapters injecting/extracting headers only. Feature 35 closed the half of that ruling billing and fulfillment had never implemented; it did not widen the ruling itself, and feature 35's acceptance does not ask it to. Recorded as **D7 (informational)** with a recommendation, not as a defect against this feature.

### 2. "panels: saga duration, per-service latency, consumer lag, outbox lag, DLQ depth" — all five render, in a browser

I did not trust the Prometheus API. I drove Chromium against `http://localhost:3030`, logged in through the real login form, opened `/d/otc-overview/…?from=now-6h&to=now`, waited for the queries to settle and read the panel DOM.

**`"No data"` occurrences in the rendered page: 0. Panels found: 5. Datasource/query errors in the DOM: none.**

| Panel | What it actually displayed |
|---|---|
| Saga duration | Two series, `completed p95` and `completed p50`, plotted at 10 s. Sparse (one bucket) but real — `SagaFactHandler` only records this on a terminal transition. |
| Per-service latency | 10 series plotted. `gateway — OrdersController.placeOrder` at **205 ms** (my own order, visible as a live spike), plus `AuthController.login` 4.75 ms, `CatalogController.listProducts` 24.25 ms, `HealthController.ready` 4.80 ms, `InvoicesController.registerPayment` 47.5 ms, `StockController.listStock` 72.5 ms, and `orders — consumer=orders.saga` at 43.1 ms. |
| Kafka consumer lag | 9 series (3 groups × 3 topics), all `0` at rest — **and a visible spike to 2 at the moment my order flowed through**, which is the evidence that matters: the exporter tracks real broker offsets, it is not a permanently-flat stub. |
| Outbox lag | 1 series, `orders`, `0` ms — genuinely caught up. |
| DLQ depth | 3 series: `otc.orders.facts.v1.dlq` **449**, `otc.billing.facts.v1.dlq` **185**, `otc.fulfillment.facts.v1.dlq` **98**. |

I additionally drove every panel's PromQL through Grafana's own `/api/ds/query` (the endpoint the frontend calls, which is what would expose a datasource-resolution fault rather than a PromQL fault): every target returned frames with non-null points — 56, 88, 45, 149 and 149 points respectively. The by-name `"datasource": "Prometheus"` reference resolves correctly.

Per-service latency covers Gateway and Orders only. That is honestly disclosed by the implementer and by the panel's own title; the other four services run no `MeterProvider`, which is `design.md` §4.5's still-standing scope decision, not something this feature could fix without widening into application code.

### 3. "dashboard auto-provisioned" — survives a *true* cold start, not just a restart

Two tests, the second stronger than anything the implementer ran:

1. **Container recreate.** `docker rm -f otc-grafana otc-kafka-exporter`, then compose `up -d`. Both healthy in ~5 s; `GET /api/search?query=Order` → 1 result, `uid: otc-overview`. No manual import.
2. **Zero-state cold start.** A throwaway `grafana/grafana:13.2.0` on port 3031 with a **brand-new empty volume** and only the two repo bind mounts — deliberately *not* the user's `grafana_data`, so nothing of theirs was destroyed. From literally nothing: **1 dashboard (`otc-overview`) and both datasources (`Prometheus`, `Jaeger`) provisioned, zero `level=error` provisioning lines.** This is the case a fresh clone hits, and it works.

`meta.provisioned: true`, `provisionedExternalId: order-to-cash-overview.json`, `allowUiUpdates: false` — the dashboard is a build artefact, not UI state.

## Outbox relay — the regression assessment

This is the durability spine, so I treated it as the highest-risk change in the feature. Four independent checks:

1. **The diff is a verbatim mirror of the canonical.** I read `apps/orders/src/infrastructure/outbox/outbox-relay.ts` in full and diffed the added block against both copies. The claim holds: the span array, the per-row `if (row.traceParent)` guard, `propagation.inject(started.spanContext, headers)`, the `spans[index]` per-row `traceId` read in the catch block, the `setStatus(ERROR)` + `end()` loop on failure and the `end()` loop on success are line-for-line Orders'.
2. **Publish, stamping and failure handling are untouched.** The claim/`SELECT … FOR UPDATE SKIP LOCKED`/`ORDER BY seq`/`LIMIT batchSize` is unchanged; `withPublishTimeout` is unchanged; the `catch` still `return`s `{ claimed, published: 0 }` **before** the `UPDATE … SET publishedAt` — so a publish failure still leaves the whole batch unstamped for the next poll (OI8). Every added statement is span bookkeeping; none of them sits between the publish and the stamp, and none can change the stamp decision. The only non-span change is an extra optional `traceId` key on an existing error log line.
3. **The parity guard still holds and is not vacuous.** `apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts` (OB1) exempts `outbox-relay.ts` for `orders` but requires billing and fulfillment to stay byte-identical to **each other**. I verified this by hand outside the test — banner-stripped, `apps/billing`'s and `apps/fulfillment`'s copies are byte-identical (`cmp` clean); billing vs orders differs by 95 lines, all of it the `MeterProvider`-dependent `recordOutboxLag`/`recordDlqDepth`/`DlqDepthPort` code neither service can carry. The exception is still needed and the guard still fires.
4. **Mutation probe — the new test is load-bearing.** I reverted `apps/fulfillment`'s relay to the exact pre-fix behaviour (`headers.traceparent = row.traceParent;`, verbatim forward, no span) and ran the new integration spec against real MySQL + real Kafka:

   ```
   × a reserve-transaction row written inside an active span is published with fulfillment's OWN
     "outbox.publish" span — same trace, a fresh child span id, not the raw stored header forwarded verbatim
   AssertionError: expected '2422046fbfd66dc0' not to be '2422046fbfd66dc0'
   ```

   Killed precisely, by the assertion that names the defect, with the forwarded span id printed in the message. Restored byte-exact — `sha256sum -c` OK, `cmp` clean, `git status --porcelain` identical to the pre-review snapshot.

The two new specs are real: real MySQL + real Kafka via Testcontainers, a real `NodeTracerProvider` + `InMemorySpanExporter`, and every assertion reads a real OTel-generated id back out of the actually-published Kafka headers through the same extraction path a consumer uses. The second case (no active trace → no header, no span, no fabricated trace) is the correct negative guard.

**Conclusion: no regression.** The relay's durability contract is intact.

## kafka-exporter — proportionate and correct

- **Correct.** `kafka_consumergroup_lag`'s `consumergroup` labels are exactly `orders.saga-server`, `projector-server`, `notifications-server` — which I cross-checked against the broker's own `kafka-consumer-groups.sh --list`: the same three, no more, no fewer. 741 `kafka_*` series exposed. The values move with real traffic (the spike my order produced).
- **Cold start.** `docker rm -f otc-kafka-exporter` then compose `up -d` → **healthy in ~5 s**, `depends_on: kafka: service_healthy`, healthcheck wgets its own `/metrics`. Clean.
- **Proportionate.** Measured: **7.4 MiB RSS, 0.00% CPU** — against Grafana's 256 MiB and Prometheus' 33 MiB. Negligible. The alternative (per-service in-app lag bookkeeping across four Kafka consumer paths) would have been a far larger, application-code change for a config-and-dashboards phase. The decision is right and the reasoning is written into `docker-compose.infra.yml` where a reader will find it.
- **But the cost is not documented** — see D3.

## The DLQ finding — assessment and recommendation (not implemented)

I confirmed the finding independently. Depths at the end of my review: **449 / 185 / 98 = 732** (up from the leader's 728 by exactly the 4 dead letters my own order produced — 2 orders, 1 billing, 1 fulfillment). A dead letter read straight off `otc.orders.facts.v1.dlq`:

```
x-failed-consumer:notifications
x-attempts:3
x-error:Error: Invalid login: 535 5.7.0 The email limit is reached. Please upgrade your plan …
x-original-topic:otc.orders.facts.v1
x-first-failed-at:2026-08-29T10:50:35.770Z
x-failed-at:2026-08-29T10:50:40.821Z
x-event-type:order.placed.v1
traceparent:00-11842592964d7ef13ac5797a5ebb396e-b72c8e0f432adf44-01
```

**The DLQ machinery is working exactly as designed, and this is not a code defect.** Three attempts, then dead-lettered with a complete diagnostic header set including a `traceparent` that makes every dead letter traceable back to its order. The cause is an exhausted external SaaS quota.

One nuance worth recording, because it explains why the fallback did not save this: `apps/notifications/src/app.module.ts`'s `NOTIFICATION_SENDER` factory selects `ConsoleNotificationSender` when `resolveNotificationSenderBinding()` finds no *complete, valid-looking credential pair*. The Mailtrap credentials here are present and well-formed — they are merely over quota, which only manifests as a 535 at send time. So the fallback is credential-**presence**-based, not credential-**validity**-based, and cannot catch this. That is a reasonable design; noting it so nobody expects the fallback to have prevented this.

**Does the panel present this usefully? No — and that is a real, if minor, gap.** A viewer seeing `449` on `otc.orders.facts.v1.dlq` learns which *source topic* the failures came from and nothing else: not which consumer failed, not why, not whether it is still happening. Every one of those facts exists, in the message headers, one shell command away — and the dashboard is precisely the artefact whose job is to stop people needing that shell command.

**Recommendation — do not block feature 35 on this; it delivers "DLQ depth", which is the criterion.** Two follow-ups, deliberately split by cost:

1. **Cheap, zero application code, and I would fold it into this phase or the next docs phase.** (a) Add a second query to the existing panel — `delta(otc_dlq_depth_ratio[15m])` or similar — so an operator sees *new dead letters per window* rather than only a cumulative line that can never go down. A monotonically-rising total is close to unreadable as an alerting signal: it looks identical whether the last dead letter was 30 seconds or 3 days ago. (b) Add a text panel next to it carrying the header contract (`x-failed-consumer`, `x-error`, `x-attempts`, `x-original-topic`, `traceparent`) and a deep link to the already-running Redpanda Console (`otc-kafka-console`, port 8080) filtered to the `.dlq` topics. That turns "447" into "447, and here is exactly how to find out why" without a line of application code.
2. **Follow-up feature, out of this phase's remit.** Surfacing the *reason* as a metric needs a labelled counter — e.g. `otc_dlq_dead_lettered_total{consumer, eventType, errorClass}` incremented by `FactRetryDispatcher` at the moment it dead-letters. That means touching the retry dispatcher in every consuming service and giving notifications/projector a `MeterProvider` they do not have. It is the right answer and it is application-code work; it should be specced, not smuggled into a dashboards phase.

## Defects — all non-blocking

**D1 — `pnpm quality` is not deterministic under load; the implementer's "exit 0" is true only on a quiet machine.** My first run exited **1**: `apps/web test:coverage` failed 2 of 15 files (`app/lib/problem.spec.ts`, `app/pages/orders/place.hydration.spec.ts`) with `Error: Hook timed out in 10000ms` in `@nuxt/test-utils`' `setupNuxt()` `beforeAll`. Re-run in isolation: **15/15 files, 74/74 tests, exit 0**. My second full `pnpm quality`: **exit 0**. Separately, `apps/billing`'s integration suite failed `N11 — the sequential and concurrent forms of the SAME cross-invoice paymentReference reuse return the SAME CONFLICT answer` with `expected 'INTERNAL_ERROR' to be 'CONFLICT'` (`src/payment-register.integration.spec.ts:408`); that file re-run alone passes **10/10**. Both are load-induced flakes in code feature 35 never touched (nothing under `apps/web`; nothing in billing's payment path), so neither blocks. But two independent flakes in one review is a pattern: `apps/web`'s 10 s Nuxt hook timeout is the cheapest fix (raise `hookTimeout` in `apps/web`'s vitest config), and `N11` deserves a look at whether a genuine concurrent duplicate can surface as `INTERNAL_ERROR` rather than `CONFLICT` under contention — that would be a real defect, not a flake, and only load reveals which it is. **Filed for the leader as a follow-up; not attributable to feature 35.**

**D2 — `README.md` container counts are stale.** Line 145 still reads `pnpm dc:up:infra   # 10 containers + a one-shot kafka-init job`; the infra stack is now **11** long-running services with `kafka-exporter`. Line 39's `Docker Compose (~18 containers)` is now ~19. The implementer added a good README paragraph about the dashboard but did not sweep the counts it invalidated. Matters because the count is the reader's first sanity check that their `docker ps` looks right.

**D3 — the new always-on container's resource cost is undocumented.** The brief asked for it; neither `docker-compose.infra.yml`'s comment nor the README states it. I measured **7.4 MiB / 0.00% CPU**, which is the number that makes the decision obviously correct — it should be written down where the container is defined, in a stack the README itself flags as memory-sensitive.

**D4 — `infra/grafana/provisioning/datasources/datasources.yml`'s new comment records an inaccurate root cause.** It states the UID pinning failed because `grafana_data` "already carried persisted datasource rows from earlier phases' runs with **Grafana-assigned UIDs**". My zero-state cold start produced the **identical** UIDs — `PBFA97CFB590B2093` (Prometheus) and `PC9A941E8F2E49454` (Jaeger) — on a brand-new empty volume, so those UIDs are deterministic, derived from the datasource name, not arbitrary per-install values. Whatever broke the boot, it was not "Grafana assigned an unpredictable UID". The chosen fix (reference by name) is correct and robust regardless, so this is a comment that will mislead a future reader, not a functional problem.

**D5 — `outbox-relay.parity.spec.ts`'s exception comment is now stale.** `TRACE_DIVERGENT_FILES`' docblock (lines 48–80) says `apps/billing` and `apps/fulfillment` "are explicitly out of scope and gained no OTel bootstrap of their own this pass", and that "a future pass that gives billing/fulfillment their own OTel bootstrap should backport this wiring and retire this exception". Feature 35 **is** that pass, for `outbox-relay.ts`. The exception must stay (Orders still diverges on the `MeterProvider` metrics), but the comment now describes a world that no longer exists and states a retirement condition that has partly been met. The guard itself is unaffected and still passes.

**D6 — process wrinkle for the leader.** Feature 35's status was `pending` throughout implementation, never `in_progress`. `init.sh` reports "no feature in_progress", so `CHECKPOINTS.md` C2 passed vacuously for this feature rather than by being satisfied.

**D7 — informational, pre-existing, not this feature's to fix.** No NATS RPC hop produces a span anywhere in the system (see §1). The trace's *context* crosses every hop and the parenting proves it, but RPC latency, subject and failure are invisible in Jaeger; the `orders.create`, `fulfillment.stock.reserve`, `billing.credit.*` calls have no span of their own. This is `specs/observability_reliability/design.md` §4.3's ratified "manual spans at exactly two points" decision. **Recommendation:** if the trilogy wants the criterion's literal HTTP → NATS → MySQL → Kafka → consumers chain visible as spans rather than inferable from parenting, that is a follow-up feature adding `CLIENT`/`SERVER` spans in `nats-rpc-client.adapter.ts` and the `@MessagePattern` responders — cheap (the extract/inject plumbing already exists; only `startSpan` is missing) and high-value, since the NATS legs are currently the only unmeasured hops in the saga.

**D8 — environment note, not a defect in the change.** I could not run a literal cold `pnpm dc:up:infra`: this machine's `otc-net` was created outside compose and carries no compose labels, so `docker compose -f docker-compose.infra.yml up` refuses with `network otc-net was found but has incorrect label`. This is the pre-existing trap `README.md` line 111 already documents. I verified `kafka-exporter`'s cold start through the merged `-f docker-compose.infra.yml -f docker-compose.apps.yml` invocation instead (that file declares the network `external: true`), which exercises the identical service definition. A fresh clone would never hit this.

## CHECKPOINTS.md — boxes walked

### C1 — The harness is complete

- [x] `AGENTS.md`, `CLAUDE.md`, `CHECKPOINTS.md`, `feature_list.json`, `init.sh` all exist.
- [x] `progress/current.md` and `progress/history.md` exist.
- [x] `.claude/agents/` holds leader, spec_author, implementer, reviewer, test_maintainer — `init.sh` confirms, plus `suite_runner`.
- [x] Every agent definition declares its model — `init.sh` `[OK]` on each.
- [x] `./init.sh` exits **0**.

### C2 — State is coherent

- [x] At most one feature `in_progress` — zero, in fact (see D6).
- [x] Every status is in `rules.valid_status`.
- [x] Every `done` feature has passing tests associated with it.
- [x] `progress/current.md` describes the active session.
- [x] Every `blocked` feature records why — none blocked.

### C3 — Architecture is respected

- [x] No `@nestjs/*`, `drizzle-orm`, `kafkajs`, `nats` or `mongodb` import inside any `domain/` folder — ESLint-verified via `pnpm quality` (exit 0). This feature added nothing under any `domain/`; both touched files are `infrastructure/`.
- [x] No cross-service database access — unchanged; nothing in this feature touches persistence.
- [x] No shared runtime code beyond `shared-kernel` and `contracts` — the relay/trace-context copies are per-service duplicates policed by OB1's parity guard, which I re-verified by hand.
- [x] `packages/shared-kernel` still has zero runtime dependencies — untouched.
- [x] Every inter-service interaction classifiable as Kafka-fact or NATS-RPC — unchanged; this feature adds observation, not interaction. The `outbox.publish` spans are `SpanKind.PRODUCER` on the Kafka legs, correctly classified.
- [x] No stray debug logging, no context-free TODOs — the one added log field is a structured `traceId` on an existing error line, mirroring Orders'.

### C4 — Verification is real

- [x] `pnpm quality` passes — **exit 0** on the clean run; exit 1 once under load, both failures flakes in untouched code (D1).
- [x] Domain tests are pure — unaffected; no domain test touched.
- [x] Integration tests use Testcontainers against real MySQL / Kafka / NATS / MongoDB — the two new specs use real MySQL + real Kafka + a real tracer provider; I ran both suites myself.
- [x] Coverage thresholds met — no threshold failure in either `pnpm quality` run.
- [x] No Jest anywhere — Vitest only; the new specs use Vitest.

### C5 — The session closed cleanly

- [x] No suspicious untracked files — the untracked set is exactly the two new specs, `docs/screenshots/`, `infra/grafana/dashboards/`, `infra/grafana/provisioning/dashboards/` and the two `progress/` reports.
- [x] `progress/history.md` has an entry for this feature **including its effort record** — appended by this review.
- [x] `feature_list.json` reflects the true state — feature 35 set `done` by this review.
- [ ] The human has been told what was done and how to test it manually — **the leader's to do**, at the phase report.
- [x] Claude did not commit.

### C6 — Spec-Driven Development

- N/A — feature 35 is `sdd: false`. `init.sh` confirms all 8 `sdd: true` features past `pending` carry their triple-doc. No `specs/` file was touched by this feature, correctly.

### C7 — Trilogy reusability

- [x] `specs/shared/` contains no stack specifics — untouched by this feature.
- [x] `n8n/workflows/*.json` reference only the Gateway REST API — untouched.
- [x] `progress/history.md` effort records are complete and honest — this feature's appended below.

## Traceability

`sdd: false`, so there is no `requirements.md` and no `R<n>` set of its own. The mapping is acceptance criterion → the evidence that proves it:

| Acceptance criterion | Named test / verification | Verified by me |
|---|---|---|
| panels: saga duration, per-service latency, consumer lag, outbox lag, DLQ depth | No unit test — a dashboard is config. Verified live: 5 panels rendered in Chromium, 0 × "No data", every target returning non-null frames through Grafana's own `/api/ds/query` | yes, browser + API |
| dashboard auto-provisioned | `GET /api/search` after container recreate **and** after a zero-state cold start with a fresh volume | yes, both |
| single distributed trace screenshot captured | `docs/screenshots/jaeger-single-order-trace.png` (trace `e9274e56…`, 6 services / 22 spans / depth 11) | yes — plus my own independent trace `8bff8714…`, 6 services / 22 spans |
| *(supporting)* the trace-linkage fix is real and guarded | `apps/billing/.../outbox-relay-trace-linkage.integration.spec.ts` and `apps/fulfillment/.../outbox-relay-trace-linkage.integration.spec.ts`, 2 cases each | yes — mutation-probed; the pre-fix behaviour is killed by the named assertion |
| *(supporting)* the relay copies have not drifted | `apps/orders/src/infrastructure/outbox/outbox-relay.parity.spec.ts` (OB1) | yes — re-verified by hand outside the test |

## What was checked and found clean

- Scope: `git status --porcelain` is exactly the declared set — `infra/**`, `docker-compose.infra.yml`, the two services' observability/outbox files plus their two new specs, `docs/`, `README.md`, `progress/`. **Nothing in `feature_list.json`, `specs/`, or any other app's domain logic**, as the brief required.
- All **18** containers `Up (healthy)` at close, including `otc-kafka-exporter`, `otc-grafana` and the recreated pair. `otc-kafka-init` is a completed one-shot, as designed.
- `.env` untouched. The Mailtrap decision remains the human's.
- No commit, no push.
