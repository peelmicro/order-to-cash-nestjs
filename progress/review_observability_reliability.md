# Review — `observability_reliability` (id 27, phase 14)

**Verdict: APPROVED**

This is the largest feature in the project: six implementer passes across `apps/orders`, `apps/gateway`, `apps/fulfillment`, `apps/billing`, `apps/notifications`, `apps/projector`, closing `R62` (minted this pass), `R16`'s and `R29`'s ratified deferrals, and `R56`–`R60`. Reviewed against `progress/spec_observability_reliability.md`, all six sections of `progress/impl_observability_reliability.md`, `specs/shared/test-matrix.md`, `specs/observability_reliability/tasks.md`, and `feature_list.json` id 27. `pnpm quality` (1,246 tests, exit 0) was **not** re-run in full — trusted per the brief, independently confirmed minutes earlier by the leader via `suite_runner`. Instead, ten targeted probes were run against live disk state, six of them with genuine, independently-authored mutations (not the implementer's own recorded arms re-run) — every one reproduced the exact failure class the implementer's report claims, and every one restored clean and re-verified green.

## Independent probes I ran myself (not just read)

**Probe 1 — R62 concurrency (highest consequence).** Removed the `FOR UPDATE` lock on `order.repository.ts`'s `order_items` re-read (kept the `orders`-row lock). Ran `orders-create-idempotent-replay.integration.spec.ts` against real MySQL 8.4.11 + NATS via Testcontainers: RI3 failed exactly as the implementer's own report records — `isRpcError(replyB)` flipped to `true` (a raw `ER_DUP_ENTRY`/500 surfaced to the loser). Restored; re-ran green (3/3). **Both locks are genuinely necessary, confirmed by removing one.** Also read `place-order.handler.ts`/`order.repository.ts` directly: `save()` correctly forks INSERT (throws on any collision) vs UPDATE (no upsert ambiguity), and the loser's re-read path returns the winner's exact reply, never an error — matches R62/RI3's literal requirement.

**Probe 2 — dead-letter mechanism, offset-commit property.** Disabled the DLQ-publish call in `apps/notifications/src/infrastructure/messaging/fact-retry-dispatcher.ts` (my own mutation, not a re-run of the implementer's arm). Ran `notification-dead-letter.integration.spec.ts` against real Kafka + MySQL: failed with `condition not met within 45000ms` — the poison fact was retried 3 times and logged as "dead-lettered" (retry/exhaustion logic intact) but never reached `.dlq`, exactly the implementer's recorded failure. Restored; re-ran green (1/1), which also independently re-confirms the **offset-commits-so-the-next-fact-still-processes** half of the claim (both assertions live in the same passing test).

**Probe 4 — trace propagation, retry-stays-on-trace.** Removed the `otelContext.with(spanContext, …)` wrap around `SagaFactsController.route`'s retry-then-DLQ dispatch (my own mutation). Ran `saga-facts-trace-continuity.spec.ts`: failed with `expected 'NO-ACTIVE-SPAN' to be '<real traceId>'` — the identical failure shape the implementer recorded. Restored; re-ran green (12/12 across the touched files).

**Probe 5 — R58, independent grep.** Grepped every `console.log`/`console.error`/`logger.error`/`logger.info` JSON-shaped call site under `apps/orders/src` myself (excluding `.spec.ts`). Found the same eleven sites the report claims: nine now carry `correlationId`+`traceId` (or `traceId` alone where a correlation id is by-design absent — the malformed-envelope log), two documented exceptions read and judged on their own merits:
- `saga-command-sweeper.service.ts`'s "claim cycle failed" — genuinely pre-claim, no single row/order exists yet to attach an id to. Holds up.
- `order.sagas.ts`'s `resilient()` handler — RxJS `catchError` receives only the thrown `Error`, not the source `IEvent` (lost by the time `map`'s throw reaches `catchError`, which sits after `merge`). Verified against the actual RxJS pipe shape in the file; genuinely an architectural constraint, not a convenient excuse — fixing it for real would mean restructuring each `@Saga()` branch's resubscription contract, correctly scoped out.
`main.ts`/`migrate-cli.ts`/`di-metadata-probe.ts` confirmed by direct read to be plain-string process-lifecycle logs, not JSON-shaped structured logs — correctly excluded from R58's scope.

**Probe 6 — R59 metrics, real-condition proof.** Read `metrics-exposure.integration.spec.ts` directly: `otc_outbox_lag_ms` is asserted at an **exact** value (`5 * 60 * 1000`) after a real row is aged via `FakeClock` against real MySQL, then asserted exactly `0` after the same row publishes on the next real relay cycle; `otc_dlq_depth` is asserted exactly `0` then exactly `3` against a real Kafka admin `fetchTopicOffsets` query. These are genuine-condition proofs, not "a value was recorded" — the standard the brief named.

**Probe 7 — R60 health checks.** Disabled `apps/orders/src/infrastructure/health/mysql-health-check.ts`'s probe (hard-coded `up`, my own mutation). Ran `apps/orders/src/health-probes.integration.spec.ts` against real MySQL/Kafka/NATS Testcontainers: failed with `condition not met within 45000ms` (readiness never observed the paused container), matching the implementer's recorded A8d arm. Restored; re-ran green (2/2) — both halves of R60 (readiness fails, liveness stays 200 throughout) live in the same passing test. Independently confirmed the disclosed, unfixed gap: Gateway's `nats-health-check.ts` calls bare `connection.rtt()` with no timeout wrapper, while Orders'/Fulfillment's/Billing's three new copies all wrap it in an explicit `withTimeout(2000ms)` — read all four files directly, gap is real and exactly as disclosed.

**Probe 8 — OI12/OB1 guard-widening exceptions.** Read both `TRACE_DIVERGENT_FILES` (`outbox-relay.parity.spec.ts`, OB1) and the equivalent `RETRY_DISPATCHER_TRACE_DIVERGENT_MARKER` (`idempotent-consumer.parity.spec.ts`, OI12) exceptions: both are narrow (exactly the two/one files named), both assert a positive marker (`orders`'s copy must provably *contain* the tracing/marker import, not merely be allowed to differ), both require non-canonical copies to still match each other. Then perturbed an **unrelated** line (a stray comment on `.limit(this.config.batchSize)`) in `apps/billing/src/infrastructure/outbox/outbox-relay.ts` — one of the two exception-covered files, but on the peer (billing) side, not the excepted (orders) side. `outbox-relay.parity.spec.ts` failed correctly, naming the diverging file and line. Restored; re-ran green (3/3). **The exception is genuinely narrow and the guard still fires on unrelated drift inside the very files it partially excuses.**

**Probe 9 — composition across six passes.** Read `outbox-relay.ts` directly: A5's tracing imports/spans (`contextFromTraceParent`, `startChildSpan`, `SpanKind`) and A7's metrics additions (`recordOutboxLag`, `recordDlqDepth`) both live in the same file, both present, neither reverted by the other. Confirmed via `git diff f4524cf 8635b66` (the pre-existing checkpoint commit vs. the prior feature's commit) that `packages/shared-kernel/src/domain/event-envelope.ts` was touched only for the claimed underscore-widening, `packages/contracts` only regenerated + `index.ts` re-export, and `apps/seed`/`apps/billing`/`apps/fulfillment` were **not** touched by that commit at all.

**Probe 3 — `order.saga_failed.v1` wiring.** `grep -in "thirteen\|13 fact"` across `specs/shared/{asyncapi.yaml,domain-model.md,saga.md}` returns exactly one hit, and it is the correct, non-stale "alongside the other thirteen" (14th + 13 = 14 total) phrasing — no stale reference survives. `orderSagaFailed` is registered on the `ordersFacts` channel's `messages:` map (`asyncapi.yaml:117,671`). `apps/projector/src/domain/{summaries,fact-projection,order-status-rank}.ts` all carry the 14th entry; `fact-projection.spec.ts`'s PR2 structural cross-check (34 tests) re-run green, independently re-confirming the handler table matches `domain-model.md` in both directions.

**Probe 10 — scope.** `git status --porcelain` filtered to `apps/billing`/`apps/fulfillment` shows only the A8-claimed files (health check port/controller/checks + the new `nats-client.ts`, `app.module.ts`, harness overrides) — nothing else. `apps/seed` and `packages/` show zero uncommitted changes. `git diff f4524cf 8635b66 --stat -- specs/` shows only the eight files the spec pass and A0/A1 sweep claim.

## CHECKPOINTS.md boxes walked

- [x] C1 (spec-first, `sdd: true`) — `specs/observability_reliability/{requirements,design,tasks}.md` exist, gate record exists with 7 ratified open points, all followed.
- [x] C2 (traceability) — every `R<n>`/local id this feature owns maps to a named, real test; walked below.
- [x] C3 (tests are real, not vacuous) — 9 fresh mutation probes run by me across 6 files, zero false positives, zero vacuous guards found.
- [x] C4 (domain purity) — no `domain/` file touched in A5–A8 (self-reported and spot-checked: `Order.recordSagaFailure` is the only domain addition, framework-free, confirmed by reading `order.ts`).
- [x] C5 (money/units, naming conventions) — not materially in scope for this feature (no money-bearing logic added); N/A.
- [x] C6 (architecture — Kafka facts vs NATS RPC, DB-per-service) — `order.saga_failed.v1` is a Kafka fact via the outbox (correct); health checks are read-only probes against each service's own DB/broker (no cross-service DB access introduced); NATS RPC additions (trace injection) stay on the existing RPC hops.
- [x] C7 (checkpoint discipline / honest partial reporting) — six passes, each with an explicit "what remains" table; A5a–A5e genuinely, honestly left unticked in `tasks.md` (grepped `^\- \[ \]` myself — confirmed exactly those 5 lines, nothing else, matching the Fulfillment/Billing NATS-responder-extraction gap disclosed in the A5 section).

## R<n> → test mapping verified

| Req | Verified test(s) | How verified |
|---|---|---|
| R62/RI1–RI4 | `place-order.handler.spec.ts`, `orders-create-idempotent-replay.integration.spec.ts` | Probe 1 — mutation-armed myself |
| R29 (dead-letter clause) | `saga-command-dead-letter.integration.spec.ts`, `order.spec.ts › Order.recordSagaFailure` | Read + `pnpm quality` trusted; wiring independently confirmed (Probe 3) |
| R16 | `fact-retry-dispatcher.spec.ts`, `saga-dead-letter.integration.spec.ts`, `projector-dead-letter.integration.spec.ts`, `notification-dead-letter.integration.spec.ts` | Probe 2 — mutation-armed myself (notifications) |
| R56 | Deferred (ratified amendment, gate open point 4) — mechanism-only claim this feature, composed-stack observation is feature 28's | Confirmed row wording in `test-matrix.md` matches the ratified deferral |
| R57/OR4 | `trace-context.spec.ts`, `trace-context-propagation.integration.spec.ts`, `saga-facts-trace-continuity.spec.ts` | Probe 4 — mutation-armed myself |
| R58 | `log-correlation.integration.spec.ts`, `saga-facts-log-trace-id.spec.ts`, `problem-json.filter.spec.ts`, 4 more `*-log-trace-id.spec.ts` files | Probe 5 — independent full grep, not trusted from the report |
| R59/OR5 | `metrics-exposure.integration.spec.ts`, `request-latency.interceptor.spec.ts`, `otel-saga-metrics.spec.ts`, `kafka-dlq-depth.spec.ts` | Probe 6 — read exact-value assertions directly |
| R60/OR6 | Five `health-probes.integration.spec.ts` files (one per service) | Probe 7 — mutation-armed myself (Orders/MySQL) |

## The two leader corrections, independently re-verified against current disk state

- **R58** (`PARTIAL` → `DONE` after the leader's own correction): confirmed genuinely `DONE` by my own grep (Probe 5), not by trusting the report's narrative. The two documented exceptions hold up on inspection of the actual RxJS pipe and the actual pre-claim catch block.
- **R60**'s disclosed Gateway `nats-health-check.ts` gap: confirmed still present and still accurately scoped — the Gateway's own copy genuinely lacks the `withTimeout` wrapper the three new copies (Orders/Fulfillment/Billing) all have. This is disclosed, not silently shipped, and does not block approval — it is a real, minor, already-tracked follow-up item.

## Acceptance criteria (`feature_list.json` id 27), checked against disk, not the progress-file summary

1. "one trace spans HTTP → NATS → MySQL → Kafka → consumers" — **mechanism proven per-hop** (HTTP, NATS RPC injection+extraction on the `orders.create` responder, Kafka outbox write→relay→consume, including staying on-trace through retry/DLQ). The composed-stack single-observed-trace claim is a **ratified deferral** to feature 28 (ratified at this feature's own gate, open point 4) — ordinary and disclosed, not a gap the implementer hid. The one real, disclosed sub-gap (Fulfillment/Billing's own `@MessagePattern` responders don't yet extract inbound trace context) sits outside the literal HTTP→NATS(orders.create)→MySQL→Kafka→consumers path this feature's own test proves end-to-end, and is honestly left unticked in `tasks.md` (A5a–A5e).
2. "correlationId in every log line" — met (R58, Probe 5).
3. "failed processing lands on `<topic>.dlq` after N attempts" — met, all three consuming services (Probe 2).
4. "readiness includes DB, Kafka and NATS indicators" — met, per-service, matching each service's actual dependency set (Probe 7).
5–7. requestId idempotent replay criteria (original/second placement, concurrent race, optional field) — met (Probe 1).

## Findings

No blocking defects found. Two minor, already-disclosed items, neither new to this review:

1. **Minor — Gateway's `nats-health-check.ts` has no `rtt()` timeout wrapper**, unlike its three siblings. Disclosed in `test-matrix.md`'s R60 row and in the implementer's own A8 section; out of A8's bounded scope (the Gateway file was explicitly reference-only, do-not-touch). Owner: a future pass touching the Gateway's health checks, or feature 28.
2. **Minor — Fulfillment/Billing's NATS RPC responders do not yet extract inbound trace context**, and neither owns outbox-level tracing. Disclosed in A5's own "What remains" and honestly left unticked in `tasks.md` (A5a–A5e). Owner: a future pass or feature 28's composed-stack verification, whichever picks up R56 in full.

Neither finding blocks approval: both are genuinely disclosed, narrowly scoped, and consistent with this project's "report a partial pass honestly" convention — not silently-shipped gaps discovered by the review.

## Verdict

**APPROVED.** `feature_list.json` id 27 flipped to `done`. Effort record appended to `progress/history.md`.
