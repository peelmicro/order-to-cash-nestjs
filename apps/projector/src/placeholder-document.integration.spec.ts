// R53 › creates a placeholder document keyed by correlationId and fills in
// the header fields when order.placed.v1 is consumed later. PR8; PR9.
// Includes the case the partial index exists for: TWO DIFFERENT orders'
// placeholders coexisting, both with orderReference: null.
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
import { orderPlacedEnvelope, stockReservedEnvelope } from './test-support/envelope-fixtures';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`placeholder-document: condition not met within ${timeoutMs}ms`);
}

describe('placeholder-document — R53 (Testcontainers, real Kafka + real MongoDB)', () => {
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
    'R53 — creates a placeholder document keyed by correlationId, headerComplete false, status placed, rank 0; ' +
      'fills in the header fields (and sets headerComplete true, PR9) when order.placed.v1 is consumed later',
    async () => {
      harness = await bootProjectorTestApp(mongo, kafka, `placeholder-r53-${randomUUID().slice(0, 8)}`);
      const orderId = randomUUID();
      const reserved = stockReservedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });
      const placed = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });

      await publishFact(kafka.brokers, FULFILLMENT_FACTS_TOPIC, orderId, reserved);
      const collection = harness.db.collection('order_timeline');
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never)) !== null);

      const placeholder = await collection.findOne({ _id: orderId } as never);
      expect(placeholder!.headerComplete).toBe(false);
      // PR8's skeleton seeds status "placed"/rank 0 at INSERT time — but the
      // very same atomic apply that follows immediately raises it per the
      // triggering fact's own implied status (PR12): stock.reserved.v1 ->
      // "stock_reserved", rank 2 (strictly above the skeleton's rank 0, so
      // the real fact genuinely writes, exactly as design.md §5.1 states).
      expect(placeholder!.status).toBe('stock_reserved');
      expect(placeholder!.statusRank).toBe(2);
      expect(placeholder!.orderReference).toBeNull();
      expect(placeholder!.orderId).toBe(orderId);
      expect(placeholder!._id).toBe(orderId);
      // A valid OrderDetail even while headerComplete is false (PR9):
      // orderId, status, events, updatedAt all present.
      expect(placeholder!.events).toHaveLength(1);
      expect(typeof placeholder!.updatedAt).toBe('string');

      await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, orderId, placed);
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.headerComplete === true);

      const complete = await collection.findOne({ _id: orderId } as never);
      expect(complete!.headerComplete).toBe(true);
      expect(complete!.orderReference).toBe('ORD-000001');
      expect(complete!.currency).toBe('USD');
      expect(complete!.retailer.code).toBe('RETAILER01');
      expect(complete!.company.code).toBe('COMPANY01');
      expect(complete!.events).toHaveLength(2);
    },
    60_000,
  );

  it(
    'two DIFFERENT orders\' placeholders coexist, both with orderReference: null — the case the partial unique index exists for',
    async () => {
      harness = await bootProjectorTestApp(mongo, kafka, `placeholder-partial-index-${randomUUID().slice(0, 8)}`);
      const orderA = randomUUID();
      const orderB = randomUUID();

      await publishFact(
        kafka.brokers,
        FULFILLMENT_FACTS_TOPIC,
        orderA,
        stockReservedEnvelope({ correlationId: orderA, aggregateId: orderA, eventId: randomUUID() }),
      );
      await publishFact(
        kafka.brokers,
        FULFILLMENT_FACTS_TOPIC,
        orderB,
        stockReservedEnvelope({ correlationId: orderB, aggregateId: orderB, eventId: randomUUID() }),
      );

      const collection = harness.db.collection('order_timeline');
      await waitFor(async () => {
        const [a, b] = await Promise.all([
          collection.findOne({ _id: orderA } as never),
          collection.findOne({ _id: orderB } as never),
        ]);
        return a !== null && b !== null;
      });

      const [placeholderA, placeholderB] = await Promise.all([
        collection.findOne({ _id: orderA } as never),
        collection.findOne({ _id: orderB } as never),
      ]);
      expect(placeholderA!.orderReference).toBeNull();
      expect(placeholderB!.orderReference).toBeNull();
      // Scoped to THESE two orders — a fresh `fromBeginning: true` consumer
      // group (this describe block's OTHER `it`s share the same Kafka
      // topics) legitimately replays every fact ever published in this
      // file's run, so a blanket `{ orderReference: null }` count would
      // also transiently count another test's in-flight placeholder; the
      // property this case exists to prove is scoped to orderA/orderB.
      expect(
        await collection.countDocuments({ _id: { $in: [orderA, orderB] }, orderReference: null } as never),
      ).toBe(2);
    },
    60_000,
  );
}, 180_000);
