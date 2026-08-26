// OR1, R16 (`observability_reliability` design.md §4.1) — A4b's own
// equivalent, for the projector, of orders/src/saga-dead-letter.integration.spec.ts's
// live Phase-12 incident reproduction. This service's OWN poison-message
// shape is different from Orders' (a malformed `correlationId` has no
// natural throw point downstream here — grepped, this service never
// parses/validates `correlationId`'s format), but the STRUCTURE of the
// incident is identical: a fact passes `parseFactEnvelope`'s envelope-
// SHAPE guard (every field present), then throws deep inside pure
// projection logic on a payload that is semantically malformed — here,
// `stock.rejected.v1` with an EMPTY `shortages` array
// (`domain/summaries.ts`'s `stockRejectedSummary`:
// `payload.shortages[0]!.productCode` on an empty array throws a
// TypeError). BEFORE this feature, `projector-facts.controller.ts`'s
// `route` rethrew any error that was not `UnknownFactTypeError`
// unconditionally — @nestjs/microservices never commits the offset on a
// thrown handler, so this exact fact would have wedged its partition
// forever. This spec proves the fix: retried, dead-lettered to
// `<topic>.dlq`, and the offset commits so the next, distinct, valid fact
// on the SAME partition still gets projected.
import { randomUUID } from 'node:crypto';
import { Kafka, type Consumer } from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Envelope } from '@otc/contracts';
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, ORDERS_FACTS_TOPIC } from './infrastructure/messaging/kafka.config';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';
import { bootProjectorTestApp, type ProjectorTestApp } from './test-support/projector-app-test-harness';
import { stockReservedEnvelope } from './test-support/envelope-fixtures';

const FIXED_PARTITION = 0;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`projector-dead-letter: condition not met within ${timeoutMs}ms`);
}

function poisonStockRejectedEnvelope(orderId: string): Envelope {
  return {
    eventId: randomUUID(),
    eventType: 'stock.rejected.v1',
    aggregateId: orderId,
    correlationId: orderId,
    causationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    // The malformed shape: envelope-level fields are all present (passes
    // parseFactEnvelope), but `shortages` is empty — `stockRejectedSummary`
    // reads `payload.shortages[0]!.productCode` unconditionally, which
    // throws deep inside pure projection logic, past every shape guard.
    payload: {
      orderReference: 'ORD-999999',
      companyCode: 'COMPANY01',
      shortages: [],
      reason: 'insufficient_stock',
    },
  } as unknown as Envelope;
}

async function publishToFixedPartition(kafka: Kafka, topic: string, key: string, envelope: Envelope): Promise<void> {
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  await producer.connect();
  try {
    await producer.send({
      topic,
      acks: -1,
      messages: [{ key, value: JSON.stringify(envelope), partition: FIXED_PARTITION }],
    });
  } finally {
    await producer.disconnect();
  }
}

async function collectDlqMessages(
  kafka: Kafka,
  topic: string,
): Promise<{ consumer: Consumer; messages: Array<{ headers: Record<string, string>; value: Envelope }> }> {
  const messages: Array<{ headers: Record<string, string>; value: Envelope }> = [];
  const consumer = kafka.consumer({ groupId: `projector-dlq-probe-${randomUUID()}`, sessionTimeout: 30_000 });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {})) {
        headers[k] = v ? v.toString('utf8') : '';
      }
      messages.push({ headers, value: JSON.parse(message.value!.toString('utf8')) as Envelope });
    },
  });
  return { consumer, messages };
}

function pointKafkaBrokersEnvAt(brokers: readonly string[]): void {
  process.env.KAFKA_BROKERS = brokers.join(',');
  // Speeds up the in-line retry loop (3 attempts, exponential backoff
  // 50ms/100ms instead of the 500ms/1000ms default) — this spec is about
  // the DEAD-LETTER outcome, not the backoff timing itself (that is
  // fact-retry-dispatcher.spec.ts's own concern, proven once, generically).
  process.env.FACT_RETRY_MAX_ATTEMPTS = '3';
  process.env.FACT_RETRY_BACKOFF_MS = '50';
}

function clearKafkaBrokersEnv(): void {
  delete process.env.KAFKA_BROKERS;
  delete process.env.FACT_RETRY_MAX_ATTEMPTS;
  delete process.env.FACT_RETRY_BACKOFF_MS;
}

describe('projector-dead-letter — OR1, R16 (A4b, Testcontainers real Kafka + real MongoDB)', () => {
  let mongo: StandaloneMongoTestFixture;
  let kafka: KafkaTestFixture;
  let rawKafka: Kafka;

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    kafka = await startKafkaTestFixture();
    // ProjectorFactsController subscribes to ALL THREE fact topics in one
    // `consumer.subscribe` call (same shape saga-facts.controller.ts and
    // notification-facts.controller.ts both establish) — all three must
    // exist before the app connects, or the subscribe call fails outright
    // for whichever topic is missing.
    await createTopic(kafka.brokers, ORDERS_FACTS_TOPIC);
    await createTopic(kafka.brokers, FULFILLMENT_FACTS_TOPIC);
    await createTopic(kafka.brokers, BILLING_FACTS_TOPIC);
    // OR1's `.dlq` companion — created up front (auto-creation is disabled
    // on the fixture broker, same finding apps/orders/src/test-support/saga-integration-harness.ts
    // already records) since KafkaDlqPublisher never creates its own topic.
    await createTopic(kafka.brokers, `${FULFILLMENT_FACTS_TOPIC}.dlq`);
    rawKafka = new Kafka({ clientId: 'otc-projector-dead-letter-test', brokers: [...kafka.brokers] });
    pointKafkaBrokersEnvAt(kafka.brokers);
  }, 180_000);

  afterAll(async () => {
    await kafka?.teardown();
    await mongo?.teardown();
    clearKafkaBrokersEnv();
  }, 60_000);

  let harness: ProjectorTestApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  }, 30_000);

  it(
    'a stock.rejected.v1 with an empty shortages array — the malformed-past-the-envelope-guard shape — is retried, dead-lettered, and the offset commits so the next, distinct fact on the SAME partition still gets projected',
    async () => {
      harness = await bootProjectorTestApp(mongo, kafka, `projector-dead-letter-${randomUUID().slice(0, 8)}`);
      const poisonOrderId = randomUUID();
      const poisonEnvelope = poisonStockRejectedEnvelope(poisonOrderId);

      const { consumer, messages: dlqMessages } = await collectDlqMessages(rawKafka, `${FULFILLMENT_FACTS_TOPIC}.dlq`);
      try {
        await publishToFixedPartition(rawKafka, FULFILLMENT_FACTS_TOPIC, poisonOrderId, poisonEnvelope);

        await waitFor(async () => dlqMessages.some((m) => m.value.eventId === poisonEnvelope.eventId));

        const dlq = dlqMessages.find((m) => m.value.eventId === poisonEnvelope.eventId)!;
        expect(dlq.headers['x-failed-consumer']).toBe('projector');
        expect(dlq.headers['x-attempts']).toBe('3');
        expect(dlq.headers['x-error']).toBeTruthy();
        expect(dlq.headers['x-original-topic']).toBe(FULFILLMENT_FACTS_TOPIC);
        // The UNMODIFIED original envelope (OR1) — a redrive is a
        // byte-for-byte republish.
        expect(dlq.value.eventId).toBe(poisonEnvelope.eventId);
        expect((dlq.value.payload as { shortages: unknown[] }).shortages).toEqual([]);

        // No document was ever created for the poisoned order — the write
        // never happened (projectFact threw before any Mongo call).
        const poisonDoc = await harness.db.collection('order_timeline').findOne({ _id: poisonOrderId } as never);
        expect(poisonDoc).toBeNull();

        // The property that actually matters: a REAL, valid fact for a
        // DIFFERENT order, published to the SAME fixed partition on the
        // SAME topic right behind the poison message, still gets
        // projected — the offset committed, the partition was not
        // blocked. stock.reserved.v1 is FULFILLMENT_FACTS_TOPIC's own
        // fact and projects unconditionally (fillIfAbsent: {}).
        const followingOrderId = randomUUID();
        const followingFulfilmentEnvelope = stockReservedEnvelope({
          eventId: randomUUID(),
          aggregateId: followingOrderId,
          correlationId: followingOrderId,
        });
        await publishToFixedPartition(rawKafka, FULFILLMENT_FACTS_TOPIC, followingOrderId, followingFulfilmentEnvelope);

        await waitFor(async () => (await harness!.db.collection('order_timeline').findOne({ _id: followingOrderId } as never)) !== null);
        const followingDoc = await harness.db.collection('order_timeline').findOne({ _id: followingOrderId } as never);
        expect(
          (followingDoc as unknown as { events: Array<{ eventType: string }> }).events.map((e) => e.eventType),
        ).toContain('stock.reserved.v1');
      } finally {
        await consumer.disconnect();
      }
    },
    90_000,
  );
});
