// NS9/NS8/NS1 at the integration level — a real, disposable Kafka broker
// (Testcontainers, apache/kafka:4.3.1, same pinned tag docker-compose.infra.yml
// uses) AND a real, disposable MySQL broker (Testcontainers, mysql:8.4.11 —
// notifications_service re-review, N1/N2/N7: the durable `processed_events`
// ledger this service now owns), a real Nest app with the real Kafka
// microservice transport (main.ts's own shape), and the real
// NotificationFactsController -> CommandBus -> NotifyOrderPlacedHandler ->
// NotificationDispatchService chain — only `NOTIFICATION_SENDER` is
// overridden, to a countable fake (never a mock of the broker or the
// database). Proves:
//   1. a published order.placed.v1 fact is consumed and sent exactly once;
//   2. the SAME eventId published a second time, to the SAME running app
//      (a real redelivery/duplicate, not a simulated one), does NOT send a
//      second time;
//   3. N7 — the SAME eventId, redelivered to a FRESH Nest app instance
//      (simulating a process restart) sharing the SAME durable MySQL
//      ledger, ALSO does not send a second time. This is the case the
//      re-review's Probe 1 demonstrated the old in-memory store failed —
//      it is the most valuable test in this feature.
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { NOTIFICATION_SENDER, type NotificationMessage, type NotificationSender } from './application/ports/notification-sender.port';
import { BILLING_FACTS_TOPIC, FULFILLMENT_FACTS_TOPIC, ORDERS_FACTS_TOPIC } from './infrastructure/messaging/kafka.config';
import { processedEvents } from './infrastructure/persistence/schema/processed-events.schema';
import {
  startNotificationsTestFixture,
  type NotificationsTestFixture,
} from './infrastructure/persistence/test-support/notifications-test-fixture';
import {
  createTopic,
  KAFKA_TEST_CLIENT_RETRY,
  publishFact,
  startKafkaTestFixture,
  waitForConsumerGroupReady,
  type KafkaTestFixture,
} from './test-support/kafka-test-fixture';

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
  throw new Error(`notification-consumption: condition not met within ${timeoutMs}ms`);
}

function orderPlacedEnvelope(eventId: string, aggregateId: string) {
  return {
    eventId,
    eventType: 'order.placed.v1',
    aggregateId,
    correlationId: aggregateId,
    causationId: 'cause-1',
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
}

/**
 * Points the REAL, unmodified `db-config.ts` loader (used inside
 * `app.module.ts`'s own `useFactory`, never overridden) at the disposable
 * MySQL fixture — the same "env-var driven, single source of truth" pattern
 * every DB config in this codebase already uses, so no provider surgery is
 * needed to run `AppModule` against a Testcontainers database.
 */
function pointEnvAtMysqlFixture(mysql: NotificationsTestFixture): void {
  process.env.NOTIFICATIONS_DB_HOST = mysql.config.host;
  process.env.MYSQL_HOST_PORT = String(mysql.config.port);
  process.env.MYSQL_USER = mysql.config.user;
  process.env.MYSQL_PASSWORD = mysql.config.password;
  process.env.MYSQL_DB_NOTIFICATIONS = mysql.config.database;
}

function clearMysqlEnv(): void {
  delete process.env.NOTIFICATIONS_DB_HOST;
  delete process.env.MYSQL_HOST_PORT;
  delete process.env.MYSQL_USER;
  delete process.env.MYSQL_PASSWORD;
  delete process.env.MYSQL_DB_NOTIFICATIONS;
}

describe('notification-consumption (Testcontainers, real Kafka AND real MySQL)', () => {
  let mysql: NotificationsTestFixture;

  beforeAll(async () => {
    mysql = await startNotificationsTestFixture();
    pointEnvAtMysqlFixture(mysql);
  }, 120_000);

  afterAll(async () => {
    await mysql?.teardown();
    clearMysqlEnv();
  }, 60_000);

  describe('single running app', () => {
    let kafka: KafkaTestFixture | undefined;
    let app: INestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
      await kafka?.teardown();
      kafka = undefined;
    }, 60_000);

    it(
      'consumes a real order.placed.v1 fact exactly once, and a real redelivery of the same eventId sends no second time',
      async () => {
        kafka = await startKafkaTestFixture();
        // NotificationFactsController registers an @EventPattern for ALL
        // THREE fact topics (notification-facts.controller.ts) — kafkajs's
        // `ServerKafka.bindEvents` subscribes to every registered pattern in
        // ONE `consumer.subscribe` call, so all three topics must exist (and
        // be metadata-fetchable — `waitForTopicReady`'s header) before the
        // app connects, or the subscribe call fails outright for whichever
        // topic is missing.
        await createTopic(kafka.brokers, ORDERS_FACTS_TOPIC);
        await createTopic(kafka.brokers, FULFILLMENT_FACTS_TOPIC);
        await createTopic(kafka.brokers, BILLING_FACTS_TOPIC);

        const sender = new CountingNotificationSender();
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(NOTIFICATION_SENDER)
          .useValue(sender)
          .compile();

        app = moduleRef.createNestApplication();
        const groupId = 'notifications-single-app-test';
        app.connectMicroservice<MicroserviceOptions>({
          transport: Transport.KAFKA,
          options: {
            // `retry` here is TEST-ONLY hardening — see
            // `KAFKA_TEST_CLIENT_RETRY`'s comment (kafka-test-fixture.ts)
            // for why kafkajs's own `NODE_ENV=test` defaults are too
            // short/coarse for a freshly-started single-node KRaft broker.
            client: { clientId: 'otc-notifications-single-app-test', brokers: [...kafka.brokers], retry: KAFKA_TEST_CLIENT_RETRY },
            consumer: { groupId, sessionTimeout: 30000 },
            // Independent of main.ts's own N3 choice (`fromBeginning: false`
            // in production) — this test publishes AFTER the consumer group
            // is confirmed ready, on a brand-new topic with no prior
            // messages, so `fromBeginning`'s value makes no observable
            // difference here; kept `true` only for parity with how the
            // rest of this codebase's Kafka consumer tests are written.
            subscribe: { fromBeginning: true },
            run: { partitionsConsumedConcurrently: 1 },
          },
        });
        await app.startAllMicroservices();
        await app.init();

        // `ServerKafka` appends `-server` to the configured `groupId`
        // unconditionally (`postfixId` default `'-server'`), so the
        // broker-side group is `notifications-single-app-test-server`, not
        // `groupId` itself — same finding
        // apps/orders/src/test-support/saga-integration-harness.ts records.
        await waitForConsumerGroupReady(kafka.brokers, `${groupId}-server`);

        const envelope = orderPlacedEnvelope('single-app-event-1', 'order-single-1');
        await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, envelope.aggregateId, envelope);

        await waitFor(() => sender.callCount === 1);
        expect(sender.sent[0]!.subject).toContain('ORD-000001');
        expect(sender.sent[0]!.subject).toContain(`correlationId: ${envelope.correlationId}`);
        expect(sender.sent[0]!.messageId).toBe('single-app-event-1@order-to-cash');

        // A REAL redelivery: the exact same envelope (same eventId), published
        // again onto the same topic — not a simulated retry.
        await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, envelope.aggregateId, envelope);

        // No `waitFor` predicate for "stays at 1" — assert after a fixed
        // settle window long enough for a second delivery to have been
        // consumed and processed if the dedup guard failed to catch it.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(sender.callCount).toBe(1);
      },
      120_000,
    );
  });

  describe('cross-restart (N7)', () => {
    let kafka: KafkaTestFixture | undefined;
    let app1: INestApplication | undefined;
    let app2: INestApplication | undefined;

    afterEach(async () => {
      await app2?.close();
      app2 = undefined;
      await app1?.close();
      app1 = undefined;
      await kafka?.teardown();
      kafka = undefined;
    }, 60_000);

    it(
      'N7 — a fact processed by app1, then redelivered after app1 is closed, is NOT re-sent by a freshly-compiled app2 sharing the same durable MySQL ledger',
      async () => {
        kafka = await startKafkaTestFixture();
        await createTopic(kafka.brokers, ORDERS_FACTS_TOPIC);
        await createTopic(kafka.brokers, FULFILLMENT_FACTS_TOPIC);
        await createTopic(kafka.brokers, BILLING_FACTS_TOPIC);

        const groupId = 'notifications-cross-restart-test';
        const envelope = orderPlacedEnvelope('cross-restart-event-1', 'order-cross-restart-1');

        // ── app1: processes the fact once, then "the process restarts" ──
        const sender1 = new CountingNotificationSender();
        const moduleRef1 = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(NOTIFICATION_SENDER)
          .useValue(sender1)
          .compile();
        app1 = moduleRef1.createNestApplication();
        app1.connectMicroservice<MicroserviceOptions>({
          transport: Transport.KAFKA,
          options: {
            client: { clientId: 'otc-notifications-cross-restart-app1', brokers: [...kafka.brokers], retry: KAFKA_TEST_CLIENT_RETRY },
            consumer: { groupId, sessionTimeout: 30000 },
            subscribe: { fromBeginning: true },
            run: { partitionsConsumedConcurrently: 1 },
          },
        });
        await app1.startAllMicroservices();
        await app1.init();
        await waitForConsumerGroupReady(kafka.brokers, `${groupId}-server`);

        await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, envelope.aggregateId, envelope);
        await waitFor(() => sender1.callCount === 1);
        expect(sender1.sent[0]!.messageId).toBe('cross-restart-event-1@order-to-cash');

        // Confirm the ledger row genuinely landed in MySQL — not merely
        // heap state that `app1.close()` below will make unobservable.
        const rowsAfterApp1 = await mysql.db
          .select()
          .from(processedEvents)
          .where(and(eq(processedEvents.eventId, envelope.eventId), eq(processedEvents.consumer, 'notifications')));
        expect(rowsAfterApp1).toHaveLength(1);

        // "The process restarts": app1's Nest instance is torn down
        // entirely — a fresh AppModule compilation below gets fresh
        // in-process everything (fresh CqrsModule bus, fresh handler
        // instances), the ONLY thing that survives is the MySQL row just
        // asserted above.
        await app1.close();
        app1 = undefined;

        // A REAL redelivery, arriving AFTER the restart: the exact same
        // envelope (same eventId), published again — this is precisely the
        // scenario the old in-memory store failed (re-review Probe 1,
        // `run2`).
        await publishFact(kafka.brokers, ORDERS_FACTS_TOPIC, envelope.aggregateId, envelope);

        // ── app2: a FRESH Nest app, SAME Kafka consumer group, SAME MySQL ──
        const sender2 = new CountingNotificationSender();
        const moduleRef2 = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(NOTIFICATION_SENDER)
          .useValue(sender2)
          .compile();
        app2 = moduleRef2.createNestApplication();
        app2.connectMicroservice<MicroserviceOptions>({
          transport: Transport.KAFKA,
          options: {
            client: { clientId: 'otc-notifications-cross-restart-app2', brokers: [...kafka.brokers], retry: KAFKA_TEST_CLIENT_RETRY },
            consumer: { groupId, sessionTimeout: 30000 },
            subscribe: { fromBeginning: true },
            run: { partitionsConsumedConcurrently: 1 },
          },
        });
        await app2.startAllMicroservices();
        await app2.init();
        await waitForConsumerGroupReady(kafka.brokers, `${groupId}-server`);

        // app2 genuinely rejoined and is live — a positive readiness signal
        // BEFORE the negative assertion below, so a settle window is not
        // this test's only evidence.
        await new Promise((resolve) => setTimeout(resolve, 5_000));

        expect(sender2.callCount).toBe(0);
        expect(sender1.callCount).toBe(1); // unchanged — app1 is closed

        // The ledger still holds exactly ONE row for this eventId — app2's
        // redelivery did not insert a second one.
        const rowsAfterApp2 = await mysql.db
          .select()
          .from(processedEvents)
          .where(and(eq(processedEvents.eventId, envelope.eventId), eq(processedEvents.consumer, 'notifications')));
        expect(rowsAfterApp2).toHaveLength(1);
      },
      150_000,
    );
  });
}, 300_000);
