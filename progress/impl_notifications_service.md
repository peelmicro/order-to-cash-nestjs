# impl_notifications_service — feature 23, phase 11

`sdd: false`. Spec source: `feature_list.json` id 23's acceptance list plus the phase-11 brief. No `R<n>` ids invented; local ids `NS1`-`NS9` used instead, defined and traced below. No row added to `specs/shared/test-matrix.md` (out of scope — shared-spec amendments are gated).

## What was built

A `NotificationSender` port with two adapters (`ConsoleNotificationSender`, `MailtrapNotificationSender`), bound by one factory in `app.module.ts`. The service consumes all seven notified facts across the three Kafka topics (`otc.orders.facts.v1`, `otc.fulfillment.facts.v1`, `otc.billing.facts.v1`), routes them through `@nestjs/cqrs` `CommandBus`, and sends one templated email per fact. Idempotent by `eventId` via an in-memory `ProcessedEventsStore` + `IdempotentConsumer` (documented divergence from the canonical MySQL `processed_events` pattern — see below). The service answers no RPC, emits no fact, has no outbox — guarded by `notifications-consumes-only.spec.ts` (NS9).

### Files touched/created (all under `apps/notifications/**`, plus the catalog)

- `src/application/ports/notification-sender.port.ts`, `consumer-name.ts`, `processed-events.port.ts`
- `src/application/notification-dispatch.service.ts` (+ `.spec.ts`)
- `src/application/commands/notify.commands.ts` (+ `.spec.ts`), `notify.command-handlers.ts` (+ `.spec.ts`)
- `src/infrastructure/messaging/kafka.config.ts` (+ `.spec.ts`), `idempotent-consumer.ts` (+ `.spec.ts`), `in-memory-processed-events.store.ts` (+ `.spec.ts`)
- `src/infrastructure/notification/console-notification-sender.ts` (+ `.spec.ts`), `mailtrap-notification-sender.ts` (+ `.spec.ts`), `mailtrap.config.ts` (+ `.spec.ts`)
- `src/infrastructure/templates/notification-format.ts` (+ `.spec.ts`) and seven `<fact>.template.ts` (+ `.spec.ts` each)
- `src/presentation/notification-facts.controller.ts` (+ `.spec.ts`)
- `src/notifications-consumes-only.spec.ts` (NS9 guard)
- `src/notification-consumption.integration.spec.ts` (Testcontainers, real Kafka)
- `src/test-support/kafka-test-fixture.ts` (copied from `apps/fulfillment`'s own copy, extended with `waitForTopicReady`/`publishFact`), `src/test-support/envelope-fixtures.ts`
- `src/app.module.ts`, `src/main.ts` rewritten (Kafka microservice transport, no NATS, no MySQL)
- `apps/notifications/package.json`, `apps/notifications/vitest.config.mts` (excludes `*.integration.spec.ts`), `apps/notifications/vitest.integration.config.mts` (new)
- `pnpm-workspace.yaml` — catalog entries `nodemailer: ^9.0.5`, `"@types/nodemailer": ^8.0.1`

## Binding rule (Mailtrap vs console)

`infrastructure/notification/mailtrap.config.ts`'s `resolveNotificationSenderBinding`:
- Both `MAILTRAP_USER`/`MAILTRAP_PASSWORD` absent or the `.env.example` placeholder `replace_me` → **console** (the expected default/test state, not a misconfiguration).
- Both present and neither the placeholder → **Mailtrap**, after validating `MAILTRAP_HOST`, `MAILTRAP_FROM_EMAIL` and `MAILTRAP_PORT` (positive integer) are also set.
- **Partial** pair (one real, one absent/placeholder) → throws synchronously, fails Nest's module compilation. Same precedent as `CREDIT_FAILURE_RATE` (feature 20): a silently-defaulted value would make a demo irreproducible for reasons invisible in the logs.
- Never logs, echoes or returns credentials anywhere but the returned config object passed straight to `MailtrapNotificationSender`.

## Idempotency — divergence from the canonical `processed_events` pattern, and why

`docker-compose.infra.yml` / `.env.example` provision exactly three per-service MySQL databases (`otc_orders`, `otc_fulfillment`, `otc_billing` — grep `MYSQL_DB_`). Adding a fourth for notifications would have meant editing `docker-compose.infra.yml` / `infra/mysql/init/*` / `.env.example`, all outside this feature's bounded scope (`apps/notifications/**` + the catalog only). So dedup is an **in-memory** `ProcessedEventsStore` (`InMemoryProcessedEventsStore`), and `IdempotentConsumer.runOnce` is **check-then-work-then-mark**, not insert-first-inside-one-transaction: marking BEFORE `work` would permanently swallow a genuinely failed send (an SMTP error) on the next redelivery, which is worse for a best-effort notification than the alternative. Documented in both files' headers, with the known limitation stated plainly: the ledger resets on process restart, and two truly concurrent deliveries of the same `eventId` (multiple instances, no row lock) could both send — acceptable for this single-instance demo service.

This divergence is exactly what `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts` (OI12) was built to require: a variant's banner must cite the canonical path (`apps/orders/src/infrastructure/messaging/idempotent-consumer.ts`) and carry a `Divergence:` line. `apps/notifications/src/infrastructure/messaging/idempotent-consumer.ts`'s banner does both — verified by re-running `apps/orders`' own suite (see below), since I cannot edit that file myself (out of scope) but its guard reads mine.

## R-trace (local ids)

| id | Claim | Test |
|---|---|---|
| NS1 | `order.placed.v1` template: subject carries correlation id, plain text + HTML | `order-placed.template.spec.ts`; fact-emission guard in `notify.command-handlers.spec.ts` |
| NS2 | `order.confirmed.v1` template | `order-confirmed.template.spec.ts`; guard in `notify.command-handlers.spec.ts` |
| NS3 | `order.despatched.v1` template | `order-despatched.template.spec.ts`; guard in `notify.command-handlers.spec.ts` |
| NS4 | `invoice.issued.v1` template | `invoice-issued.template.spec.ts`; guard in `notify.command-handlers.spec.ts` |
| NS5 | `payment.received.v1` template (recipient synthesized from `orderReference` — payload carries no `retailerCode`) | `payment-received.template.spec.ts`; guard in `notify.command-handlers.spec.ts` |
| NS6 | `order.completed.v1` template | `order-completed.template.spec.ts`; guard in `notify.command-handlers.spec.ts` |
| NS7 | `order.cancelled.v1` template | `order-cancelled.template.spec.ts`; guard in `notify.command-handlers.spec.ts` |
| NS8 | idempotent by eventId | `idempotent-consumer.spec.ts`, `notification-dispatch.service.spec.ts`, and at the real-Kafka level in `notification-consumption.integration.spec.ts` |
| NS9 | this service only consumes (no RPC, no fact emitted, no outbox) | `notifications-consumes-only.spec.ts` |

## Armed-deletion records (per CLAUDE.md's fact-emission-guard rule)

### 1. Idempotency dedup check — `IdempotentConsumer.runOnce`

Deleted the `if (await this.processedEvents.hasProcessed(...)) { return 'duplicate'; }` guard, ran `idempotent-consumer.spec.ts` + `notification-dispatch.service.spec.ts`. Verbatim failure:

```
FAIL  src/infrastructure/messaging/idempotent-consumer.spec.ts > IdempotentConsumer — NS8 > does NOT run work again for a redelivered eventId — returns "duplicate"
AssertionError: expected 'processed' to be 'duplicate' // Object.is equality

Expected: "duplicate"
Received: "processed"

 ❯ src/infrastructure/messaging/idempotent-consumer.spec.ts:40:21
     38|     const outcome = await consumer.runOnce('event-1', 'notifications',…
     39|
     40|     expect(outcome).toBe('duplicate');
       |                     ^
     41|     expect(work).not.toHaveBeenCalled();
     42|   });

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 5 passed (6)
```

Restored via `cp` from a pre-deletion backup; `diff` confirmed byte-identical restoration; full suite re-verified green afterward.

### 2. Fact-emission guards — three of the seven `@CommandHandler`s

Deleted `await this.dispatcher.dispatch(command.envelope, buildXMessage)` (replaced with `void command;`) in `NotifyOrderPlacedHandler`, `NotifyPaymentReceivedHandler`, `NotifyOrderCancelledHandler`. Ran `notify.command-handlers.spec.ts`. Verbatim failures:

```
FAIL  src/application/commands/notify.command-handlers.spec.ts > notify.command-handlers — NS1..NS7 > NS1 — NotifyOrderPlacedHandler dispatches order.placed.v1 with buildOrderPlacedMessage
AssertionError: expected "vi.fn()" to be called with arguments: [ { eventId: 'event-1', …(6) }, …(1) ]
Number of calls: 0
 ❯ src/application/commands/notify.command-handlers.spec.ts:58:22

FAIL  src/application/commands/notify.command-handlers.spec.ts > notify.command-handlers — NS1..NS7 > NS5 — NotifyPaymentReceivedHandler dispatches payment.received.v1 with buildPaymentReceivedMessage
AssertionError: expected "vi.fn()" to be called with arguments: [ { eventId: 'event-1', …(6) }, …(1) ]
Number of calls: 0
 ❯ src/application/commands/notify.command-handlers.spec.ts:94:22

FAIL  src/application/commands/notify.command-handlers.spec.ts > notify.command-handlers — NS1..NS7 > NS7 — NotifyOrderCancelledHandler dispatches order.cancelled.v1 with buildOrderCancelledMessage
AssertionError: expected "vi.fn()" to be called with arguments: [ { eventId: 'event-1', …(6) }, …(1) ]
Number of calls: 0
 ❯ src/application/commands/notify.command-handlers.spec.ts:112:22

 Test Files  1 failed (1)
      Tests  3 failed | 4 passed (7)
```

Restored via `cp` from a pre-deletion backup; `diff` confirmed byte-identical restoration; full suite re-verified green afterward.

## Kafka wiring finding (worth recording — a real-Kafka-only race)

`notification-consumption.integration.spec.ts` initially failed with `KafkaJSProtocolError: This server does not host this topic-partition` on every run. Root cause, traced into kafkajs 2.2.4's `BrokerPool.refreshMetadata`: on any error type OTHER than `LEADER_NOT_AVAILABLE`, it calls `bail(e)` and aborts the retrier immediately — `UNKNOWN_TOPIC_OR_PARTITION` (our case) is NOT retried internally regardless of the `retry` config passed to the client. Two contributing causes, both fixed in `test-support/kafka-test-fixture.ts` and the integration spec: (1) a fresh single-node KRaft broker's own partition-directory initialisation can lag behind `admin.createTopics({ waitForLeaders: true })` — fixed by a new `waitForTopicReady` helper that polls `admin.fetchTopicMetadata` before the caller proceeds; (2) `NotificationFactsController` subscribes to all three fact topics at once (one `consumer.subscribe` call for all registered `@EventPattern`s), so the integration spec must create **all three** topics before connecting the app, not just the one topic the test happens to publish to — the original version only created `ORDERS_FACTS_TOPIC`. Both fixes are in `apps/notifications/**` only.

## Live verification

- Started `apps/notifications` against real infra with the real `.env` (`pnpm --filter @otc/notifications run start`, i.e. `dotenv -e ../../.env -- node dist/main.js`). Log confirmed: Kafka consumer group `notifications-server` joined, subscribed to all three real topics (`otc.orders.facts.v1`, `otc.fulfillment.facts.v1`, `otc.billing.facts.v1`), HTTP health on port 3005.
- **[CORRECTED IN RE-REVIEW — see the "Re-review" section below]** First attempt: published a synthetic `order.placed.v1` fact to `otc.orders.facts.v1` via a throwaway kafkajs producer script. Because `fromBeginning: true` re-consumed the FULL historical backlog left on these topics by prior features/demos, the service attempted many real sends in a burst and hit Mailtrap sandbox's rate limit (`550 5.7.0 Too many emails per second`). This was **the defect firing against a real broker with real credentials (N1/N3), not a confirmation of anything correct** — the reviewer is right and my original characterization below was wrong; leaving the wrong sentence struck through rather than deleted, per the correction instruction: ~~a genuine, useful confirmation that a failed send is retried on redelivery rather than silently swallowed (the NS8 divergence design behaving as documented), but not a clean single-send proof~~. Stopped the service (`pkill -f dist/main.js`) to end the storm.
- Second attempt, controlled: a standalone script imported the real `resolveNotificationSenderBinding`, `MailtrapNotificationSender` and `buildOrderPlacedMessage` from the built `dist/`, confirmed the binding resolved to `'mailtrap'` (real credentials from `.env`), built one message and called `sender.send(message)` directly — no Kafka involved, one deterministic send.
  - **Subject**: `[order-to-cash] Order ORD-LIVE-SINGLE-0001 placed (correlationId: live-order-single-1)`
  - **To**: `retailer01@retailer.order-to-cash.example`
  - **Result**: `nodemailer`'s `sendMail` resolved without throwing — Mailtrap's SMTP server accepted the `DATA` command for this message (no `550`/`EENVELOPE` error, unlike the rate-limited burst). This is the SMTP-level proof available to me; I have no Mailtrap API token (only SMTP credentials) and no browser tool, so I could not myself open the sandbox inbox UI to screenshot the arrival — the human should confirm visually. Credentials were never read, echoed or logged at any point; only presence/absence was checked via `grep -c`.
  - Temporary verification scripts and logs (`send-one-live-email.tmp.mjs`, `publish-fact.tmp.mjs`, `/tmp/notifications-live.log`) were deleted afterward; `git status` on `apps/notifications` shows no stray files.

## `pnpm quality`

Green, exit 0, full monorepo: orders 392/392, billing 130/130, fulfillment 75/75, notifications 68/68, seed 119/119, contracts 22/22, shared-kernel 68/68, gateway 1/1, projector 1/1 — all passed, lint clean, typecheck clean across every workspace.

`apps/notifications`'s own `test:integration` (Testcontainers, real Kafka) passed twice in a row (stability check), ~15-17s each.

## Nodemailer versions

- `nodemailer: ^9.0.5` (runtime dependency, `apps/notifications/package.json` + catalog)
- `@types/nodemailer: ^8.0.1` (dev dependency, types-only; DefinitelyTyped versions `@types/nodemailer` independently of `nodemailer` itself — same non-1:1 numbering convention as `@types/node` vs `node`)

## What I could not do / deviated from the literal brief, and why

- **No MySQL-backed `processed_events` table for notifications** — infra provisions only three per-service databases and adding a fourth was outside `apps/notifications/**` + catalog bounded scope. Used an in-memory store instead, with the divergence formally documented and recognized by `apps/orders`' own OI12 parity guard (which I could read but not edit).
- **Did not visually confirm the Mailtrap sandbox inbox UI** — no browser tool available in this session, and only SMTP credentials (not an API token) were provided. The evidence I can offer is the SMTP-level acceptance (`sendMail` resolved, no `550`/bounce) for a specific, reported subject line; the human should check the inbox for final visual confirmation.
- **Did not add `NOTIFICATIONS_KAFKA_CLIENT_ID`/`NOTIFICATIONS_CONSUMER_GROUP` to `.env.example`** — `kafka.config.ts`'s `loadKafkaConfig` reads them with safe defaults (`otc-notifications` / `notifications`) if unset; adding documentation lines to `.env.example` was not required by the brief (only the already-present `MAILTRAP_*` lines were named) and `.env.example` is outside the bounded scope.

---

## Re-review (findings N1, N2, N3, N4, N6, N7, N8, N9, N10 — `progress/review_notifications_service.md`)

The leader granted a scope widening beyond `apps/notifications/**`: a fourth MySQL database, `otc_notifications`, on the existing `otc-mysql` container (option (a) from the review's Probe 4, chosen over MongoDB to avoid blurring R54's "projector is the only writer of the read model" boundary before feature 24). Everything below is what changed to close N1/N2/N3/N4/N6/N7/N8/N9/N10. N5 and N11 are the leader's/reviewer's own, untouched by this pass.

### N1/N2 — durable idempotency, the canonical pattern adopted byte-identically

`infrastructure/messaging/idempotent-consumer.ts` and `infrastructure/messaging/processed-events.repository.ts` are now **byte-identical copies of `apps/fulfillment`'s own copies** (which are themselves byte-identical to the Orders canonical) — same class, same banner, same everything, copied with `cp`, never retyped. Confirmed:

```
$ diff apps/fulfillment/src/infrastructure/messaging/idempotent-consumer.ts apps/notifications/src/infrastructure/messaging/idempotent-consumer.ts && echo "IDEMPOTENT-CONSUMER: BYTE-IDENTICAL"
IDEMPOTENT-CONSUMER: BYTE-IDENTICAL
$ diff apps/fulfillment/src/infrastructure/messaging/processed-events.repository.ts apps/notifications/src/infrastructure/messaging/processed-events.repository.ts && echo "PROCESSED-EVENTS-REPOSITORY: BYTE-IDENTICAL"
PROCESSED-EVENTS-REPOSITORY: BYTE-IDENTICAL
$ md5sum apps/fulfillment/.../idempotent-consumer.ts apps/notifications/.../idempotent-consumer.ts
9a90fcd0beac5e510214ccbc573d8dd7  apps/fulfillment/src/infrastructure/messaging/idempotent-consumer.ts
9a90fcd0beac5e510214ccbc573d8dd7  apps/notifications/src/infrastructure/messaging/idempotent-consumer.ts
$ md5sum apps/fulfillment/.../processed-events.repository.ts apps/notifications/.../processed-events.repository.ts
09b5c9c205880a78ad6af7679d6f1504  apps/fulfillment/src/infrastructure/messaging/processed-events.repository.ts
09b5c9c205880a78ad6af7679d6f1504  apps/notifications/src/infrastructure/messaging/processed-events.repository.ts
```

`in-memory-processed-events.store.ts`, its spec, and `application/ports/processed-events.port.ts` are **deleted** — `git status` on `apps/notifications` after this pass shows no trace of them.

New supporting infrastructure (all notifications-specific, none of it part of the compared canonical pair): `application/ports/unit-of-work.port.ts`, `application/ports/clock.port.ts` (same shape as Fulfillment's own, at the same relative paths OI12's `PORTABLE_IMPORT_WHITELIST` expects), `infrastructure/persistence/{client,db-config,drizzle-unit-of-work,migrator,migrate-cli}.ts`, `infrastructure/persistence/schema/{processed-events.schema,index}.ts` (identical DDL shape to the other three services' own `processed-events.schema.ts`), `infrastructure/system-clock.ts`, `infrastructure/persistence/test-support/notifications-test-fixture.ts` (Testcontainers MySQL, same shape as Fulfillment's), `drizzle.config.ts`.

**Migration**: `apps/notifications/drizzle/0000_sharp_rattler.sql` — one table, `processed_events`, generated by `drizzle-kit generate` against the live `otc_notifications` database and diffed byte-for-byte identical (the `CREATE TABLE` statement) against `apps/fulfillment/drizzle/0000_nappy_mad_thinker.sql`'s own `processed_events` table. Applied to the live compose MySQL via `pnpm --filter @otc/notifications db:migrate` (confirmed via `DESCRIBE processed_events` against the running `otc-mysql` container).

**Infra changes** (leader-granted, outside `apps/notifications/**`): `docker-compose.infra.yml` (`MYSQL_DB_NOTIFICATIONS` env var on the `mysql` service, header comment "four" → "five" logical databases), `infra/mysql/init/01-create-databases.sh` (creates + grants `otc_notifications`, for a FUTURE fresh volume — the already-initialized live container's data volume does not re-run init scripts, so the database was also created directly against the running container: `docker exec otc-mysql ... CREATE DATABASE ... GRANT ...`), `.env.example` (`MYSQL_DB_NOTIFICATIONS=otc_notifications`, `NOTIFICATIONS_DB_HOST=localhost` in the MySQL section — also N10, see below), `.env` (the same two config keys added with real local values; `MAILTRAP_*` values were never read, echoed or touched).

**OI12 re-verified** (read-only against `apps/orders`, never edited): `apps/orders`'s own `idempotent-consumer.parity.spec.ts` now passes with notifications on its REAL byte-identity branch (case 1 — `hasMySqlProcessedEventsSchema('notifications')` is now `true`, since `infrastructure/persistence/schema/processed-events.schema.ts` exists), not the text-only variant branch the review's Probe 2 showed was vacuous:

```
$ cd apps/orders && pnpm vitest run src/infrastructure/messaging/idempotent-consumer.parity.spec.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

### N6 — insert-first, then send, then delete the row if the send throws

Not a reproduction of check-then-work-then-mark, and not a disguised use of the canonical's own transaction wrapping either. `NotificationDispatchService.dispatch` (`application/notification-dispatch.service.ts`) calls the byte-identical `IdempotentConsumer.runOnce` with a **no-op `work`** — so the canonical pattern's INSERT commits on its own, genuinely insert-first, exactly per its unmodified semantics. Only AFTER that transaction commits does `dispatch` call `sender.send(...)`, deliberately OUTSIDE any MySQL transaction — an SMTP round-trip should not hold a transaction (and the unique-index row lock) open for its unpredictable duration. If `sender.send` throws, a new file, `infrastructure/messaging/processed-events-compensation.ts` (`DrizzleProcessedEventCompensation`, sharing the SAME `UnitOfWork`/connection pool as the insert), deletes the just-committed row before `dispatch` rethrows — converting "duplicate an email" into "possibly lose one at redelivery", per the review's own stated direction. This is a genuine, stated divergence from the canonical's "record + effect, one transaction" ordering (which this service cannot reproduce for a non-database effect) — the reasoning is in both `notification-dispatch.service.ts`'s header and `processed-events-compensation.ts`'s header, not only here. `notification-dispatch.service.spec.ts` gained two new cases proving both directions (delete-on-throw, no-delete-on-success) with fakes, and `notification-consumption.integration.spec.ts` proves it end to end against real MySQL (the row count assertions in the N7 test below).

### N3 — `fromBeginning` reconsidered, changed to `false`

`main.ts` now sets `subscribe: { fromBeginning: false }`, the opposite of Orders' saga consumer's `true`. Reasoning recorded in `main.ts`'s own comment: Orders' saga orchestrator MUST replay history on a fresh consumer group because it owns the order state machine and a pre-existing order still has to reach a terminal state. Notifications owns no aggregate and no state machine (domain-model.md §6) — a fact this service has never seen is simply a fact that gets no notification, which is the correct default for a "tell a human about something new" service. The durable ledger (N1/N2) prevents a duplicate send for a fact already processed, but it cannot prevent a FIRST send for a fact this consumer group has genuinely never encountered before; `fromBeginning: false` is what keeps "never seen" meaning "genuinely new" rather than "predates this consumer group". The integration spec's own `connectMicroservice` calls keep `fromBeginning: true` for a different, local reason (publishing happens only after consumer-group readiness is confirmed, on brand-new topics with no prior messages, so the value is unobservable there) — documented inline as intentionally independent of `main.ts`'s production choice.

### N4 — all seven facts sent live; inbox-level verification explicitly NOT possible

Checked for a Mailtrap API token first, per the instruction: `grep -i mailtrap .env` and `env | grep -i mailtrap` show only `MAILTRAP_HOST`/`MAILTRAP_PORT`/`MAILTRAP_USER`/`MAILTRAP_PASSWORD`/`MAILTRAP_FROM_EMAIL` — **no API token is reachable from this environment**, in `.env`, in the shell, or anywhere else searched. Per the instruction, this is stated explicitly and the criterion is left **visibly unmet** rather than declared satisfied.

All seven facts were still sent live (best available evidence), via a throwaway script (`send-seven-live-emails.tmp.mjs`, deleted afterward) that imports the real `resolveNotificationSenderBinding`/`MailtrapNotificationSender`/all seven `build*Message` functions from the built `dist/`, confirms the binding resolves to `'mailtrap'` against the real `.env`, and calls `sender.send` directly (no Kafka involved) with `messageId` set exactly as `NotificationDispatchService` would (`<eventId>@order-to-cash`, N4's own recommendation (d)), spaced 8s apart with retry-on-`550` backoff (the sandbox's rate limit, hit twice more during this run, backed off and retried successfully both times — never re-triggering N3's storm, since this is one script sending seven emails once, not a service replaying a topic). All seven resolved without throwing:

| Fact | eventId | messageId | Subject |
|---|---|---|---|
| order.placed.v1 | `live-1787570041348-1` | `live-1787570041348-1@order-to-cash` | `[order-to-cash] Order ORD-LIVE-1787570041348 placed (correlationId: live-order-1787570041348)` |
| order.confirmed.v1 | `live-1787570041348-2` | `live-1787570041348-2@order-to-cash` | `[order-to-cash] Order ORD-LIVE-1787570041348 confirmed (correlationId: live-order-1787570041348)` |
| order.despatched.v1 | `live-1787570041348-3` | `live-1787570041348-3@order-to-cash` | `[order-to-cash] Order ORD-LIVE-1787570041348 despatched (DES-LIVE-1787570041348) (correlationId: live-order-1787570041348)` |
| invoice.issued.v1 | `live-1787570041348-4` | `live-1787570041348-4@order-to-cash` | `[order-to-cash] Invoice INV-LIVE-1787570041348 issued (correlationId: live-order-1787570041348)` |
| payment.received.v1 | `live-1787570041348-5` | `live-1787570041348-5@order-to-cash` | `[order-to-cash] Payment received for invoice INV-LIVE-1787570041348 (correlationId: live-order-1787570041348)` |
| order.completed.v1 | `live-1787570041348-6` | `live-1787570041348-6@order-to-cash` | `[order-to-cash] Order ORD-LIVE-1787570041348 completed (correlationId: live-order-1787570041348)` |
| order.cancelled.v1 | `live-1787570041348-7` | `live-1787570041348-7@order-to-cash` | `[order-to-cash] Order ORD-LIVE-1787570041348 cancelled (correlationId: live-order-1787570041348)` |

This is SMTP-acceptance evidence only ("`DATA` accepted, no `550`/bounce for any of the seven"), exactly the level the review said is insufficient on its own. **Acceptance criterion 1 ("real email verified in the Mailtrap inbox for each notified fact") remains UNVERIFIED by me** — no API token, no browser tool. The human needs to open the sandbox inbox and confirm the seven messages above (searchable by subject or by the `messageId` header) actually arrived, to close this criterion.

### N7 — cross-restart integration test (armed)

`notification-consumption.integration.spec.ts` was restructured: a shared Testcontainers MySQL fixture (`beforeAll`/`afterAll`, `startNotificationsTestFixture`) plus a shared Kafka fixture per test (as before), with the REAL `db-config.ts` loader pointed at the disposable MySQL via `process.env` (no provider overrides needed — the same env-var-driven pattern every DB config in this codebase already uses). Two describe blocks: the original single-app redelivery test (updated to assert `messageId` too), and a new `cross-restart (N7)` block — `app1` processes a fact and sends once; `app1.close()`; the SAME `eventId` is republished (a real duplicate, new Kafka offset); a FRESH `Test.createTestingModule` compilation (`app2`, same Kafka consumer group, same MySQL) starts; asserts `sender2.callCount === 0`, `sender1.callCount` unchanged at `1`, and the `processed_events` table holds exactly one row for that `eventId` both before and after `app2` runs. This is the reviewer's own Probe 1 template, now proving the opposite result.

### N8 — gone with the in-memory store

`in-memory-processed-events.store.ts` and its spec are deleted (see N1/N2).

### N9 — HTML escaping

`infrastructure/templates/notification-format.ts` gained `escapeHtml` (a plain `/[&<>"']/g` replace). Every payload-derived string interpolated into any of the seven templates' `html` string now goes through it (the plain `text` bodies are untouched — no markup to inject into). New tests: `notification-format.spec.ts` (escaping itself, both an XSS-shaped and an ordinary-reference case) and `payment-received.template.spec.ts` (the field the review specifically named — `paymentReference` is externally supplied on the remittance path — with a malicious value that must NOT appear unescaped in `html` but DOES appear verbatim in `text`).

### N10 — `.env.example` documents the consumer-group knob, with a warning

`NOTIFICATIONS_KAFKA_CLIENT_ID`/`NOTIFICATIONS_CONSUMER_GROUP` are now in `.env.example`'s Kafka section, next to `BILLING_KAFKA_CLIENT_ID`, with an explicit warning that changing `NOTIFICATIONS_CONSUMER_GROUP` creates a brand-new consumer group and referencing the N3 incident this file's corrected account above describes.

### Armed-deletion record — the durable dedup check (N1's own guard)

Deleted the `if (result === 'duplicate') { throw new DuplicateEventSignal(); }` branch from the (byte-identical) `idempotent-consumer.ts`, ran the full integration suite (`pnpm --filter @otc/notifications test:integration`, real Kafka + real MySQL). Both tests failed, exactly as the deletion should cause:

```
FAIL  src/notification-consumption.integration.spec.ts > notification-consumption (Testcontainers, real Kafka AND real MySQL) > single running app > consumes a real order.placed.v1 fact exactly once, and a real redelivery of the same eventId sends no second time
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 2

 ❯ src/notification-consumption.integration.spec.ts:202:34
    200|         // consumed and processed if the dedup guard failed to catch i…
    201|         await new Promise((resolve) => setTimeout(resolve, 5_000));
    202|         expect(sender.callCount).toBe(1);
       |                                  ^

FAIL  src/notification-consumption.integration.spec.ts > notification-consumption (Testcontainers, real Kafka AND real MySQL) > cross-restart (N7) > N7 — a fact processed by app1, then redelivered after app1 is closed, is NOT re-sent by a freshly-compiled app2 sharing the same durable MySQL ledger
AssertionError: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ src/notification-consumption.integration.spec.ts:304:35
    302|         await new Promise((resolve) => setTimeout(resolve, 5_000));
    303|
    304|         expect(sender2.callCount).toBe(0);
       |                                   ^

 Test Files  1 failed (1)
      Tests  2 failed (2)
```

Restored via `cp` from a pre-deletion backup (`/tmp/idempotent-consumer.ts.bak2`); `diff` against both the backup AND `apps/fulfillment`'s canonical confirmed byte-identical restoration; the same integration suite re-run green twice afterward (see below). One armed deletion, two independent verbatim failures — both required scenarios (single-process redelivery, cross-restart) are proven non-vacuous by the same probe.

### Suites, green

`pnpm quality` (root): exit 0. orders 392/392, billing 130/130, fulfillment 75/75, notifications 70/70 (was 68 — +2 net: N6's two new dispatch-service cases and N4's messageId case, minus the deleted in-memory-store spec and old check-then-mark test, plus the N9 escaping cases and the N9 template regression case), seed 119/119, contracts 22/22, shared-kernel 68/68, gateway 1/1, projector 1/1. Lint clean (`pnpm eslint apps/notifications`, exit 0, no output). Typecheck clean.

`apps/notifications`'s `test:integration` (real Kafka + real MySQL, Testcontainers): 2/2 passed, run twice for stability (~52-56s each). `apps/orders`'s `idempotent-consumer.parity.spec.ts` (OI12, read-only): 4/4 passed, notifications now on the byte-identity branch.

### Files changed or added in this pass

New: `apps/notifications/src/application/ports/unit-of-work.port.ts`, `clock.port.ts`; `apps/notifications/src/infrastructure/persistence/{client,db-config,drizzle-unit-of-work,migrator,migrate-cli}.ts`; `apps/notifications/src/infrastructure/persistence/schema/{processed-events.schema,index}.ts`; `apps/notifications/src/infrastructure/persistence/test-support/notifications-test-fixture.ts`; `apps/notifications/src/infrastructure/system-clock.ts`; `apps/notifications/src/infrastructure/messaging/processed-events-compensation.ts`; `apps/notifications/drizzle.config.ts`; `apps/notifications/drizzle/0000_sharp_rattler.sql` (+ `drizzle/meta/*`).

Replaced: `apps/notifications/src/infrastructure/messaging/idempotent-consumer.ts`, `processed-events.repository.ts` (now byte-identical copies).

Rewritten: `apps/notifications/src/application/notification-dispatch.service.ts` (+ spec), `apps/notifications/src/app.module.ts`, `apps/notifications/src/main.ts`, `apps/notifications/src/notification-consumption.integration.spec.ts`, `apps/notifications/vitest.integration.config.mts`, `apps/notifications/package.json`, `apps/notifications/src/application/ports/notification-sender.port.ts`, `apps/notifications/src/infrastructure/notification/mailtrap-notification-sender.ts` (+ spec), `apps/notifications/src/infrastructure/templates/notification-format.ts` (+ spec) and all seven `*.template.ts` files (`order-placed`, `order-confirmed`, `order-despatched`, `invoice-issued`, `payment-received` [+ N9 regression test], `order-completed`, `order-cancelled`).

Deleted: `apps/notifications/src/application/ports/processed-events.port.ts`, `apps/notifications/src/infrastructure/messaging/in-memory-processed-events.store.ts` (+ spec), `apps/notifications/src/infrastructure/messaging/idempotent-consumer.spec.ts` (obsolete — tested the now-removed check-then-work-then-mark ordering; the durable class's behaviour is now proven at the integration level instead, per N7).

Infra (leader-granted, outside `apps/notifications/**`): `docker-compose.infra.yml`, `infra/mysql/init/01-create-databases.sh`, `.env.example`, `.env` (config keys only).

### What remains unmet

- **Acceptance criterion 1** — inbox-level verification of the seven live sends. No Mailtrap API token reachable from this environment; the human needs to check the sandbox inbox directly (subjects and `messageId`s listed above).
