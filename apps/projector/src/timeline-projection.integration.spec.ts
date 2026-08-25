// R50 › appends an entry carrying eventId, eventType, occurredAt and a
// summary and presents the timeline ordered by occurredAt rather than by
// arrival. R51 › leaves the read-model document unchanged when a fact with
// an already-present eventId is redelivered. PR10; PR14 integration half.
// Real Kafka + real MongoDB (Testcontainers), the full AppModule pipeline.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import {
  createTopic,
  publishFact,
  startKafkaTestFixture,
  type KafkaTestFixture,
} from './test-support/kafka-test-fixture';
import { bootProjectorTestApp, type ProjectorTestApp } from './test-support/projector-app-test-harness';
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, ORDERS_FACTS_TOPIC } from './infrastructure/messaging/kafka.config';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeline-projection: condition not met within ${timeoutMs}ms`);
}

describe('timeline-projection — R50/R51 (Testcontainers, real Kafka + real MongoDB)', () => {
  let mongo: StandaloneMongoTestFixture;
  let kafka: KafkaTestFixture;

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    kafka = await startKafkaTestFixture();
    await createTopic(kafka.brokers, ORDERS_FACTS_TOPIC);
    await createTopic(kafka.brokers, FULFILLMENT_FACTS_TOPIC);
    await createTopic(kafka.brokers, BILLING_FACTS_TOPIC);
  }, 180_000);

  afterAll(async () => {
    await kafka?.teardown();
    await mongo?.teardown();
  }, 60_000);

  let harness: ProjectorTestApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  }, 30_000);

  it(
    'R50 — appends an entry carrying eventId, eventType, occurredAt and a summary, and presents the timeline ordered by occurredAt rather than by arrival',
    async () => {
      harness = await bootProjectorTestApp(mongo, kafka, `timeline-projection-r50-${randomUUID().slice(0, 8)}`);
      const orderId = randomUUID();
      const laterEventId = randomUUID();
      const earlierEventId = randomUUID();

      // Published OUT OF occurredAt order — the later fact FIRST, on the
      // wire — to prove the stored order is by occurredAt, not arrival.
      const later = {
        eventId: laterEventId,
        eventType: 'stock.reserved.v1',
        aggregateId: orderId,
        correlationId: orderId,
        causationId: 'cause-1',
        occurredAt: '2026-08-24T10:05:00.000Z',
        payload: { orderReference: 'ORD-000001', companyCode: 'COMPANY01', reservations: [{ reservationId: 'res-1', productCode: 'P1', units: 1 }] },
      };
      const earlier = {
        eventId: earlierEventId,
        eventType: 'order.placed.v1',
        aggregateId: orderId,
        correlationId: orderId,
        causationId: 'cause-0',
        occurredAt: '2026-08-24T10:00:00.000Z',
        payload: {
          orderReference: 'ORD-000001',
          retailerCode: 'RETAILER01',
          companyCode: 'COMPANY01',
          buyerGln: '1234567890128',
          supplierGln: '1234567890128',
          currency: 'USD',
          orderDate: '2026-08-24T09:00:00.000Z',
          lines: [{ productCode: 'P1', quantity: 1, unitPrice: 1000, lineDiscount: 0 }],
          initialAmount: 1000,
          initialDiscount: 0,
          totalAmount: 1000,
        },
      };

      await publishFact(kafka.brokers, FULFILLMENT_FACTS_TOPIC, orderId, later);
      await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, orderId, earlier);

      const collection = harness.db.collection('order_timeline');
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.events?.length === 2);

      const document = (await collection.findOne({ _id: orderId } as never))!;
      expect(document.events.map((e: { eventType: string }) => e.eventType)).toEqual(['order.placed.v1', 'stock.reserved.v1']);
      expect(document.events[0]).toMatchObject({ eventId: earlierEventId, eventType: 'order.placed.v1', occurredAt: earlier.occurredAt });
      expect(document.events[0].summary).toContain('ORD-000001');
      expect(document.events[1]).toMatchObject({ eventId: laterEventId, eventType: 'stock.reserved.v1', occurredAt: later.occurredAt });
      // PR14 integration half — updatedAt is the GREATEST occurredAt applied.
      expect(document.updatedAt).toBe(later.occurredAt);
    },
    60_000,
  );

  it(
    'R51 — leaves the read-model document unchanged when a fact with an already-present eventId is redelivered',
    async () => {
      harness = await bootProjectorTestApp(mongo, kafka, `timeline-projection-r51-${randomUUID().slice(0, 8)}`);
      const orderId = randomUUID();
      const eventId = randomUUID();
      const fact = {
        eventId,
        eventType: 'order.placed.v1',
        aggregateId: orderId,
        correlationId: orderId,
        causationId: 'cause-1',
        occurredAt: '2026-08-24T10:00:00.000Z',
        payload: {
          orderReference: 'ORD-000002',
          retailerCode: 'RETAILER01',
          companyCode: 'COMPANY01',
          buyerGln: '1234567890128',
          supplierGln: '1234567890128',
          currency: 'USD',
          orderDate: '2026-08-24T09:00:00.000Z',
          lines: [{ productCode: 'P1', quantity: 1, unitPrice: 1000, lineDiscount: 0 }],
          initialAmount: 1000,
          initialDiscount: 0,
          totalAmount: 1000,
        },
      };

      await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, orderId, fact);
      const collection = harness.db.collection('order_timeline');
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.events?.length === 1);
      const afterFirst = await collection.findOne({ _id: orderId } as never);

      // A REAL redelivery — the exact same envelope, published again.
      await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, orderId, fact);
      // No terminal predicate to poll for "stays at 1" — settle window long
      // enough for a second delivery to have been consumed if the dedup
      // guard failed.
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      const afterRedelivery = await collection.findOne({ _id: orderId } as never);
      expect(afterRedelivery!.events).toHaveLength(1);
      expect(afterRedelivery).toEqual(afterFirst);
    },
    60_000,
  );
}, 180_000);
