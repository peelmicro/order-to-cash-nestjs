// R17, R18, OI10 — the idempotent-consumer pattern against real MySQL
// (Testcontainers, mysql:8.4.11): dedup record + aggregate change + outbox
// records in one transaction; a redelivery mutates nothing; two concurrent
// deliveries apply the effect exactly once.
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/mysql2';
import { asc, eq } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Order } from '../../domain/order';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from '../persistence/order.repository';
import * as ordersSchema from '../persistence/schema/index';
import {
  startOrdersTestFixture,
  type OrdersTestFixture,
} from '../persistence/test-support/orders-test-fixture';
import { FakeClock } from '../persistence/test-support/fake-clock';
import { placeOrderInput } from '../outbox/test-support/order-factory';
import { IdempotentConsumer } from './idempotent-consumer';
import * as ordersMessagingSchema from '../persistence/schema/processed-events.schema';

describe('idempotent-consumer — R17, R18, OI10 (Testcontainers, mysql:8.4.11)', () => {
  let fixture: OrdersTestFixture;

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  async function placeAndConfirmablyLoadOrder(clock: FakeClock): Promise<{ order: Order; repository: DrizzleOrderRepository }> {
    const repository = new DrizzleOrderRepository(fixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);
    const order = Order.place(placeOrderInput(), { occurredAt: clock.now(), causationId: UniqueId.generate() });
    await unitOfWork.execute((tx) => repository.save(order, tx));
    return { order, repository };
  }

  it('records the eventId and consumer name in the same transaction as the state change and the outbox records', async () => {
    const clock = new FakeClock(new Date('2026-08-20T17:00:00.000Z'));
    const { order, repository } = await placeAndConfirmablyLoadOrder(clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);
    const idempotency = new IdempotentConsumer(unitOfWork, clock);
    const eventId = randomUUID();

    const outcome = await idempotency.runOnce(eventId, 'orders.saga', async (tx) => {
      const loaded = await repository.findById(order.id, tx);
      loaded!.markStockReserved({ occurredAt: clock.now(), causationId: UniqueId.generate() });
      loaded!.approveCredit({ occurredAt: clock.now(), causationId: UniqueId.generate() });
      loaded!.confirm({ occurredAt: clock.now(), causationId: UniqueId.generate() });
      await repository.save(loaded!, tx);
    });

    expect(outcome).toBe('processed');

    const [dedupRow] = await fixture.db
      .select()
      .from(ordersMessagingSchema.processedEvents)
      .where(eq(ordersMessagingSchema.processedEvents.eventId, eventId));
    expect(dedupRow?.consumer).toBe('orders.saga');

    const [orderRow] = await fixture.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, order.id.value));
    expect(orderRow?.status).toBe('confirmed');

    const outboxRows = await fixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value))
      .orderBy(asc(ordersSchema.outbox.seq));
    expect(outboxRows.map((row) => row.eventType)).toEqual(['order.placed.v1', 'order.confirmed.v1']);
  });

  it('a failure in work leaves no dedup row', async () => {
    const clock = new FakeClock(new Date('2026-08-20T17:10:00.000Z'));
    const { order, repository } = await placeAndConfirmablyLoadOrder(clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);
    const idempotency = new IdempotentConsumer(unitOfWork, clock);
    const eventId = randomUUID();

    await expect(
      idempotency.runOnce(eventId, 'orders.saga', async (tx) => {
        const loaded = await repository.findById(order.id, tx);
        loaded!.markStockReserved({ occurredAt: clock.now(), causationId: UniqueId.generate() });
        await repository.save(loaded!, tx);
        throw new Error('idempotent-consumer: forced failure inside work, after save');
      }),
    ).rejects.toThrow('forced failure inside work');

    const dedupRows = await fixture.db
      .select()
      .from(ordersMessagingSchema.processedEvents)
      .where(eq(ordersMessagingSchema.processedEvents.eventId, eventId));
    expect(dedupRows).toHaveLength(0);

    const [orderRow] = await fixture.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, order.id.value));
    expect(orderRow?.status).toBe('placed'); // unchanged — the whole tx rolled back
  });

  it('acknowledges a redelivered fact without mutating state, emitting a fact or issuing a command', async () => {
    const clock = new FakeClock(new Date('2026-08-20T17:20:00.000Z'));
    const { order, repository } = await placeAndConfirmablyLoadOrder(clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);
    const idempotency = new IdempotentConsumer(unitOfWork, clock);
    const eventId = randomUUID();

    const work = vi.fn(async (tx) => {
      const loaded = await repository.findById(order.id, tx);
      loaded!.markStockReserved({ occurredAt: clock.now(), causationId: UniqueId.generate() });
      await repository.save(loaded!, tx);
    });

    const first = await idempotency.runOnce(eventId, 'orders.saga', work);
    expect(first).toBe('processed');
    expect(work).toHaveBeenCalledTimes(1);

    const outboxCountBefore = (
      await fixture.db.select().from(ordersSchema.outbox).where(eq(ordersSchema.outbox.aggregateId, order.id.value))
    ).length;

    // Redelivery — the SAME eventId, the SAME consumer.
    const second = await idempotency.runOnce(eventId, 'orders.saga', work);
    expect(second).toBe('duplicate');
    expect(work).toHaveBeenCalledTimes(1); // NOT invoked a second time

    const [orderRow] = await fixture.db.select().from(ordersSchema.orders).where(eq(ordersSchema.orders.id, order.id.value));
    expect(orderRow?.status).toBe('stock_reserved'); // unchanged by the redelivery

    const outboxCountAfter = (
      await fixture.db.select().from(ordersSchema.outbox).where(eq(ordersSchema.outbox.aggregateId, order.id.value))
    ).length;
    expect(outboxCountAfter).toBe(outboxCountBefore); // no new fact
  });

  it('dedups per (eventId, consumer) pair, not per eventId — the same event processed by two different consumers both run', async () => {
    const clock = new FakeClock(new Date('2026-08-20T17:30:00.000Z'));
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);
    const idempotency = new IdempotentConsumer(unitOfWork, clock);
    const eventId = randomUUID();

    const sagaWork = vi.fn(async () => {});
    const projectorWork = vi.fn(async () => {});

    const sagaOutcome = await idempotency.runOnce(eventId, 'orders.saga', sagaWork);
    const projectorOutcome = await idempotency.runOnce(eventId, 'projector', projectorWork);

    expect(sagaOutcome).toBe('processed');
    expect(projectorOutcome).toBe('processed');
    expect(sagaWork).toHaveBeenCalledTimes(1);
    expect(projectorWork).toHaveBeenCalledTimes(1);

    const dedupRows = await fixture.db
      .select()
      .from(ordersMessagingSchema.processedEvents)
      .where(eq(ordersMessagingSchema.processedEvents.eventId, eventId));
    expect(dedupRows.map((row) => row.consumer).sort()).toEqual(['orders.saga', 'projector']);

    // The redelivery guard STILL holds per pair.
    const sagaRedelivery = await idempotency.runOnce(eventId, 'orders.saga', sagaWork);
    expect(sagaRedelivery).toBe('duplicate');
    expect(sagaWork).toHaveBeenCalledTimes(1);
  });

  it('applies the handler\'s effects once when the same event is delivered concurrently to two consumers', async () => {
    const clock = new FakeClock(new Date('2026-08-20T17:40:00.000Z'));
    const { order } = await placeAndConfirmablyLoadOrder(clock);
    const eventId = randomUUID();

    // Two IdempotentConsumer instances on SEPARATE connections.
    const poolA = mysql.createPool({
      host: fixture.container.getHost(),
      port: fixture.container.getPort(),
      user: fixture.container.getUsername(),
      password: fixture.container.getUserPassword(),
      database: fixture.container.getDatabase(),
      timezone: 'Z',
    });
    const poolB = mysql.createPool({
      host: fixture.container.getHost(),
      port: fixture.container.getPort(),
      user: fixture.container.getUsername(),
      password: fixture.container.getUserPassword(),
      database: fixture.container.getDatabase(),
      timezone: 'Z',
    });
    const dbA = drizzle(poolA, { schema: ordersSchema, mode: 'default' });
    const dbB = drizzle(poolB, { schema: ordersSchema, mode: 'default' });
    const repositoryA = new DrizzleOrderRepository(dbA, clock);
    const repositoryB = new DrizzleOrderRepository(dbB, clock);
    const consumerA = new IdempotentConsumer(new DrizzleUnitOfWork(dbA), clock);
    const consumerB = new IdempotentConsumer(new DrizzleUnitOfWork(dbB), clock);

    const effects: string[] = [];

    try {
      const [outcomeA, outcomeB] = await Promise.all([
        consumerA.runOnce(eventId, 'orders.saga', async (tx) => {
          effects.push('A');
          const loaded = await repositoryA.findById(order.id, tx);
          loaded!.markStockReserved({ occurredAt: clock.now(), causationId: UniqueId.generate() });
          await repositoryA.save(loaded!, tx);
        }),
        consumerB.runOnce(eventId, 'orders.saga', async (tx) => {
          effects.push('B');
          const loaded = await repositoryB.findById(order.id, tx);
          loaded!.markStockReserved({ occurredAt: clock.now(), causationId: UniqueId.generate() });
          await repositoryB.save(loaded!, tx);
        }),
      ]);

      const outcomes = [outcomeA, outcomeB].sort();
      expect(outcomes).toEqual(['duplicate', 'processed']);
      expect(effects).toHaveLength(1);

      const dedupRows = await fixture.db
        .select()
        .from(ordersMessagingSchema.processedEvents)
        .where(eq(ordersMessagingSchema.processedEvents.eventId, eventId));
      expect(dedupRows).toHaveLength(1);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  }, 30_000);
});
