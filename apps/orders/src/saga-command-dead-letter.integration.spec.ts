// R29's dead-letter clause / OR3 (`observability_reliability` design.md
// §4.2) — the `saga_commands` park hook. On a row's FIRST transition into
// `parked`: (a) the triggering fact is dead-lettered to its source
// topic's `.dlq`, and (b) exactly one `order.saga_failed.v1` is appended
// to the order's outbox — while SO5's own indefinite capped-backoff retry
// of the underlying command is untouched, and a LATER re-park of the SAME
// row (another exhausted sweep cycle) repeats NEITHER (a) nor (b).
import { Kafka, type Consumer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import { DrizzleUnitOfWork } from './infrastructure/persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from './infrastructure/persistence/order.repository';
import { DrizzleSagaCommandStore } from './infrastructure/saga/drizzle-saga-command-store';
import { NatsSagaCommandsAdapter } from './infrastructure/messaging/nats-saga-commands.adapter';
import { SagaCommandDispatcher } from './infrastructure/saga/saga-command-dispatcher';
import { SagaFirstParkDeadLetterHandler } from './infrastructure/saga/saga-first-park-dead-letter-handler';
import {
  ORDERS_FACTS_DLQ_TOPIC,
  startSagaIntegrationHarness,
  type SagaIntegrationHarness,
} from './test-support/saga-integration-harness';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-command-dead-letter: condition not met within ${timeoutMs}ms`);
}

async function commandRow(harness: SagaIntegrationHarness, orderId: string) {
  const [row] = await harness.db
    .select()
    .from(ordersSchema.sagaCommands)
    .where(and(eq(ordersSchema.sagaCommands.orderId, orderId), eq(ordersSchema.sagaCommands.command, 'stock.reserve')));
  return row;
}

async function sagaFailedOutboxRows(harness: SagaIntegrationHarness, orderId: string) {
  return harness.db
    .select()
    .from(ordersSchema.outbox)
    .where(and(eq(ordersSchema.outbox.correlationId, orderId), eq(ordersSchema.outbox.eventType, 'order.saga_failed.v1')));
}

async function collectDlqMessages(kafka: Kafka): Promise<{ consumer: Consumer; messages: Array<{ headers: Record<string, string>; eventId: string }> }> {
  const messages: Array<{ headers: Record<string, string>; eventId: string }> = [];
  const consumer = kafka.consumer({ groupId: `saga-dlq-probe-${randomUUID()}`, sessionTimeout: 30_000 });
  await consumer.connect();
  await consumer.subscribe({ topic: ORDERS_FACTS_DLQ_TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {})) {
        headers[k] = v ? v.toString('utf8') : '';
      }
      const value = JSON.parse(message.value!.toString('utf8')) as { eventId: string };
      messages.push({ headers, eventId: value.eventId });
    },
  });
  return { consumer, messages };
}

describe('saga-command-dead-letter — R29 (dead-letter clause), OR3 (Testcontainers)', () => {
  let harness: SagaIntegrationHarness;
  let rawKafka: Kafka;

  beforeAll(async () => {
    // Same tiny dispatcher budget as saga-command-retry.integration.spec.ts
    // — SO4's park-on-exhaustion resolves in well under a second.
    harness = await startSagaIntegrationHarness({
      dispatcherConfig: { timeoutMs: 300, maxAttempts: 2, backoffBaseMs: 50 },
    });
    rawKafka = new Kafka({ clientId: 'otc-orders-saga-dlq-test', brokers: [...harness.kafkaFixture.brokers] });
  }, 300_000);

  afterEach(() => {});

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('dead-letters the triggering fact and appends order.saga_failed.v1 exactly once on first park, leaving SO5\'s retry untouched, and does NOT repeat either on a second forced park of the same row', async () => {
    // Deliberately no responder — the "Fulfillment is down" case
    // (identical fixture to saga-command-retry.integration.spec.ts).
    const order = await harness.placeOrderAndRelay();

    await waitFor(async () => (await commandRow(harness, order.id.value))?.status === 'parked');
    const firstParkRow = await commandRow(harness, order.id.value);
    expect(firstParkRow).toMatchObject({ status: 'parked', attempts: 2 });
    expect(firstParkRow?.deadLetteredAt).not.toBeNull();

    const { consumer, messages: dlqMessages } = await collectDlqMessages(rawKafka);
    try {
      await waitFor(async () => dlqMessages.some((m) => m.eventId === firstParkRow?.triggeringEventId));
      const matching = dlqMessages.filter((m) => m.eventId === firstParkRow?.triggeringEventId);
      expect(matching).toHaveLength(1);
      expect(matching[0]!.headers['x-failed-consumer']).toBe('orders.saga');
      expect(matching[0]!.headers['x-original-topic']).toBe('otc.orders.facts.v1');

      await waitFor(async () => (await sagaFailedOutboxRows(harness, order.id.value)).length === 1);
      const sagaFailedRows = await sagaFailedOutboxRows(harness, order.id.value);
      expect(sagaFailedRows).toHaveLength(1);
      const payload = sagaFailedRows[0]!.payload as { command: string; attempts: number };
      expect(payload.command).toBe('stock.reserve');
      expect(payload.attempts).toBe(2);

      // SO5's retry is untouched — the order stays in `placed`, and a
      // second exhausted dispatch cycle (simulating another sweep pass
      // that finds the same still-parked row overdue) parks it again
      // WITHOUT repeating either side effect.
      expect((await harness.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, order.id.value)))[0]?.status).toBe(
        'placed',
      );

      const store = new DrizzleSagaCommandStore(harness.db, harness.clock);
      const commands = new NatsSagaCommandsAdapter(harness.testNatsConnection, 300);
      const unitOfWork = new DrizzleUnitOfWork(harness.db);
      const orders = new DrizzleOrderRepository(harness.db, harness.clock);
      const firstParkHandler = new SagaFirstParkDeadLetterHandler(harness.dlqPublisher, unitOfWork, orders, harness.clock);
      // Re-use the SAME real collaborators the harness's own app uses —
      // constructing a second dispatcher instance the way
      // saga-command-retry.integration.spec.ts's own "resume" step does,
      // never via any bus.
      const secondDispatcher = new SagaCommandDispatcher(
        commands,
        store,
        { timeoutMs: 300, maxAttempts: 2, backoffBaseMs: 50, parkRetryCapMs: 5000 },
        undefined,
        undefined,
        firstParkHandler,
      );
      const outcome = await secondDispatcher.dispatch(order.id, 'stock.reserve');
      expect(outcome).toBe('parked');

      const secondParkRow = await commandRow(harness, order.id.value);
      expect(secondParkRow?.attempts).toBe(4); // 2 (first cycle) + 2 (second cycle)

      // Give any (incorrect) second publish/append a moment to land, then
      // assert the counts are STILL exactly one each.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stillOneDlq = dlqMessages.filter((m) => m.eventId === firstParkRow?.triggeringEventId);
      expect(stillOneDlq).toHaveLength(1);
      expect(await sagaFailedOutboxRows(harness, order.id.value)).toHaveLength(1);
    } finally {
      await consumer.disconnect();
    }
  }, 60_000);
}, 300_000);
