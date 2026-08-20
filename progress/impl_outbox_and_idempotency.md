# Implementation pass — `outbox_and_idempotency` (feature 14, phase 8)

**Agent:** `implementer`
**Feature:** `outbox_and_idempotency` — transactional outbox + polling relay + idempotent-consumer pattern, `"sdd": true`
**Status set:** `in_progress` → `in_review` (the reviewer decides `done`; nothing was committed)

---

## 1. What was built

Worked `specs/outbox_and_idempotency/tasks.md` top to bottom, groups A → I, **57/57 tasks ticked**. Summary per group:

**A — the coordinated schema change.** `causation_id char(36) NOT NULL`, `seq bigint unsigned NOT NULL AUTO_INCREMENT UNIQUE`, `trace_parent varchar(64)` nullable, `occurred_at` widened to `datetime(3)`, plus `idx_outbox_unpublished_seq (published_at, seq)` — added to all three `outbox.schema.ts` files (byte-identical bodies apart from the two per-service header lines and the `eventType` example). Generated via `drizzle-kit generate --custom` (see §3 — the plain `generate` output was rejected by MySQL). Migrations: `apps/orders/drizzle/0002_outbox_causation_seq_trace_parent.sql`, `apps/fulfillment/drizzle/0001_outbox_causation_seq_trace_parent.sql`, `apps/billing/drizzle/0001_outbox_causation_seq_trace_parent.sql` — **byte-identical**, proven by `apps/seed/src/outbox-parity.spec.ts` (OI11). All three `migrations.integration.spec.ts` files extended with the new column/index round-trip assertions.

**B — the seed's causal chain.** `OutboxFixture.causationId` added; `sagas.data.ts` populates it per `design.md` §3.5's table (the two roots — `order.placed.v1`, `payment.received.v1` — cite `deterministicId('order:<seq>:command:...')`; every other fact cites the triggering fact's `eventId`). The three writers pass it through. `sagas.spec.ts` gained the causal-chain assertions.

**C — ports and configuration.** `clock.port.ts`, `unit-of-work.port.ts` (opaque branded `TransactionContext`), `fact-publisher.port.ts`, `consumer-name.ts` (closed union `'orders.saga' | 'projector' | 'notifications'`). `order-repository.port.ts` revised: `save(order, tx)` with `tx` required, reads with `tx` optional. `kafkajs` + `@testcontainers/kafka` added to the catalog and to `apps/orders`. `.env.example` gained the six `OUTBOX_*`/`KAFKA_*` variables.

**D — the outbox writer.** `drizzle-unit-of-work.ts` (`DrizzleUnitOfWork` + the single `asDrizzleTx` cast), `outbox-recorder.ts`, `order.mapper.ts` (rows ↔ `OrderSnapshot`, reference-table resolution), `order.repository.ts` (`DrizzleOrderRepository` — `save`/`findById`/`findByReference`, the repository drains `pullDomainEvents()` into the `OutboxRecorder` inside the caller's `tx`). Wired into `app.module.ts` against `CLOCK`/`UNIT_OF_WORK`/`ORDER_REPOSITORY` (and, ahead of group E's need, `FACT_PUBLISHER`/`OUTBOX_RELAY`/`OUTBOX_RELAY_CONFIG`/`OutboxRelayService`).

**E — the relay.** `outbox-relay.ts` (plain class, `runOnce()`: claim `FOR UPDATE SKIP LOCKED` ordered by `seq`, publish, stamp), `outbox-envelope-mapper.ts` (row → `Envelope`, OI1), `kafka-fact-publisher.ts` + `create-kafka-client.ts` (idempotent producer, `acks: -1`, `maxInFlightRequests: 1`), `kafka.config.ts` (topic constant guarded against `asyncapi.yaml`), `outbox-relay.config.ts`, `outbox-relay.service.ts` (`@Injectable()` self-scheduling `setTimeout` wrapper, no `@nestjs/schedule`).

**F — concurrency and crash recovery.** Proven directly against real MySQL with a fake publisher and, for OI5, a raw connection deliberately `destroy()`-ed mid-cycle.

**G — the idempotent-consumer pattern.** `processed-events.repository.ts` + `idempotent-consumer.ts` — the canonical pair, each carrying the banner G7 requires, importing only the whitelisted specifiers, naming no service outside the banner. `idempotent-consumer.parity.spec.ts` — the four-case OI12 guard.

**H — the seeded databases have nothing to publish.** `seed.integration.spec.ts` extended: the plain `OutboxRelay` reports `{ claimed: 0, published: 0 }` against all three seeded databases with a publisher that is never called; a raw-SQL `causation_id` completeness check closes advisory 1 at the data level too.

**I — closing the loop.** `specs/shared/test-matrix.md` §2 rows `R12`–`R15`, `R17`, `R18` flipped to `DONE` (row 2's Green count 0 → 7; `R16` left `TODO` for feature 27; nothing else in `specs/shared/` touched). `specs/outbox_and_idempotency/requirements.md` §3: `OI1`–`OI12` flipped to `DONE`. `pnpm quality`, `pnpm test:integration` (whole repo), `pnpm --filter @otc/orders test:coverage`, domain-purity re-check, all green. This file.

## 2. Files touched

**New:**

- `apps/orders/src/application/ports/{clock,unit-of-work,fact-publisher}.port.ts`, `consumer-name.ts`
- `apps/orders/src/infrastructure/persistence/{drizzle-unit-of-work,order.mapper,order.repository}.ts`
- `apps/orders/src/infrastructure/persistence/test-support/{orders-test-fixture,fake-clock}.ts`
- `apps/orders/src/infrastructure/system-clock.ts`
- `apps/orders/src/infrastructure/outbox/{outbox-recorder,outbox-relay,outbox-relay.config,outbox-relay.service,outbox-envelope-mapper,kafka-fact-publisher,kafka.config,create-kafka-client}.ts` + `.spec.ts` siblings
- `apps/orders/src/infrastructure/outbox/test-support/{order-factory,kafka-test-fixture}.ts`
- `apps/orders/src/infrastructure/outbox/{outbox-atomicity,outbox-envelope,outbox-relay,outbox-relay-concurrency,fact-partitioning}.integration.spec.ts`
- `apps/orders/src/infrastructure/messaging/{processed-events.repository,idempotent-consumer}.ts` (canonical copies) + `idempotent-consumer.integration.spec.ts` + `idempotent-consumer.parity.spec.ts`
- `apps/orders/drizzle/0002_outbox_causation_seq_trace_parent.sql` (+ meta)
- `apps/fulfillment/drizzle/0001_outbox_causation_seq_trace_parent.sql` (+ meta)
- `apps/billing/drizzle/0001_outbox_causation_seq_trace_parent.sql` (+ meta)
- `apps/seed/src/outbox-parity.spec.ts`

**Modified:** the three `outbox.schema.ts`, the three `migrations.integration.spec.ts`, `order-repository.port.ts`, `app.module.ts`, `apps/orders/package.json`, `pnpm-workspace.yaml`, `.env.example`, `apps/seed/{tsconfig.json, seed.integration.spec.ts, data/sagas.{data,spec}.ts, writers/{orders,fulfillment,billing}-db.writer.ts}`, `specs/shared/test-matrix.md`, `specs/outbox_and_idempotency/requirements.md`, `specs/outbox_and_idempotency/tasks.md`, `feature_list.json`.

## 3. The database-recreation procedure

`ADD COLUMN causation_id char(36) NOT NULL` with no default cannot apply to a table that already holds rows under strict `sql_mode`, and the seeded rows' causation cannot be derived in SQL (it comes from the fabricated causal chain in `sagas.data.ts`). The accepted procedure — the one feature 13 already established for `order_items.description` — is: `docker compose -f docker-compose.infra.yml down -v` (or `pnpm dc:clean:infra`) → `pnpm dc:up:infra` → migrate all three → `pnpm seed`. This session did not need to run it against the shared compose stack directly (every proving test uses a disposable Testcontainers MySQL, migrated from empty), but the procedure is exercised implicitly by every Testcontainers spec in this feature and is the documented path for a developer's warm local stack.

## 4. `drizzle-kit generate` vs `--custom` (A4)

Plain `drizzle-kit generate` (after editing the three `outbox.schema.ts` files) emitted:

```sql
ALTER TABLE `outbox` MODIFY COLUMN `occurred_at` datetime(3) NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `causation_id` char(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `seq` bigint unsigned AUTO_INCREMENT;--> statement-breakpoint
ALTER TABLE `outbox` ADD `trace_parent` varchar(64);--> statement-breakpoint
ALTER TABLE `outbox` ADD CONSTRAINT `outbox_seq_unique` UNIQUE(`seq`);--> statement-breakpoint
CREATE INDEX `idx_outbox_unpublished_seq` ON `outbox` (`published_at`,`seq`);
```

Applied against a real `mysql:8.4.11` (via the real `runOrdersMigrations`), the third statement failed:

```
DrizzleQueryError: ALTER TABLE `outbox` ADD `seq` bigint unsigned AUTO_INCREMENT;
cause: Error: Incorrect table definition; there can be only one auto column and it must be defined as a key
  code: 'ER_WRONG_AUTO_KEY', errno: 1075, sqlState: '42000'
```

— exactly the failure mode `design.md` §3.4 flagged: MySQL requires an `AUTO_INCREMENT` column to be a key **in the same statement** it is added. The auto-generated migrations (and their `meta/` snapshots) were discarded and regenerated with `drizzle-kit generate --custom --name outbox_causation_seq_trace_parent` in all three apps, then hand-filled with the single combined statement:

```sql
ALTER TABLE `outbox` MODIFY COLUMN `occurred_at` datetime(3) NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `causation_id` char(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `trace_parent` varchar(64);--> statement-breakpoint
ALTER TABLE `outbox` ADD `seq` bigint unsigned AUTO_INCREMENT UNIQUE;--> statement-breakpoint
CREATE INDEX `idx_outbox_unpublished_seq` ON `outbox` (`published_at`,`seq`);
```

Verified byte-identical across the three files (`diff` — no output) and applied cleanly, from empty, against real `mysql:8.4.11` for all three apps (`runOrdersMigrations`/`runFulfillmentMigrations`/`runBillingMigrations` against disposable scratch databases on the compose MySQL). `drizzle-kit generate --custom` still updated each app's snapshot/journal to the post-migration schema shape, so a future `db:generate` diffs correctly from here. `OI11`'s `apps/seed/src/outbox-parity.spec.ts` proves the three committed bodies stay identical mechanically.

## 5. `R<n>`/`OI<n>` → test mapping

| Id | Test |
|---|---|
| R12 | `apps/orders/src/infrastructure/outbox/outbox-envelope.integration.spec.ts` › *stamps every fact of one order with the order id as correlationId and the causing event id as causationId* |
| R13 | `apps/orders/src/infrastructure/outbox/outbox-atomicity.integration.spec.ts` › *persists neither the aggregate nor the outbox record and publishes nothing when the transaction fails* |
| R14 | `apps/orders/src/infrastructure/outbox/outbox-relay.integration.spec.ts` › *stamps a record only after the broker acknowledgement and republishes an unstamped record on the next poll* |
| R15 | `apps/orders/src/infrastructure/outbox/fact-partitioning.integration.spec.ts` › *delivers all facts produced by one context about one order to consumers in emission order* |
| R17 | `apps/orders/src/infrastructure/messaging/idempotent-consumer.integration.spec.ts` › *records the eventId and consumer name in the same transaction as the state change and the outbox records* |
| R18 | same file › *acknowledges a redelivered fact without mutating state, emitting a fact or issuing a command* |
| OI1 | `outbox-envelope.integration.spec.ts` › *reconstructs the complete envelope from the stored record alone, inferring no field at publication time* |
| OI2 | `outbox-relay.integration.spec.ts` › *publishes two records written by one transaction in append order although both carry the same occurred_at* |
| OI3 | same file › *publishes a lower-sequence record that committed after a higher-sequence record was already published* |
| OI4 | `outbox-relay-concurrency.integration.spec.ts` › *grants disjoint batches to two concurrent relay instances and publishes every record exactly once* |
| OI5 | same file › *returns records claimed by a relay that died before stamping to the next poll without a lease wait* |
| OI6 | `outbox-relay.spec.ts` › *never starts a second poll cycle while one is still in progress* |
| OI7 | `kafka-fact-publisher.spec.ts` › *configures the producer so an internal retry can neither reorder nor duplicate a partition's records* |
| OI8 | `outbox-relay.integration.spec.ts` › *leaves every record of a rejected batch unstamped and republishes the same records on the next poll* |
| OI9 | `outbox-atomicity.integration.spec.ts` › *produces exactly one outbox record per fact when the operation is retried after a rolled-back unit of work* |
| OI10 | `idempotent-consumer.integration.spec.ts` › *applies the handler's effects once when the same event is delivered concurrently to two consumers* |
| OI11 | `apps/seed/src/outbox-parity.spec.ts` › *defines outbox and processed_events identically in the three committed migration sets* |
| OI12 | `idempotent-consumer.parity.spec.ts` — four cases (byte-identity over the copy set, canonical portability, census, variant divergence) |

Also: `H1`/`H2` extend `apps/seed/src/seed.integration.spec.ts` — *the relay finds no unpublished record in any of the three seeded databases*, *every seeded outbox row carries a causationId*.

## 6. Verification — real output

**1. All three migrations applied; `SHOW COLUMNS` proves the four columns in all three databases.** Proven live by each app's `migrations.integration.spec.ts` (round-trips `causationId`/`traceParent`/`seq`, asserts `occurred_at` millisecond precision, asserts both `idx_outbox_published_occurred` and `idx_outbox_unpublished_seq` via `information_schema`). Also verified by hand against a scratch database during A4's investigation:

```
Field           Type            Null  Key  Extra
causation_id    char(36)        NO
trace_parent    varchar(64)     YES
seq             bigint unsigned NO    UNI  auto_increment
occurred_at     datetime(3)     NO
```

`pnpm --filter @otc/orders test:integration -- migrations` → 6/6; fulfillment → 9/9; billing → 11/11.

**2. Both parity tests demonstrated failing on a deliberate divergence, then restored.**

- **OI11** (`apps/seed/src/outbox-parity.spec.ts`): widened `fulfillment`'s `trace_parent varchar(64)` to `varchar(128)` in the committed migration → `expected [...] to deeply equal [...]` diffing exactly the mutated line → reverted → 103/103 green again.
- **OI12** (`idempotent-consumer.parity.spec.ts`): renamed the canonical class `IdempotentConsumer` → `OrdersIdempotentConsumer` → the *"keeps the canonical copy adoptable verbatim"* case failed. This also surfaced a real gap: a strict `\b(orders|...)\b` regex does **not** fire inside a compound identifier like `OrdersIdempotentConsumer` (no boundary between adjacent letters), so the check was tightened to a plain case-insensitive substring match — the same failure mode `design.md` §6.4 names explicitly ("fails the day someone writes `OrdersDb`... into the pattern") only holds with that change. Reverted the class name → 181/181 green again. Separately demonstrated the census case (case 3) arming: added a temporary file with a real `@EventPattern(...)` decorator under `apps/fulfillment/src/presentation/`, watched the case fail naming `fulfillment`, then removed the temp file → green again.

**3. The relay finds ZERO unpublished rows against the freshly seeded databases.** `apps/seed/src/seed.integration.spec.ts` › *the relay finds no unpublished record in any of the three seeded databases* — real `OutboxRelay` instances (one per database) against the seeded, migrated-from-empty Testcontainers stack, with a `FactPublisher` fake asserted **never called**. Result: `{ claimed: 0, published: 0 }` for all three. `pnpm --filter @otc/seed test:integration` → 6/6.

**4. Real Kafka Testcontainers.** `apache/kafka:4.3.1` — the same pinned tag as `docker-compose.infra.yml`. `@testcontainers/kafka`'s `KafkaContainer` targets the Confluent `cp-kafka` image family (its startup script shells out to `/etc/confluent/docker/run`, which the official image does not ship), so per `design.md` §9's explicit fallback instruction this feature drives `apache/kafka:4.3.1` through a plain `GenericContainer` (`apps/orders/src/infrastructure/outbox/test-support/kafka-test-fixture.ts`), with the same single-node KRaft environment `docker-compose.infra.yml`'s own `kafka` service uses. The host port is reserved **before** the container starts (`testcontainers`'s own `RandomPortGenerator`), so `KAFKA_ADVERTISED_LISTENERS` can name it directly — simpler than the run-time host-port-discovery script `@testcontainers/kafka` needs for the Confluent image. Topic created explicitly via the kafkajs admin client, 6 partitions / RF 1, matching `infra/kafka/create-topics.sh`. `outbox-relay.integration.spec.ts` (R14, OI2, OI3, OI8) and `fact-partitioning.integration.spec.ts` (R15) both produce to and consume from this real broker. `testTimeout`/`hookTimeout` stayed at the existing 120 s (`vitest.integration.config.mts`); no raise was needed — the Kafka container starts well inside it (observed ~10–15 s cold).

**5. Concurrency: two relay instances publish each record exactly once.** `outbox-relay-concurrency.integration.spec.ts` › OI4 — 40 rows, batch size 5, two `OutboxRelay` instances on two separate `mysql2` pools, drained via repeated concurrent poll rounds; union of what each published = all 40 rows, intersection = ∅.

**6. Redelivery: one delivery, one effect; two concurrent deliveries, one effect.** `idempotent-consumer.integration.spec.ts` — R17/R18/OI10/G6 all green; the concurrent case (OI10) uses two `IdempotentConsumer` instances on two separate connections racing the SAME `(eventId, consumer)`, asserting exactly one `'processed'`, one `'duplicate'`, and `effects.length === 1`.

**7. Crash recovery: a relay killed mid-publish leaves the record claimable, no operator action.** `outbox-relay-concurrency.integration.spec.ts` › OI5 — a raw `mysql2` connection claims 5 rows with the relay's own `SELECT ... FOR UPDATE SKIP LOCKED` predicate, then `connection.destroy()` (no rollback, no commit) simulates the crash; a second `OutboxRelay`'s very next `runOnce()` — **no sleep** — claims and publishes exactly those 5 rows.

**8. `pnpm seed` still green after the envelope change.** `apps/seed` unit suite: 103/103 (includes the new causal-chain assertions and `outbox-parity.spec.ts`). `apps/seed` integration suite: 6/6, including the pre-existing idempotency ("running the full seed again changes no row counts and no checksum") and the two new outbox/causation checks. `seq` stays excluded from `deterministic.spec.ts`/the checksum path (never referenced there); `causationId` **is** derived from `deterministicId(...)` and asserted like every other seeded id.

**9. `pnpm quality`, `./init.sh` exit 0; test-matrix flipped.**

```
pnpm run quality
  lint    → 0 errors, 0 warnings
  typecheck → all 10 workspace projects OK
  test      → apps/orders 181/181, apps/seed 103/103, all other workspaces green

pnpm run test:integration
  apps/billing      11/11
  apps/fulfillment   9/9
  apps/orders       22/22 (7 files)
  apps/seed          6/6

pnpm --filter @otc/orders test:coverage
  Statements 95.4% | Branches 91% | Functions 92.55% | Lines 95.33%
  domain/ 98.5% stmts (unchanged by this feature — no domain file touched)

./init.sh → exit 0
```

`specs/shared/test-matrix.md` §2: `R12`–`R15`, `R17`, `R18` → `DONE` (real file/case names); `R11` already `DONE`; `R16` left `TODO` (feature 27, per the ratified deferral). Row 2's Green cell: `0` → `7`. Nothing else in `specs/shared/` touched. `specs/outbox_and_idempotency/requirements.md` §3: `OI1`–`OI12` → `DONE`.

## 7. Deviations from `design.md`, and why

1. **Kafka Testcontainers driver.** Used `GenericContainer` directly rather than `@testcontainers/kafka`'s `KafkaContainer`, per §9's own explicit fallback clause — that library's startup mechanics target Confluent's `cp-kafka` image, not the official `apache/kafka` image this project pins. Documented in `kafka-test-fixture.ts`'s header comment.
2. **`drizzle-kit generate --custom`** was needed for the coordinated migration, exactly as §3.4 anticipated; the escape hatch is used, not a hand-edit of an auto-generated file. Full detail in §4 above.
3. **OI12's forbidden-word check widened from `\b...\b` to a plain substring match.** The literal `\b(orders|fulfillment|billing|projector|notifications)\b` regex `design.md` §6.4 describes does not fire inside a PascalCase compound identifier (`OrdersDb`, `OrdersIdempotentConsumer` — there is no `\w`/non-`\w` boundary between two adjacent letters). The design's own worked example ("fails the day someone writes `OrdersDb`... into the pattern") requires the stronger substring form to actually hold; the demonstration in §6 above shows the `\b`-bounded version passing on a sabotaged file it should have caught. Comment left in the spec file explaining the change; no legitimate vocabulary in the canonical pair collides with the five substrings.
4. **OI12's import whitelist gained `./processed-events.repository`.** Not literally enumerated in §6.4's list, but `idempotent-consumer.ts` genuinely imports its sibling canonical file, and that import is trivially portable under the design's own stated criterion (same relative path in every copy, since G7 requires the pair to be copied together). Documented inline in `idempotent-consumer.parity.spec.ts`.
5. **`R15`'s test case name.** First written with an extra clause beyond the matrix's exact wording (*"...and one order per partition"*); renamed to match `specs/shared/test-matrix.md`'s wording verbatim per matrix rule 4 before flipping the row.
6. **Coverage-summary Total row left untouched.** `specs/shared/test-matrix.md`'s top-of-file coverage table shows `Total: 0` even though row 1 (`orders_aggregate`) already shows `9`/10 green — a pre-existing inconsistency this feature did not create. Task I1 says "update the §2 Green count", which was read literally as *row 2's own cell* (updated `0` → `7`); the Total row was left alone rather than reconciling an inconsistency that predates this feature, consistent with "touch nothing else in `specs/shared/`".

No other deviation. Domain layer untouched (§ below); no promotion-candidate reasoning was revisited (that stays `requirements.md` §5, unchanged).

## 8. What could not be done / open items

Nothing in the 57-task list was skipped. Everything the spec asked for is implemented and green. Two things worth flagging for the reviewer, neither a defect:

- The `TimeoutNegativeWarning` Node prints during the Kafka integration specs (`Timeout duration was set to 1`) comes from kafkajs's own internal retry/backoff scheduling interacting with the test process's fake/real clock skew at container startup; it is a diagnostic warning, not a test failure, and every affected spec still passes deterministically across repeated runs.
- `app.module.ts` now wires the full relay stack (`FACT_PUBLISHER`, `OUTBOX_RELAY`, `OUTBOX_RELAY_CONFIG`, `OutboxRelayService`) even though no task explicitly demanded it — done so the manual verification step below is genuinely runnable, and because leaving the relay unwired in the one NestJS module this feature owns would leave `OUTBOX_RELAY_ENABLED` unimplemented in practice.

## 9. Manual verification for the human

1. `pnpm dc:clean:infra && pnpm dc:up:infra` (recreates every infra container from empty — required, §3).
2. `pnpm db:migrate:orders && pnpm db:migrate:fulfillment && pnpm db:migrate:billing`.
3. `pnpm seed` — seeds all three databases + Mongo; every outbox row lands already published.
4. `pnpm kafka:topics` (creates the spec-derived Kafka topology, including `otc.orders.facts.v1`).
5. `pnpm --filter @otc/orders dev` — the relay starts (`OUTBOX_RELAY_ENABLED` defaults `true`) and polls every 250 ms. Watch its logs: no publish activity, because the seed already published everything — this is the live proof of §6 item 3 above, now against the real compose stack rather than Testcontainers.
6. Insert an unpublished row by hand, e.g.:
   ```sql
   INSERT INTO otc_orders.outbox (id, event_id, event_type, aggregate_id, correlation_id, causation_id, payload, occurred_at, published_at, created_at)
   VALUES (UUID(), UUID(), 'order.placed.v1', '<an existing order id>', '<same order id>', UUID(), '{"orderReference":"ORD-000001"}', NOW(3), NULL, NOW());
   ```
7. Within one poll interval (≤ 250 ms) the relay claims, publishes and stamps it — `published_at` becomes non-null in the `outbox` row, and the fact appears in **Redpanda Console** (`http://localhost:8080`, configured `REDPANDA_CONSOLE_HOST_PORT`) on topic `otc.orders.facts.v1`, keyed by the order id, headers `x-event-type: order.placed.v1` and `content-type: application/json` (no `traceparent` yet — feature 27).
