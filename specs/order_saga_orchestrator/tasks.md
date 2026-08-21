# `order_saga_orchestrator` — Tasks

> Work top to bottom. Tests are written **inside** each group, not at the end. Every task is small enough to verify before ticking. References: `requirements.md` (SO1–SO8, shared R19–R29), `design.md` (§ numbers below — §5.5/§9 for the cqrs composition mandated by the gate's open-point-3 overrule).

## A — Schema and migration (design §7)

- [x] **A1.** Add `saga-commands.schema.ts` (columns + unique `(order_id, command)` + status/next-attempt index) and `saga-ignored-facts.schema.ts` to `apps/orders/src/infrastructure/persistence/schema/`, exported from `index.ts`.
- [x] **A2.** Generate `apps/orders/drizzle/0003_*.sql` via `pnpm --filter @otc/orders db:generate`; commit it unedited (escape hatch and its recording rule as in feature 14 §3.4 if drizzle-kit emits invalid SQL).
- [x] **A3.** Extend `migrations.integration.spec.ts` with round-trips for both new tables (typed insert + `toMatchObject` + `information_schema` index assertions), Testcontainers MySQL `mysql:8.4.11`.
- [x] **A4.** Run `apps/seed/src/outbox-parity.spec.ts` and assert it still passes — the new migration must not touch `outbox`/`processed_events` (design §7).

## B — The step table (design §4)

- [x] **B1.** `application/saga-steps.ts`: the 13-row table as data (`skip`/`advance`/`cancel`), `mapReason`, `stepsFrom(fact)` building `CompensationStep[]` from `stock.released.v1`, `TransitionContext` sourced from the fact's `occurredAt`/`eventId` (§4.1).
- [x] **B2.** `application/saga-steps.spec.ts`: **every fact × every one of the 9 statuses** — expected aggregate call(s), owed command, ignore, or skip; path A cancels with `[]` and owes nothing (R26); path B leaves `stock_reserved` unchanged on `credit.rejected.v1` (R27) and cancels with one `stock_released` step on `stock.released.v1` (R28, SO7); `credit.approved.v1` performs both edges with exactly one `order.confirmed.v1` (R21). Pure domain-level tests, no framework (SO2 row included).

## C — Ports and command payloads (design §6.1, §6.3)

- [x] **C1.** `application/ports/saga-commands.port.ts`: `SAGA_COMMANDS` token, the five typed methods, `SagaCommandTimeoutError` / `SagaCommandTransportError`.
- [x] **C2.** `application/ports/saga-command-store.port.ts`: `SAGA_COMMAND_STORE` token, `enqueue(tx, cmd)`, `claimDue(tx, now)`, `markSent`, `park`; payload snapshot built from the loaded aggregate at enqueue time.

## D — Infrastructure adapters (design §6)

- [x] **D1.** `infrastructure/messaging/nats-saga-commands.adapter.ts` on the shared `NATS_CONNECTION`, per-call timeout, subjects as constants; extend the read-the-spec-as-text guard to assert the five subjects equal the AsyncAPI channel addresses.
- [x] **D2.** `nats-saga-commands.adapter.spec.ts`: timeout / no-responders / transport / RpcError-body taxonomy against the `NatsRequestClient` fake (feature-15 pattern).
- [x] **D3.** `infrastructure/saga/drizzle-saga-command-store.ts` (enqueue in caller's tx; `claimDue` with `FOR UPDATE SKIP LOCKED`) and `infrastructure/saga/saga-ignored-facts.repository.ts` (insert in caller's tx, `precondition_unmet` / `unknown_order` markers).
- [x] **D4.** `infrastructure/saga/saga-command-dispatcher.ts` implementing SO4 (3 attempts, 500 ms ×2 backoff, 5 s per-attempt) + SO6 (resolved reply ⇒ `sent`, business rejection included) + SO5 park transition; header comment stating the session-timeout budget constraint (§3.2).
- [x] **D5.** `saga-command-dispatcher.spec.ts`: retry counts, backoff schedule via fake delay, park on exhaustion, no retry on `rejected` reply.
- [x] **D6.** `infrastructure/saga/saga-command-sweeper.service.ts`: self-scheduling `setTimeout` chain, `SAGA_SWEEPER_*` config, graceful shutdown; `saga-command-sweeper.spec.ts` proves no-overlap and claim→dispatch→reschedule.

## CQ — the cqrs composition (design §5.5, §9)

- [x] **CQ1.** Add `@nestjs/cqrs` `^11` to the workspace catalog (`pnpm-workspace.yaml`, commented per the catalog style) and to `apps/orders/package.json` as `"catalog:"`; import `CqrsModule.forRoot()` in `app.module.ts`. The package must appear in the phase commit message's package section.
- [x] **CQ2.** `application/commands/saga-fact.commands.ts`: the ten `Handle<Fact>FactCommand` classes + the `factCommandFor(eventType)` map (self-produced facts map to nothing); `saga-fact.handlers.ts`: ten `@CommandHandler` wrappers delegating to `SagaFactHandler`, publishing the dispatch-owed event on the `EventBus` only on `processed`-with-enqueue, explicit `@Inject(TOKEN)` constructors; `saga-fact.handlers.spec.ts` (delegation; publish only after processed-with-enqueue; nothing on duplicate/ignored).
- [x] **CQ3.** `application/events/saga-dispatch.events.ts`: the five dispatch-owed application events (plain classes, `orderId` + `correlationId`); `application/commands/saga-dispatch.commands.ts`: the five `Issue<Command>Command` classes; `saga-dispatch.handlers.ts`: five `@CommandHandler` wrappers → `SagaCommandDispatcher.dispatch(orderId, command)`; `saga-dispatch.handlers.spec.ts` (each Issue command claims + dispatches its `(orderId, command)` pending row; stale/absent row is a silent no-op).
- [x] **CQ4.** `application/sagas/order.sagas.ts`: `OrderSagas` — one `@Saga()` method, five `ofType` streams, pure event→command `map`, defensive no-termination wrapping; `order.sagas.spec.ts` **proves the stream mapping** (each of the five events in ⇒ its `Issue…Command` out) and that a stream error does not terminate the subscription — plain RxJS `Subject`, no Nest runtime (SO3 fast-path row).

## E — Application handler, presentation, wiring (design §3, §5)

- [x] **E1.** `application/saga-fact-handler.ts`: the §5.1 flow over the **existing unmodified** `IdempotentConsumer` (`'orders.saga'`), unknown-order (SO8) and precondition-unmet (R25) recording, in-tx command enqueue (SO3), returning `SagaFactResult` (`outcome` + `enqueued`) — no direct dispatcher call, the post-commit hop is CQ2's; `saga-fact-handler.spec.ts` with fakes.
- [x] **E2.** `presentation/saga-facts.controller.ts`: three `@EventPattern`s on the topic addresses, `parseFactEnvelope`, malformed-envelope log-and-ack policy (§3.3), `factCommandFor` skip-map (SO2 — no dispatch for self-produced facts), awaited `commandBus.execute` of the mapped fact command, explicit `@Inject(TOKEN)` per the DI rule; `saga-facts.controller.spec.ts`.
- [x] **E3.** `main.ts`: `connectMicroservice` Kafka (`groupId: 'orders.saga'`, `fromBeginning: true`, `partitionsConsumedConcurrently: 1`); **verify** the throw-⇒-no-commit-⇒-redeliver semantics of the installed `@nestjs/microservices` and add `KafkaRetriableException` wrapping if needed (§3.1) — record the finding in the progress file.
- [x] **E4.** `app.module.ts`: providers for the new port tokens, dispatcher, store, sweeper service — `useFactory` + `inject: [...]`, no new connection objects (reuse `NATS_CONNECTION`, `ORDERS_DB`, `CLOCK`, `UNIT_OF_WORK`, `ORDER_REPOSITORY`); the fifteen `@CommandHandler`s + `OrderSagas` as class providers with explicit `@Inject(TOKEN)` constructors (design §2 wiring note).
- [x] **E5.** `.env.example`: the §6.2/§6.4 settings with comments; `kafka.config.ts` gains the two consumed-topic constants + spec-text guard.

## F — Integration proof (design §8.1; Testcontainers MySQL + Kafka 6-partition topics + NATS)

- [x] **F1.** `test-support` stubs: `stub-saga-responders.ts` (five subjects, programmable replies, request recording) + fact publication through `kafka-test-fixture.ts` keyed by `correlationId`.
- [x] **F2.** `saga-happy-path.integration.spec.ts` — R19–R24 matrix test names verbatim: placed → … → `invoiced`, then stub `payment.received.v1` + `credit.released.v1` → `paid` → `completed`; exactly one `order.confirmed.v1` and one `order.completed.v1` in the outbox.
- [x] **F3.** `saga-compensation-stock-rejected.integration.spec.ts` — R26: cancelled `stock_rejected`, `compensationSteps: []`, and the release subject stub observed **zero** requests, including after redelivering `stock.rejected.v1` against `cancelled`.
- [x] **F4.** `saga-compensation-credit-rejected.integration.spec.ts` — R27, R28, SO6, SO7: release-then-cancel in causal order, one `stock_released` compensation step from the observed fact, no retry of the business-rejected `credit.hold`.
- [x] **F5.** `saga-preconditions.integration.spec.ts` — R25 + SO8 + the full saga.md §6 redelivery sweep: each consumed fact redelivered post-processing changes nothing, issues nothing, and (first-delivery-unmet and unknown-order cases) writes the `saga_ignored_facts` row with observed/expected status.
- [x] **F6.** `saga-command-retry.integration.spec.ts` — R29 retry clause + SO3/SO4/SO5: no responder ⇒ parked row with attempts + error, order status unchanged; **the crash-window composition (SO3): a `pending` row with NO in-memory hop — enqueued and committed without any `EventBus` publication, simulating a crash between commit and the hop — is still issued by a sweeper cycle**; starting the stub ⇒ next sweep resumes the saga to the next status.
- [x] **F7.** `saga-consumption.integration.spec.ts` — SO1: facts published before the group's first subscription are consumed on first boot; plus the E3 throw-⇒-redeliver verification test.

## G — Live-stack walkthrough (manual, recorded — design §8.2)

- [x] **G1.** Boot the compose stack + orders service; observe `ORD-000007/8/9`'s `order.placed.v1` consumed, three in-line retry sequences, three `parked` rows, and the structured saga-failure logs; record the observed behaviour (or the recreate-clean-slate choice) in the progress file. This is the "how to test it manually" section of the report to the human.

## H — Close-out

- [x] **H1.** Flip this feature's rows in `specs/shared/test-matrix.md`: R19–R23, R25–R28 → `DONE` with green named tests; R24 → integration half `DONE`, API half stays `TODO` (features 25/31); R29 → retry-clause row `DONE`, dead-letter row stays `TODO` (feature 27) per the amended split. Flip the SO rows in `specs/order_saga_orchestrator/requirements.md` §2.
- [x] **H2.** `pnpm quality` green (unit suites + lint + typecheck; coverage gates hold), then the full `vitest.integration.config.mts` suite green.
- [x] **H3.** Write `progress/impl_order_saga_orchestrator.md`: what was built, deviations (if any) argued against this design, the E3 finding, the G1 observation, and the manual test script. One package was installed — `@nestjs/cqrs` (CQ1) — name it in the commit message's package section.
- [x] **H4.** Set `order_saga_orchestrator` to `in_review` in `feature_list.json` and stop — the reviewer closes.
