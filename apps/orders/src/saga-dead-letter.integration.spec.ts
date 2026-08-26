// OR1, R16 (`observability_reliability` design.md §4.1) — the retry-then-
// DLQ wrapper, proven against the CONCRETE, live Phase-12 incident this
// feature grounds in (`progress/current.md`, `design.md` §2): a fact with
// a non-UUID `correlationId` passed `parseFactEnvelope`'s envelope-shape
// guard, then threw deep inside the transactional unit — propagating,
// unwrapped, out of `@nestjs/microservices`'s Kafka transport, which does
// not commit the offset on a thrown handler. Every redelivery repeated the
// identical throw, forever, on that partition; recovery needed manual
// `kafka-consumer-groups.sh` surgery. This spec reproduces that EXACT
// shape (a malformed `correlationId`, not merely a synthetic thrown
// error) and proves the fix: the offset commits, so the next, distinct,
// valid fact on the SAME partition still processes. A second case proves
// OR1's "including, but not limited to" clause with a generic thrown
// error — the mechanism is general, the incident is one instance of it.
import { randomUUID } from 'node:crypto';
import { Kafka, type Consumer } from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { UniqueId } from '@otc/shared-kernel';
import type { Envelope } from '@otc/contracts';
import type { TransactionContext } from './application/ports/unit-of-work.port';
import type { Order } from './domain/order';
import type { OrderRepository } from './application/ports/order-repository.port';
import * as ordersSchema from './infrastructure/persistence/schema/index';
import { KAFKA_PRODUCER_CONFIG, KAFKA_SEND_ACKS } from './infrastructure/outbox/kafka-fact-publisher';
import {
  ORDERS_FACTS_DLQ_TOPIC,
  startSagaIntegrationHarness,
  type SagaIntegrationHarness,
} from './test-support/saga-integration-harness';

const ORDERS_FACTS_TOPIC = 'otc.orders.facts.v1';
const FIXED_PARTITION = 0;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`saga-dead-letter: condition not met within ${timeoutMs}ms`);
}

function envelopeFor(eventType: string, correlationId: string, aggregateId: string): Envelope {
  return {
    eventId: randomUUID(),
    eventType,
    aggregateId,
    correlationId,
    causationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {
      orderReference: 'ORD-999999',
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      buyerGln: '5412345000013',
      supplierGln: '5412345000037',
      currency: 'EUR',
      orderDate: new Date().toISOString(),
      lines: [{ productCode: 'PRD-0001', description: 'Widget', quantity: 1, unitPrice: 1000, lineDiscount: 0 }],
      initialAmount: 1000,
      initialDiscount: 0,
      totalAmount: 1000,
    },
  } as unknown as Envelope;
}

/** Publishes to a FIXED partition (kafkajs's per-message `partition` field) so a poison fact and the fact behind it are guaranteed to share a partition — the property the live incident actually broke. */
async function publishToFixedPartition(kafka: Kafka, topic: string, key: string, envelope: Envelope): Promise<void> {
  const producer = kafka.producer(KAFKA_PRODUCER_CONFIG);
  await producer.connect();
  try {
    await producer.send({
      topic,
      acks: KAFKA_SEND_ACKS,
      messages: [{ key, value: JSON.stringify(envelope), partition: FIXED_PARTITION }],
    });
  } finally {
    await producer.disconnect();
  }
}

async function collectDlqMessages(
  kafka: Kafka,
): Promise<{ consumer: Consumer; messages: Array<{ headers: Record<string, string>; value: Envelope }> }> {
  const messages: Array<{ headers: Record<string, string>; value: Envelope }> = [];
  const consumer = kafka.consumer({ groupId: `dlq-probe-${randomUUID()}`, sessionTimeout: 30_000 });
  await consumer.connect();
  await consumer.subscribe({ topic: ORDERS_FACTS_DLQ_TOPIC, fromBeginning: true });
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

/** Always throws for order ids in `poisonIds` — never just once, so every in-line retry attempt fails and the wrapper actually exhausts (A4d's "generic thrown error" case). */
function alwaysFailFindByIdFor(real: OrderRepository, poisonIds: Set<string>): OrderRepository {
  return {
    async findById(id: UniqueId, tx?: TransactionContext): Promise<Order | null> {
      if (poisonIds.has(id.value)) {
        throw new Error('saga-dead-letter: simulated generic processing failure (A4d fixture)');
      }
      return real.findById(id, tx);
    },
    findByReference: (...args) => real.findByReference(...args),
    findByRequestId: (...args) => real.findByRequestId(...args),
    save: (...args) => real.save(...args),
  };
}

describe('saga-dead-letter — OR1, R16 (the live Phase-12 incident, Testcontainers)', () => {
  let harness: SagaIntegrationHarness;
  let rawKafka: Kafka;
  let poisonIds: Set<string>;

  beforeAll(async () => {
    poisonIds = new Set<string>();
    harness = await startSagaIntegrationHarness({
      factRetryConfig: { maxAttempts: 3, backoffBaseMs: 50 },
      wrapOrderRepository: (real) => alwaysFailFindByIdFor(real, poisonIds),
    });
    rawKafka = new Kafka({ clientId: 'otc-orders-dead-letter-test', brokers: [...harness.kafkaFixture.brokers] });
  }, 300_000);

  afterEach(() => {
    poisonIds.clear();
  });

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('reproduces the Phase-12 incident: a fact with a non-UUID correlationId is retried, dead-lettered, and the offset commits so the next, distinct fact still processes', async () => {
    const poisonEnvelope = envelopeFor('order.placed.v1', 'not-a-uuid-correlation-id', randomUUID());

    // fromBeginning: true reads the WHOLE topic, including any prior
    // test's dead-lettered message — matched by `eventId`, never by
    // position, so this test is order-independent within the file.
    const { consumer, messages: dlqMessages } = await collectDlqMessages(rawKafka);
    try {
      await publishToFixedPartition(rawKafka, ORDERS_FACTS_TOPIC, poisonEnvelope.correlationId, poisonEnvelope);

      await waitFor(async () => dlqMessages.some((m) => m.value.eventId === poisonEnvelope.eventId));

      const dlq = dlqMessages.find((m) => m.value.eventId === poisonEnvelope.eventId)!;
      expect(dlq.headers['x-failed-consumer']).toBe('orders.saga');
      expect(dlq.headers['x-attempts']).toBe('3');
      expect(dlq.headers['x-error']).toBeTruthy();
      expect(dlq.headers['x-original-topic']).toBe(ORDERS_FACTS_TOPIC);
      // The UNMODIFIED original envelope — a redrive is a byte-for-byte republish.
      expect(dlq.value.eventId).toBe(poisonEnvelope.eventId);
      expect(dlq.value.correlationId).toBe('not-a-uuid-correlation-id');

      // The property that actually failed live: a REAL order, on the SAME
      // partition, published right behind the poison message, still gets
      // processed — the offset committed, the partition was not blocked.
      const followingOrder = await harness.placeOrder();
      const validEnvelope = envelopeFor('order.placed.v1', followingOrder.id.value, followingOrder.id.value);
      await publishToFixedPartition(rawKafka, ORDERS_FACTS_TOPIC, followingOrder.id.value, validEnvelope);

      await waitFor(async () => {
        const [row] = await harness.db
          .select()
          .from(ordersSchema.sagaCommands)
          .where(eq(ordersSchema.sagaCommands.orderId, followingOrder.id.value));
        return row?.command === 'stock.reserve';
      });
    } finally {
      await consumer.disconnect();
    }
  }, 60_000);

  it('OR1\'s "including, but not limited to" clause: a generic thrown error (not the correlationId shape) is retried, dead-lettered, and the offset still commits', async () => {
    const order = await harness.placeOrder();
    poisonIds.add(order.id.value);
    const envelope = envelopeFor('order.placed.v1', order.id.value, order.id.value);

    const { consumer, messages: dlqMessages } = await collectDlqMessages(rawKafka);
    try {
      await publishToFixedPartition(rawKafka, ORDERS_FACTS_TOPIC, order.id.value, envelope);

      await waitFor(async () => dlqMessages.some((m) => m.value.eventId === envelope.eventId));

      const dlq = dlqMessages.find((m) => m.value.eventId === envelope.eventId)!;
      expect(dlq.headers['x-failed-consumer']).toBe('orders.saga');
      expect(dlq.headers['x-attempts']).toBe('3');
      expect(dlq.headers['x-error']).toContain('simulated generic processing failure');
      expect(dlq.value.eventId).toBe(envelope.eventId);
    } finally {
      await consumer.disconnect();
    }
  }, 60_000);
}, 300_000);
