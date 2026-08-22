// FS16 — the relay's poll/claim/publish/stamp cycle against real MySQL
// (Testcontainers, mysql:8.4.11) AND real Kafka (Testcontainers,
// apache/kafka:4.3.1, 6-partition topic) — proves the fact of a REAL
// reserve transaction leaves Fulfillment's own outbox and lands on
// `otc.fulfillment.facts.v1`, keyed by `correlationId`, stamped
// `publishedAt` only after the broker acknowledges.
import { eq } from 'drizzle-orm';
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { Kafka, type Consumer } from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StockItem } from '../../domain/stock-item';
import type { StockItemSnapshot } from '../../domain/stock-item-snapshot';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleStockItemRepository } from '../persistence/stock-item.repository';
import * as fulfillmentSchema from '../persistence/schema/index';
import {
  startFulfillmentTestFixture,
  type FulfillmentTestFixture,
} from '../persistence/test-support/fulfillment-test-fixture';
import { createKafkaClient } from './create-kafka-client';
import { KafkaFactPublisher } from './kafka-fact-publisher';
import { FULFILLMENT_FACTS_TOPIC } from './kafka.config';
import { OutboxRelay } from './outbox-relay';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';

const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

function snapshot(overrides: Partial<StockItemSnapshot> = {}): StockItemSnapshot {
  return {
    id: UniqueId.generate(),
    companyCode: 'COM-0001',
    productCode: `PRD-${UniqueId.generate().value.slice(0, 8)}`,
    units: 20,
    reservedUnits: 0,
    lowStockThreshold: 2,
    reservations: [],
    ...overrides,
  };
}

describe('outbox-relay — FS16 (Testcontainers: mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: FulfillmentTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let realPublisher: KafkaFactPublisher;
  const consumers: Consumer[] = [];

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startFulfillmentTestFixture(), startKafkaTestFixture()]);
    await createTopic(kafkaFixture.brokers, FULFILLMENT_FACTS_TOPIC);
    realPublisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-fulfillment-test' }));
  }, 300_000);

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) {
      await consumer.disconnect();
    }
  });

  afterAll(async () => {
    await realPublisher?.disconnect();
    await mysqlFixture?.teardown();
    await kafkaFixture?.teardown();
  }, 120_000);

  async function consumeForKey(key: string, groupId: string): Promise<{ key: string; value: string }[]> {
    const kafka = new Kafka({ clientId: 'otc-fulfillment-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: FULFILLMENT_FACTS_TOPIC, fromBeginning: true });

    const received: { key: string; value: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`consumeForKey: timed out waiting for a message keyed ${key}`)), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            const messageKey = message.key?.toString() ?? '';
            if (messageKey !== key) {
              return;
            }
            received.push({ key: messageKey, value: message.value?.toString() ?? '' });
            clearTimeout(timeout);
            resolve();
          },
        })
        .catch(reject);
    });
    return received;
  }

  it('publishes the facts of a reserve transaction to otc.fulfillment.facts.v1 keyed by correlationId and stamps publishedAt only after acknowledgement', async () => {
    const repository = new DrizzleStockItemRepository(mysqlFixture.db, fixedClock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const item = StockItem.reconstitute(snapshot({ units: 10, reservedUnits: 0 }));
    const orderReference = OrderNumber.fromSequence(1);
    const correlationId = UniqueId.generate();

    await unitOfWork.execute(async (tx) => {
      const reservation = item.reserve({
        reservationId: UniqueId.generate(),
        orderReference,
        retailerCode: 'RET-0001',
        units: Quantity.of(3),
      });
      item.recordOrderFact({
        eventId: UniqueId.generate(),
        eventType: 'stock.reserved.v1',
        aggregateId: item.id,
        correlationId,
        causationId: UniqueId.generate(),
        occurredAt: fixedClock.now(),
        payload: {
          orderReference: orderReference.value,
          companyCode: item.companyCode,
          retailerCode: 'RET-0001',
          reservations: [{ reservationId: reservation.id.value, productCode: item.productCode, units: 3 }],
        },
      });
      await repository.saveAll([item], tx);
    });

    const [rowBeforePublish] = await mysqlFixture.db
      .select()
      .from(fulfillmentSchema.outbox)
      .where(eq(fulfillmentSchema.outbox.aggregateId, item.id.value));
    expect(rowBeforePublish?.publishedAt).toBeNull();
    expect(rowBeforePublish?.correlationId).toBe(correlationId.value);

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: realPublisher,
      clock: fixedClock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    const result = await relay.runOnce();
    expect(result.published).toBe(1);

    const [rowAfterPublish] = await mysqlFixture.db
      .select()
      .from(fulfillmentSchema.outbox)
      .where(eq(fulfillmentSchema.outbox.aggregateId, item.id.value));
    expect(rowAfterPublish?.publishedAt).not.toBeNull();

    const received = await consumeForKey(correlationId.value, `fs16-${UniqueId.generate().value}`);
    expect(received).toHaveLength(1);
    const envelope = JSON.parse(received[0]!.value) as { eventType: string; correlationId: string; eventId: string };
    expect(envelope.eventType).toBe('stock.reserved.v1');
    expect(envelope.correlationId).toBe(correlationId.value);
    expect(envelope.eventId).toBe(rowAfterPublish!.eventId);
  }, 60_000);
});
