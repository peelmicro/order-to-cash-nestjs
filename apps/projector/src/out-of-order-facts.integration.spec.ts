// R52 › appends the timeline entry without regressing the document status
// or overwriting newer references. PR11; PR12 integration half.
// PR13 is proven at apps/projector/src/infrastructure/persistence/delta-to-pipeline.spec.ts:60.
// Real Kafka + real MongoDB.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BILLING_FACTS_TOPIC,
  FULFILLMENT_FACTS_TOPIC,
  ORDERS_FACTS_TOPIC,
} from './infrastructure/messaging/kafka.config';
import {
  createTopic,
  publishFact,
  startKafkaTestFixture,
  type KafkaTestFixture,
} from './test-support/kafka-test-fixture';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { bootProjectorTestApp, type ProjectorTestApp } from './test-support/projector-app-test-harness';
import {
  invoiceIssuedEnvelope,
  orderDespatchedEnvelope,
  orderPlacedEnvelope,
} from './test-support/envelope-fixtures';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`out-of-order-facts: condition not met within ${timeoutMs}ms`);
}

describe('out-of-order-facts — R52 (Testcontainers, real Kafka + real MongoDB)', () => {
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
    'R52 — order.despatched.v1 delivered BEFORE order.placed.v1 appends both entries; status ends at despatched (the outrunning fact\'s rank), never regressed by the later-arriving lower-rank placed fact',
    async () => {
      harness = await bootProjectorTestApp(mongo, kafka, `out-of-order-r52-${randomUUID().slice(0, 8)}`);
      const orderId = randomUUID();
      // occurredAt reflects the DOMAIN's own causal order (placed before
      // despatched) even though DELIVERY is the other way round — this is
      // what makes the events-array assertion below prove PR10 (stored
      // order is occurredAt, never arrival) as well as R52.
      const despatched = orderDespatchedEnvelope({
        correlationId: orderId,
        aggregateId: orderId,
        eventId: randomUUID(),
        occurredAt: '2026-08-24T10:00:00.000Z',
      });
      const placed = orderPlacedEnvelope({
        correlationId: orderId,
        aggregateId: orderId,
        eventId: randomUUID(),
        occurredAt: '2026-08-24T09:00:00.000Z',
      });

      // order.despatched.v1 FIRST — this order has NO document yet.
      await publishFact(kafka.brokers, FULFILLMENT_FACTS_TOPIC, orderId, despatched);
      const collection = harness.db.collection('order_timeline');
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.events?.length === 1);

      const afterDespatched = await collection.findOne({ _id: orderId } as never);
      expect(afterDespatched!.status).toBe('despatched');
      expect(afterDespatched!.headerComplete).toBe(false);
      expect(afterDespatched!.references.despatchReference).toBe('DES-000001');

      // order.placed.v1 arrives LATER — rank 1, strictly BELOW despatched's
      // rank 5. Status must NOT regress to "placed".
      await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, orderId, placed);
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.events?.length === 2);

      const afterPlaced = await collection.findOne({ _id: orderId } as never);
      expect(afterPlaced!.status).toBe('despatched'); // NOT regressed to "placed"
      expect(afterPlaced!.headerComplete).toBe(true); // order.placed.v1 fills the header regardless of arrival order
      expect(afterPlaced!.orderReference).toBe('ORD-000001');
      expect(afterPlaced!.events).toHaveLength(2);
      expect(afterPlaced!.events.map((e: { eventType: string }) => e.eventType)).toEqual(['order.placed.v1', 'order.despatched.v1']);
    },
    60_000,
  );

  it(
    'PR11 — a reference is written only while null: a later invoice.issued.v1 never overwrites an already-set despatchReference',
    async () => {
      harness = await bootProjectorTestApp(mongo, kafka, `out-of-order-pr11-${randomUUID().slice(0, 8)}`);
      const orderId = randomUUID();
      const despatched = orderDespatchedEnvelope({
        correlationId: orderId,
        aggregateId: orderId,
        eventId: randomUUID(),
        occurredAt: '2026-08-24T12:00:00.000Z',
      });
      const invoiced = invoiceIssuedEnvelope({
        correlationId: orderId,
        aggregateId: orderId,
        eventId: randomUUID(),
        occurredAt: '2026-08-24T13:00:00.000Z',
      });

      await publishFact(kafka.brokers, FULFILLMENT_FACTS_TOPIC, orderId, despatched);
      const collection = harness.db.collection('order_timeline');
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.events?.length === 1);

      await publishFact(kafka.brokers, BILLING_FACTS_TOPIC, orderId, invoiced);
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.events?.length === 2);

      const document = await collection.findOne({ _id: orderId } as never);
      expect(document!.references.despatchReference).toBe('DES-000001'); // set by the FIRST fact, unchanged
      expect(document!.references.invoiceReference).toBe('INV-000001'); // set by its own fact
    },
    60_000,
  );
}, 180_000);
