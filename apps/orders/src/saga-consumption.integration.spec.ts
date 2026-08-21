// SO1 — facts published BEFORE the consumer group's first subscription are
// consumed on first boot (`fromBeginning: true`); plus the E3
// throw-⇒-redeliver verification (design.md §3.1): a handler rejection
// must NOT commit the Kafka offset, so the same fact is redelivered and
// eventually processed once the failure clears.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { UniqueId } from '@otc/shared-kernel';
import type { Order } from './domain/order';
import type { OrderRepository } from './application/ports/order-repository.port';
import type { TransactionContext } from './application/ports/unit-of-work.port';
import { OutboxRelay } from './infrastructure/outbox/outbox-relay';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import {
  prepareSagaFixtures,
  startSagaAppFromFixtures,
  type PreparedSagaFixtures,
  type SagaIntegrationHarness,
} from './test-support/saga-integration-harness';

// Budget (post-approval hardening, 2026-08-21): unlike the other five saga
// specs, this file has NO shared `beforeAll` — each `it` below calls
// `prepareSagaFixtures`/`startSagaAppFromFixtures` itself, so a fresh
// single-node Kafka container's "coordinator loading" cost, now paid via
// `waitForConsumerGroupReady` (up to its own 60_000ms ceiling on
// pathological failure; a few seconds normally), lands INSIDE the test
// exceed container boot plus several ~3s Kafka consumer-group joins plus
// dispatcher retry backoff, and must stay under vitest's 180s `testTimeout`
// so a true hang still fails fast. The per-`it` timeouts below were
// widened to keep readiness-wait's worst case plus the `waitFor` call
// plus fixture/setup overhead comfortably inside budget.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-consumption: condition not met within ${timeoutMs}ms`);
}

/** Wraps a real `OrderRepository`'s `findById` to throw on the first call for each `orderId` in `failOnce`, then delegate normally — a controllable, TRANSIENT failure, standing in for "the fact @CommandHandler's transactional unit threw" without touching MySQL itself. */
function failFindByIdOnce(real: OrderRepository, failOnce: Set<string>): OrderRepository {
  return {
    async findById(id: UniqueId, tx?: TransactionContext): Promise<Order | null> {
      if (failOnce.has(id.value)) {
        failOnce.delete(id.value);
        throw new Error('saga-consumption: simulated transient failure (E3 fixture)');
      }
      return real.findById(id, tx);
    },
    findByReference: (...args) => real.findByReference(...args),
    save: (...args) => real.save(...args),
  };
}

describe('saga-consumption — SO1, and the E3 throw ⇒ no-commit ⇒ redeliver verification (Testcontainers)', () => {
  let prepared: PreparedSagaFixtures | undefined;
  let harness: SagaIntegrationHarness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
    prepared = undefined;
  }, 120_000);

  it(
    'SO1 — consumes a fact published before the consumer group ever subscribed (fromBeginning: true)',
    async () => {
      prepared = await prepareSagaFixtures({ sweeperConfig: { enabled: false } });
      // Publish `order.placed.v1` BEFORE the app (and therefore the
      // `orders.saga` consumer group) has ever subscribed to this
      // disposable Kafka container's topic — the fact genuinely predates
      // the orchestrator's existence, which is exactly SO1's premise.
      const order = await prepared.placeOrderAndRelay();

      harness = await startSagaAppFromFixtures(prepared);

      await waitFor(async () => {
        const processed = await harness!.db
          .select()
          .from(ordersSchema.processedEvents)
          .where(eq(ordersSchema.processedEvents.consumer, 'orders.saga'));
        return processed.length > 0;
      });
      const commandRows = await harness.db
        .select()
        .from(ordersSchema.sagaCommands)
        .where(eq(ordersSchema.sagaCommands.orderId, order.id.value));
      expect(commandRows.some((row) => row.command === 'stock.reserve')).toBe(true);
    },
    150_000,
  );

  it(
    'E3 — a handler rejection does not commit the Kafka offset; the fact is redelivered and eventually processed once the failure clears',
    async () => {
      const failOnce = new Set<string>();
      prepared = await prepareSagaFixtures({
        sweeperConfig: { enabled: false },
        wrapOrderRepository: (real) => failFindByIdOnce(real, failOnce),
      });
      harness = await startSagaAppFromFixtures(prepared);

      const order = await prepared.placeOrder();
      failOnce.add(order.id.value);

      const relay = new OutboxRelay({
        db: prepared.mysqlFixture.db,
        publisher: prepared.ordersFactPublisher,
        clock: prepared.clock,
        config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
      });
      await relay.runOnce();

      // The FIRST delivery hits the wrapped repository's simulated
      // failure — the fact `@CommandHandler` throws, `@nestjs/microservices`
      // does not commit the offset (main.ts's E3 finding), and kafkajs
      // redelivers. Once redelivered, `failOnce` no longer contains this
      // order's id, so the SECOND attempt succeeds.
      await waitFor(async () => {
        const commandRows = await harness!.db
          .select()
          .from(ordersSchema.sagaCommands)
          .where(eq(ordersSchema.sagaCommands.orderId, order.id.value));
        return commandRows.some((row) => row.command === 'stock.reserve');
      });

      // No dedup row was left behind by the failed FIRST attempt — the
      // whole transaction (dedup insert included) rolled back, which is
      // exactly why redelivery could succeed at all rather than being
      // swallowed as a false "duplicate".
      const [outboxRow] = await harness.db
        .select()
        .from(ordersSchema.outbox)
        .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
      const processedRows = await harness.db
        .select()
        .from(ordersSchema.processedEvents)
        .where(eq(ordersSchema.processedEvents.eventId, outboxRow!.eventId));
      expect(processedRows).toHaveLength(1);
      expect(failOnce.has(order.id.value)).toBe(false);
    },
    90_000,
  );
}, 300_000);
