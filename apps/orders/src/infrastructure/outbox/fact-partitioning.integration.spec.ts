// R15 — `correlationId` is the fact-stream partition key, giving per-order
// ordering: every fact about one order lands on one partition and is read
// in emission order. Real MySQL + real Kafka (Testcontainers).
import { randomUUID } from 'node:crypto';
import { UniqueId } from '@otc/shared-kernel';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order } from '../../domain/order';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from '../persistence/order.repository';
import {
  startOrdersTestFixture,
  type OrdersTestFixture,
} from '../persistence/test-support/orders-test-fixture';
import { FakeClock } from '../persistence/test-support/fake-clock';
import { createKafkaClient } from './create-kafka-client';
import { KafkaFactPublisher } from './kafka-fact-publisher';
import { ORDERS_FACTS_TOPIC } from './kafka.config';
import { OutboxRelay } from './outbox-relay';
import { placeOrderInput } from './test-support/order-factory';
import { createTopic, startKafkaTestFixture, type KafkaTestFixture } from './test-support/kafka-test-fixture';

describe('fact-partitioning — R15 (Testcontainers, mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: OrdersTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let publisher: KafkaFactPublisher;
  let consumer: Consumer;

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startOrdersTestFixture(), startKafkaTestFixture()]);
    await createTopic(kafkaFixture.brokers, ORDERS_FACTS_TOPIC);
    publisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-orders-test' }));
  }, 300_000);

  afterAll(async () => {
    await consumer?.disconnect();
    await publisher?.disconnect();
    await mysqlFixture?.teardown();
    await kafkaFixture?.teardown();
  }, 120_000);

  it('delivers all facts produced by one context about one order to consumers in emission order', async () => {
    const clock = new FakeClock(new Date('2026-08-20T15:00:00.000Z'));
    const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);

    // Two orders, INTERLEAVED: order A's placed+confirmed, order B's
    // placed+confirmed, written as four separate transactions in an
    // A, B, A, B sequence — nothing here relies on the two orders' facts
    // being contiguous in the outbox.
    async function driveToConfirmed(): Promise<Order> {
      const order = Order.place(placeOrderInput(), { occurredAt: clock.now(), causationId: UniqueId.generate() });
      await unitOfWork.execute((tx) => repository.save(order, tx));
      return order;
    }
    async function confirm(order: Order): Promise<void> {
      order.markStockReserved({ occurredAt: clock.now(), causationId: UniqueId.generate() });
      order.approveCredit({ occurredAt: clock.now(), causationId: UniqueId.generate() });
      order.confirm({ occurredAt: clock.now(), causationId: UniqueId.generate() });
      await unitOfWork.execute((tx) => repository.save(order, tx));
    }

    const orderA = await driveToConfirmed();
    const orderB = await driveToConfirmed();
    await confirm(orderA);
    await confirm(orderB);

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });
    const result = await relay.runOnce();
    expect(result.published).toBe(4);

    const kafka = new Kafka({ clientId: 'otc-orders-test-consumer', brokers: [...kafkaFixture.brokers] });
    consumer = kafka.consumer({ groupId: `r15-${randomUUID()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: ORDERS_FACTS_TOPIC, fromBeginning: true });

    const received: { key: string; eventType: string; partition: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fact-partitioning: timed out waiting for 4 messages')), 30_000);
      consumer
        .run({
          eachMessage: async ({ message, partition }: EachMessagePayload) => {
            received.push({
              key: message.key?.toString() ?? '',
              eventType: JSON.parse(message.value!.toString()).eventType,
              partition,
            });
            if (received.length >= 4) {
              clearTimeout(timeout);
              resolve();
            }
          },
        })
        .catch(reject);
    });

    const forOrderA = received.filter((message) => message.key === orderA.id.value);
    const forOrderB = received.filter((message) => message.key === orderB.id.value);

    expect(forOrderA.map((message) => message.eventType)).toEqual(['order.placed.v1', 'order.confirmed.v1']);
    expect(forOrderB.map((message) => message.eventType)).toEqual(['order.placed.v1', 'order.confirmed.v1']);

    // One order's facts share one partition.
    expect(new Set(forOrderA.map((message) => message.partition)).size).toBe(1);
    expect(new Set(forOrderB.map((message) => message.partition)).size).toBe(1);
  }, 60_000);
});
