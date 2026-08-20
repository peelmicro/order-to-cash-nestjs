// R13, OI9 — the transactional outbox's core guarantee: the aggregate row
// and its outbox rows commit together, or neither does. Real MySQL
// (Testcontainers, mysql:8.4.11), a real `Order.place(...)`, the real
// `DrizzleUnitOfWork` + `DrizzleOrderRepository`.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order, type PlaceOrderInput, type TransitionContext } from '../../domain/order';
import { DrizzleUnitOfWork } from '../persistence/drizzle-unit-of-work';
import { DrizzleOrderRepository } from '../persistence/order.repository';
import * as ordersSchema from '../persistence/schema/index';
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_CURRENCY,
  FIXTURE_PRODUCT_CODE,
  FIXTURE_RETAILER_CODE,
  startOrdersTestFixture,
  type OrdersTestFixture,
} from '../persistence/test-support/orders-test-fixture';
import { FakeClock } from '../persistence/test-support/fake-clock';

function placeInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(Math.floor(Math.random() * 900_000) + 1),
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    buyer: { gln: GLN.of('5412345000013'), code: FIXTURE_RETAILER_CODE },
    supplier: { gln: GLN.of('5412345000037'), code: FIXTURE_COMPANY_CODE },
    currency: FIXTURE_CURRENCY,
    lines: [
      {
        productCode: FIXTURE_PRODUCT_CODE,
        description: 'Widget',
        quantity: Quantity.of(2),
        unitPrice: Money.of(1_000, FIXTURE_CURRENCY),
        lineDiscount: Money.of(0, FIXTURE_CURRENCY),
      },
    ],
    ...overrides,
  };
}

function ctx(): TransitionContext {
  return { occurredAt: new Date('2026-08-20T10:00:00.000Z'), causationId: UniqueId.generate() };
}

describe('outbox-atomicity — R13, OI9 (Testcontainers, mysql:8.4.11)', () => {
  let fixture: OrdersTestFixture;

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  it('persists neither the aggregate nor the outbox record and publishes nothing when the transaction fails', async () => {
    const clock = new FakeClock(new Date('2026-08-20T11:00:00.000Z'));
    const repository = new DrizzleOrderRepository(fixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);

    const input = placeInput();
    const order = Order.place(input, ctx());

    await expect(
      unitOfWork.execute(async (tx) => {
        await repository.save(order, tx);
        throw new Error('outbox-atomicity: forced failure AFTER save, still inside the unit of work');
      }),
    ).rejects.toThrow('forced failure AFTER save');

    const [orderRows, outboxRows] = await Promise.all([
      fixture.db.select().from(ordersSchema.orders),
      fixture.db.select().from(ordersSchema.outbox),
    ]);

    expect(orderRows.filter((row) => row.id === order.id.value)).toHaveLength(0);
    expect(outboxRows.filter((row) => row.aggregateId === order.id.value)).toHaveLength(0);
  });

  it('produces exactly one outbox record per fact when the operation is retried after a rolled-back unit of work', async () => {
    const clock = new FakeClock(new Date('2026-08-20T12:00:00.000Z'));
    const repository = new DrizzleOrderRepository(fixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);

    const input = placeInput();

    // First attempt: place, save, then a synthetic failure rolls everything back.
    // pullDomainEvents() is destructive (design.md §4.4) — a naive retry off
    // the SAME in-memory Order instance would now have zero events left and
    // would silently commit an aggregate row with no fact. The rule this
    // test proves: re-derive the aggregate for the retry.
    const firstAttempt = Order.place(input, ctx());
    await expect(
      unitOfWork.execute(async (tx) => {
        await repository.save(firstAttempt, tx);
        throw new Error('outbox-atomicity: forced rollback of the first attempt');
      }),
    ).rejects.toThrow('forced rollback');

    // Retry: RE-DERIVE the aggregate (new Order.place call), not the
    // drained `firstAttempt` instance.
    const retryOrder = Order.place(input, ctx());
    await unitOfWork.execute(async (tx) => {
      await repository.save(retryOrder, tx);
    });

    const [orderRows, outboxRows] = await Promise.all([
      fixture.db.select().from(ordersSchema.orders),
      fixture.db.select().from(ordersSchema.outbox),
    ]);

    const persistedOrderRows = orderRows.filter((row) => row.id === retryOrder.id.value);
    const persistedOutboxRows = outboxRows.filter((row) => row.aggregateId === retryOrder.id.value);

    expect(persistedOrderRows).toHaveLength(1);
    // Order.place emits exactly one order.placed.v1 fact.
    expect(persistedOutboxRows).toHaveLength(1);
    expect(persistedOutboxRows[0]?.eventType).toBe('order.placed.v1');
  });
});
