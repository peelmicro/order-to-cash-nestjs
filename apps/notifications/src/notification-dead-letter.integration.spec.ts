// OR1, R16 (`observability_reliability` design.md §4.1) — A4b's own
// equivalent, for notifications, of orders/src/saga-dead-letter.integration.spec.ts's
// live Phase-12 incident reproduction. This service's own poison-message
// shape, like the projector's, differs from Orders' (no downstream code
// here validates `correlationId`'s format either), but the STRUCTURE is
// identical: a fact passes `parseFactEnvelope`'s envelope-SHAPE guard
// (every top-level field present), then throws deep inside a template
// builder on a PAYLOAD that is semantically malformed — here,
// `order.placed.v1` with NO `retailerCode`
// (`infrastructure/templates/order-placed.template.ts`'s
// `escapeHtml(payload.retailerCode)` on `undefined` throws a TypeError
// before `recipientFor` is ever reached). BEFORE this feature, the bare
// `commandBus.execute(...)` call inside `route` propagated this raw —
// `@nestjs/microservices` never commits the offset on a thrown handler,
// so this exact fact would have wedged its partition forever. This spec
// proves the fix: retried, dead-lettered to `<topic>.dlq`, and the offset
// commits so the next, distinct, valid fact on the SAME partition still
// gets notified.
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { Kafka, type Consumer } from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Envelope } from '@otc/contracts';
import { AppModule } from './app.module';
import { NOTIFICATION_SENDER, type NotificationMessage, type NotificationSender } from './application/ports/notification-sender.port';
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, ORDERS_FACTS_TOPIC } from './infrastructure/messaging/kafka.config';
import {
  startNotificationsTestFixture,
  type NotificationsTestFixture,
} from './infrastructure/persistence/test-support/notifications-test-fixture';
import {
  createTopic,
  KAFKA_TEST_CLIENT_RETRY,
  startKafkaTestFixture,
  waitForConsumerGroupReady,
  type KafkaTestFixture,
} from './test-support/kafka-test-fixture';

const FIXED_PARTITION = 0;

class CountingNotificationSender implements NotificationSender {
  readonly sent: NotificationMessage[] = [];

  async send(message: NotificationMessage): Promise<void> {
    this.sent.push(message);
  }

  get callCount(): number {
    return this.sent.length;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`notification-dead-letter: condition not met within ${timeoutMs}ms`);
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`notification-dead-letter: condition not met within ${timeoutMs}ms`);
}

/** `order.placed.v1` with `retailerCode` OMITTED — the malformed-past-the-envelope-guard shape (see this file's header). Every OTHER field is present and well-formed, isolating the one missing field as the cause. */
function poisonOrderPlacedEnvelope(orderId: string): Envelope {
  return {
    eventId: randomUUID(),
    eventType: 'order.placed.v1',
    aggregateId: orderId,
    correlationId: orderId,
    causationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {
      orderReference: 'ORD-999999',
      companyCode: 'COMPANY01',
      buyerGln: '1234567890128',
      supplierGln: '1234567890128',
      currency: 'USD',
      orderDate: new Date().toISOString(),
      lines: [{ productCode: 'P1', quantity: 1, unitPrice: 1000, lineDiscount: 0 }],
      initialAmount: 1000,
      initialDiscount: 0,
      totalAmount: 1000,
      // retailerCode DELIBERATELY OMITTED.
    },
  } as unknown as Envelope;
}

function validOrderPlacedEnvelope(orderId: string): Envelope {
  return {
    eventId: randomUUID(),
    eventType: 'order.placed.v1',
    aggregateId: orderId,
    correlationId: orderId,
    causationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    payload: {
      orderReference: 'ORD-000042',
      retailerCode: 'RETAILER01',
      companyCode: 'COMPANY01',
      buyerGln: '1234567890128',
      supplierGln: '1234567890128',
      currency: 'USD',
      orderDate: new Date().toISOString(),
      lines: [{ productCode: 'P1', quantity: 1, unitPrice: 1000, lineDiscount: 0 }],
      initialAmount: 1000,
      initialDiscount: 0,
      totalAmount: 1000,
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
  const consumer = kafka.consumer({ groupId: `notifications-dlq-probe-${randomUUID()}`, sessionTimeout: 30_000 });
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

function pointEnvAtMysqlFixture(mysql: NotificationsTestFixture): void {
  process.env.NOTIFICATIONS_DB_HOST = mysql.config.host;
  process.env.MYSQL_HOST_PORT = String(mysql.config.port);
  process.env.MYSQL_USER = mysql.config.user;
  process.env.MYSQL_PASSWORD = mysql.config.password;
  process.env.MYSQL_DB_NOTIFICATIONS = mysql.config.database;
}

function pointEnvAtKafkaFixture(kafka: KafkaTestFixture): void {
  process.env.KAFKA_BROKERS = kafka.brokers.join(',');
  // Speeds up the in-line retry loop (3 attempts, 50ms/100ms backoff
  // instead of the 500ms/1000ms default) — this spec is about the
  // DEAD-LETTER outcome, not the backoff timing itself (fact-retry-dispatcher.spec.ts's
  // own concern, proven once, generically, byte-identical to the
  // canonical — OI12).
  process.env.FACT_RETRY_MAX_ATTEMPTS = '3';
  process.env.FACT_RETRY_BACKOFF_MS = '50';
}

function clearEnv(): void {
  delete process.env.NOTIFICATIONS_DB_HOST;
  delete process.env.MYSQL_HOST_PORT;
  delete process.env.MYSQL_USER;
  delete process.env.MYSQL_PASSWORD;
  delete process.env.MYSQL_DB_NOTIFICATIONS;
  delete process.env.KAFKA_BROKERS;
  delete process.env.FACT_RETRY_MAX_ATTEMPTS;
  delete process.env.FACT_RETRY_BACKOFF_MS;
}

describe('notification-dead-letter — OR1, R16 (A4b, Testcontainers real Kafka + real MySQL)', () => {
  let mysql: NotificationsTestFixture;
  let kafka: KafkaTestFixture;
  let rawKafka: Kafka;

  beforeAll(async () => {
    mysql = await startNotificationsTestFixture();
    kafka = await startKafkaTestFixture();
    pointEnvAtMysqlFixture(mysql);
    pointEnvAtKafkaFixture(kafka);
    // NotificationFactsController subscribes to ALL THREE fact topics in
    // one `consumer.subscribe` call — all three must exist before the app
    // connects (same finding notification-consumption.integration.spec.ts
    // already records).
    await createTopic(kafka.brokers, ORDERS_FACTS_TOPIC);
    await createTopic(kafka.brokers, FULFILLMENT_FACTS_TOPIC);
    await createTopic(kafka.brokers, BILLING_FACTS_TOPIC);
    // OR1's `.dlq` companion — created up front (auto-creation is disabled
    // on the fixture broker) since KafkaDlqPublisher never creates its own
    // topic.
    await createTopic(kafka.brokers, `${ORDERS_FACTS_TOPIC}.dlq`);
    rawKafka = new Kafka({ clientId: 'otc-notifications-dead-letter-test', brokers: [...kafka.brokers] });
  }, 180_000);

  afterAll(async () => {
    await kafka?.teardown();
    await mysql?.teardown();
    clearEnv();
  }, 60_000);

  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  }, 30_000);

  it(
    'an order.placed.v1 with retailerCode omitted — the malformed-past-the-envelope-guard shape — is retried, dead-lettered, and the offset commits so the next, distinct fact on the SAME partition still gets notified',
    async () => {
      const sender = new CountingNotificationSender();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(NOTIFICATION_SENDER)
        .useValue(sender)
        .compile();

      app = moduleRef.createNestApplication();
      const groupId = `notifications-dead-letter-${randomUUID().slice(0, 8)}`;
      app.connectMicroservice<MicroserviceOptions>({
        transport: Transport.KAFKA,
        options: {
          client: { clientId: `otc-${groupId}`, brokers: [...kafka.brokers], retry: KAFKA_TEST_CLIENT_RETRY },
          consumer: { groupId, sessionTimeout: 30000 },
          subscribe: { fromBeginning: true },
          run: { partitionsConsumedConcurrently: 1 },
        },
      });
      await app.startAllMicroservices();
      await app.init();
      await waitForConsumerGroupReady(kafka.brokers, `${groupId}-server`);

      const poisonOrderId = randomUUID();
      const poisonEnvelope = poisonOrderPlacedEnvelope(poisonOrderId);

      const { consumer, messages: dlqMessages } = await collectDlqMessages(rawKafka, `${ORDERS_FACTS_TOPIC}.dlq`);
      try {
        await publishToFixedPartition(rawKafka, ORDERS_FACTS_TOPIC, poisonOrderId, poisonEnvelope);

        await waitForAsync(async () => dlqMessages.some((m) => m.value.eventId === poisonEnvelope.eventId));

        const dlq = dlqMessages.find((m) => m.value.eventId === poisonEnvelope.eventId)!;
        expect(dlq.headers['x-failed-consumer']).toBe('notifications');
        expect(dlq.headers['x-attempts']).toBe('3');
        expect(dlq.headers['x-error']).toBeTruthy();
        expect(dlq.headers['x-original-topic']).toBe(ORDERS_FACTS_TOPIC);
        // The UNMODIFIED original envelope (OR1) — a redrive is a
        // byte-for-byte republish.
        expect(dlq.value.eventId).toBe(poisonEnvelope.eventId);
        expect((dlq.value.payload as Record<string, unknown>).retailerCode).toBeUndefined();

        // Never sent — the throw happened before sender.send was reached.
        expect(sender.callCount).toBe(0);

        // The property that actually matters: a REAL, valid fact for a
        // DIFFERENT order, published to the SAME fixed partition on the
        // SAME topic right behind the poison message, still gets
        // notified — the offset committed, the partition was not
        // blocked.
        const followingOrderId = randomUUID();
        const followingEnvelope = validOrderPlacedEnvelope(followingOrderId);
        await publishToFixedPartition(rawKafka, ORDERS_FACTS_TOPIC, followingOrderId, followingEnvelope);

        await waitFor(() => sender.callCount === 1);
        expect(sender.sent[0]!.subject).toContain('ORD-000042');
      } finally {
        await consumer.disconnect();
      }
    },
    90_000,
  );
});
