// R14, OI2, OI3, OI8 — the relay's poll/claim/publish/stamp cycle against
// real MySQL (Testcontainers, mysql:8.4.11) AND real Kafka (Testcontainers,
// apache/kafka:4.3.1 — the same pinned tag docker-compose.infra.yml uses).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { UniqueId } from '@otc/shared-kernel';
import { Kafka, type Consumer } from 'kafkajs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Order } from '../../domain/order';
import type { FactPublisher, PublishableFact } from '../../application/ports/fact-publisher.port';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from '../persistence/order.repository';
import * as ordersSchema from '../persistence/schema/index';
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

/** Delegates to a real publisher but rejects the first `failTimes` calls — proves the relay's own claim/stamp logic against a REAL eventual publish, not a fully synthetic one. */
class FlakyFactPublisher implements FactPublisher {
  private calls = 0;
  constructor(private readonly delegate: FactPublisher, private readonly failTimes: number) {}

  async publish(facts: readonly PublishableFact[]): Promise<void> {
    this.calls++;
    if (this.calls <= this.failTimes) {
      throw new Error(`FlakyFactPublisher: synthetic failure #${this.calls}`);
    }
    await this.delegate.publish(facts);
  }
}

class RejectingFactPublisher implements FactPublisher {
  async publish(): Promise<void> {
    throw new Error('RejectingFactPublisher: always rejects');
  }
}

/** Never settles — simulates a broker that accepted the TCP connection but never acknowledges (D1: the claim transaction must be bounded by `OUTBOX_PUBLISH_TIMEOUT_MS`, not left open indefinitely). */
class HangingFactPublisher implements FactPublisher {
  publish(): Promise<void> {
    return new Promise<void>(() => {
      /* never resolves, never rejects */
    });
  }
}

describe('outbox-relay — R14, OI2, OI3, OI8 (Testcontainers, mysql:8.4.11 + apache/kafka:4.3.1)', () => {
  let mysqlFixture: OrdersTestFixture;
  let kafkaFixture: KafkaTestFixture;
  let realPublisher: KafkaFactPublisher;
  const consumers: Consumer[] = [];

  beforeAll(async () => {
    [mysqlFixture, kafkaFixture] = await Promise.all([startOrdersTestFixture(), startKafkaTestFixture()]);
    await createTopic(kafkaFixture.brokers, ORDERS_FACTS_TOPIC);
    realPublisher = new KafkaFactPublisher(createKafkaClient({ brokers: kafkaFixture.brokers, clientId: 'otc-orders-test' }));
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

  // The topic accumulates messages across every `it()` in this file (one
  // shared Kafka fixture, `fromBeginning: true` on every fresh consumer
  // group) — so every consumer here filters by the ONE order id under
  // test, rather than trusting that the first N messages on the topic
  // happen to be its own.
  async function consumeForKey(key: string, n: number, groupId: string): Promise<{ key: string; value: string }[]> {
    const kafka = new Kafka({ clientId: 'otc-orders-test-consumer', brokers: [...kafkaFixture.brokers] });
    const consumer = kafka.consumer({ groupId });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: ORDERS_FACTS_TOPIC, fromBeginning: true });

    const received: { key: string; value: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`consumeForKey: timed out waiting for ${n} message(s) keyed ${key}`)), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            const messageKey = message.key?.toString() ?? '';
            if (messageKey !== key) {
              return;
            }
            received.push({ key: messageKey, value: message.value?.toString() ?? '' });
            if (received.length >= n) {
              clearTimeout(timeout);
              resolve();
            }
          },
        })
        .catch(reject);
    });
    return received;
  }

  it('stamps a record only after the broker acknowledgement and republishes an unstamped record on the next poll', async () => {
    const clock = new FakeClock(new Date('2026-08-20T10:00:00.000Z'));
    const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const input = placeOrderInput();
    const order = Order.place(input, { occurredAt: clock.now(), causationId: UniqueId.generate() });
    await unitOfWork.execute((tx) => repository.save(order, tx));

    const flakyPublisher = new FlakyFactPublisher(realPublisher, 1);
    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: flakyPublisher,
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });

    // First poll: the (synthetic) broker rejection leaves the record unstamped.
    const first = await relay.runOnce();
    expect(first.claimed).toBe(1);
    expect(first.published).toBe(0);

    const [rowAfterFirstPoll] = await mysqlFixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(rowAfterFirstPoll?.publishedAt).toBeNull();

    // Second poll: republishes the SAME record — this time the broker (a
    // real one) acknowledges, and only then is it stamped.
    const second = await relay.runOnce();
    expect(second.claimed).toBe(1);
    expect(second.published).toBe(1);

    const [rowAfterSecondPoll] = await mysqlFixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(rowAfterSecondPoll?.publishedAt).not.toBeNull();

    const received = await consumeForKey(order.id.value, 1, `r14-${randomUUID()}`);
    expect(received[0]?.key).toBe(order.id.value);
    expect(JSON.parse(received[0]!.value).eventId).toBe(rowAfterSecondPoll!.eventId);
  }, 60_000);

  it('publishes two records written by one transaction in append order although both carry the same occurred_at', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const clock = new FakeClock(new Date('2026-08-20T11:00:00.000Z'));
      const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
      const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
      const input = placeOrderInput();
      const sameInstant = new Date('2026-08-20T12:00:00.000Z');

      const order = Order.place(input, { occurredAt: sameInstant, causationId: UniqueId.generate() });
      order.markStockReserved({ occurredAt: sameInstant, causationId: UniqueId.generate() });
      order.approveCredit({ occurredAt: sameInstant, causationId: UniqueId.generate() });
      order.confirm({ occurredAt: sameInstant, causationId: UniqueId.generate() });

      // Both order.placed.v1 and order.confirmed.v1 are still uncommitted
      // on this ONE aggregate instance — one save() call, one transaction.
      await unitOfWork.execute((tx) => repository.save(order, tx));

      const relay = new OutboxRelay({
        db: mysqlFixture.db,
        publisher: realPublisher,
        clock,
        config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
      });
      const result = await relay.runOnce();
      expect(result.published).toBe(2);

      const received = await consumeForKey(order.id.value, 2, `oi2-${randomUUID()}`);
      const eventTypes = received.map((message) => JSON.parse(message.value).eventType as string);
      expect(eventTypes).toEqual(['order.placed.v1', 'order.confirmed.v1']);
    }
  }, 90_000);

  it('publishes a lower-sequence record that committed after a higher-sequence record was already published', async () => {
    const connA = await mysqlFixture.pool.getConnection();
    const connB = await mysqlFixture.pool.getConnection();
    try {
      const now = new Date('2026-08-20T13:00:00.000Z');
      const aggregateId = randomUUID();
      const rowA = {
        id: randomUUID(),
        eventId: randomUUID(),
        eventType: 'order.placed.v1',
        aggregateId,
        correlationId: aggregateId,
        causationId: randomUUID(),
        payload: JSON.stringify({ orderReference: 'ORD-900001' }),
        occurredAt: now,
        createdAt: now,
      };
      const rowB = {
        id: randomUUID(),
        eventId: randomUUID(),
        eventType: 'order.confirmed.v1',
        aggregateId,
        correlationId: aggregateId,
        causationId: randomUUID(),
        payload: JSON.stringify({ orderReference: 'ORD-900001' }),
        occurredAt: now,
        createdAt: now,
      };

      await connA.beginTransaction();
      await connA.query(
        `INSERT INTO outbox (id, event_id, event_type, aggregate_id, correlation_id, causation_id, payload, occurred_at, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [rowA.id, rowA.eventId, rowA.eventType, rowA.aggregateId, rowA.correlationId, rowA.causationId, rowA.payload, rowA.occurredAt, rowA.createdAt],
      );
      // rowA now holds the LOWER seq (inserted first) but stays uncommitted.

      await connB.beginTransaction();
      await connB.query(
        `INSERT INTO outbox (id, event_id, event_type, aggregate_id, correlation_id, causation_id, payload, occurred_at, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [rowB.id, rowB.eventId, rowB.eventType, rowB.aggregateId, rowB.correlationId, rowB.causationId, rowB.payload, rowB.occurredAt, rowB.createdAt],
      );
      await connB.commit(); // rowB (HIGHER seq) commits FIRST.

      const relay = new OutboxRelay({
        db: mysqlFixture.db,
        publisher: realPublisher,
        clock: new FakeClock(now),
        config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
      });

      const firstPoll = await relay.runOnce();
      const firstPollAggregateRows = (
        await mysqlFixture.db.select().from(ordersSchema.outbox).where(eq(ordersSchema.outbox.aggregateId, aggregateId))
      ).filter((row) => row.publishedAt !== null);
      expect(firstPollAggregateRows.map((row) => row.eventId)).toEqual([rowB.eventId]);
      expect(firstPoll.published).toBeGreaterThanOrEqual(1);

      await connA.commit(); // rowA (LOWER seq) commits SECOND — now visible.

      const secondPoll = await relay.runOnce();
      expect(secondPoll.claimed).toBeGreaterThanOrEqual(1);

      const rowsAfter = await mysqlFixture.db
        .select()
        .from(ordersSchema.outbox)
        .where(eq(ordersSchema.outbox.aggregateId, aggregateId));
      // Both rows end up published — the late-committing lower-seq record
      // was found on a LATER poll, never skipped (OI3).
      expect(rowsAfter.every((row) => row.publishedAt !== null)).toBe(true);
      expect(rowsAfter.map((row) => row.eventId).sort()).toEqual([rowA.eventId, rowB.eventId].sort());
    } finally {
      connA.release();
      connB.release();
    }
  }, 60_000);

  it('leaves every record of a rejected batch unstamped and republishes the same records on the next poll', async () => {
    const clock = new FakeClock(new Date('2026-08-20T14:00:00.000Z'));
    const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const input = placeOrderInput();
    const order = Order.place(input, { occurredAt: clock.now(), causationId: UniqueId.generate() });
    await unitOfWork.execute((tx) => repository.save(order, tx));

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: new RejectingFactPublisher(),
      clock,
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 5000 },
    });

    const first = await relay.runOnce();
    expect(first.claimed).toBe(1);
    expect(first.published).toBe(0);

    const second = await relay.runOnce();
    expect(second.claimed).toBe(1);
    expect(second.published).toBe(0);

    const rows = await mysqlFixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publishedAt).toBeNull();
  }, 60_000);

  it('bounds the open claim transaction by OUTBOX_PUBLISH_TIMEOUT_MS (design.md §5.2, defect D1) instead of holding it open indefinitely against a publisher that never settles', async () => {
    const clock = new FakeClock(new Date('2026-08-20T15:00:00.000Z'));
    const repository = new DrizzleOrderRepository(mysqlFixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(mysqlFixture.db);
    const input = placeOrderInput();
    const order = Order.place(input, { occurredAt: clock.now(), causationId: UniqueId.generate() });
    await unitOfWork.execute((tx) => repository.save(order, tx));

    const relay = new OutboxRelay({
      db: mysqlFixture.db,
      publisher: new HangingFactPublisher(),
      clock,
      // A short bound so the test itself stays fast — proves the VALUE is
      // actually enforced, not merely parsed (D1: it was loaded into
      // OutboxRelayConfig but never read by the relay's own publish call).
      config: { enabled: true, pollIntervalMs: 0, batchSize: 10, publishTimeoutMs: 300 },
    });

    const startedAt = Date.now();
    const result = await relay.runOnce();
    const elapsedMs = Date.now() - startedAt;

    // >= 1, not === 1: this describe block shares one MySQL fixture across
    // every `it()`, and an earlier test ("leaves every record of a
    // rejected batch unstamped...") deliberately leaves its own row
    // unpublished forever — this poll's batch legitimately claims that
    // one too. What THIS test proves is the bound on elapsed time and that
    // NOTHING in the batch got stamped, not the exact batch size.
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.published).toBe(0);
    // Bounded by the configured timeout, not by the test's own 60s hook
    // timeout — proves the transaction did not stay open indefinitely.
    expect(elapsedMs).toBeLessThan(5_000);

    const rows = await mysqlFixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(rows[0]?.publishedAt).toBeNull();
  }, 60_000);
});
