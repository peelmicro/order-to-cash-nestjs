// R12, OI1 — the envelope's causal metadata is durable, not thrown away at
// persistence time (inherited advisory 1). Real MySQL (Testcontainers,
// mysql:8.4.11).
import { eq } from 'drizzle-orm';
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order, type PlaceOrderInput } from '../../domain/order';
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
import { outboxRowToEnvelope } from './outbox-envelope-mapper';

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

describe('outbox-envelope — R12, OI1 (Testcontainers, mysql:8.4.11)', () => {
  let fixture: OrdersTestFixture;

  beforeAll(async () => {
    fixture = await startOrdersTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  it('stamps every fact of one order with the order id as correlationId and the causing event id as causationId', async () => {
    const clock = new FakeClock(new Date('2026-08-20T10:00:00.000Z'));
    const repository = new DrizzleOrderRepository(fixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);

    const rootCommandId = UniqueId.generate();
    const input = placeInput();
    const order = Order.place(input, { occurredAt: clock.now(), causationId: rootCommandId });

    await unitOfWork.execute((tx) => repository.save(order, tx));

    const [placedRow] = await fixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(placedRow?.eventType).toBe('order.placed.v1');
    expect(placedRow?.correlationId).toBe(order.id.value);
    expect(placedRow?.causationId).toBe(rootCommandId.value);

    // Second transition — the second fact's causationId is the eventId the
    // transition was given (design.md §4.4's causal-chain promise).
    order.markStockReserved({ occurredAt: clock.now(), causationId: UniqueId.generate() });
    order.approveCredit({ occurredAt: clock.now(), causationId: UniqueId.generate() });
    const confirmCausationId = UniqueId.from(placedRow!.eventId);
    order.confirm({ occurredAt: clock.now(), causationId: confirmCausationId });

    await unitOfWork.execute((tx) => repository.save(order, tx));

    const outboxRows = await fixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));

    expect(outboxRows).toHaveLength(2);
    const confirmedRow = outboxRows.find((row) => row.eventType === 'order.confirmed.v1');
    expect(confirmedRow?.correlationId).toBe(order.id.value);
    expect(confirmedRow?.causationId).toBe(placedRow!.eventId);
    for (const row of outboxRows) {
      expect(row.correlationId).toBe(order.id.value);
    }
  });

  it('reconstructs the complete envelope from the stored record alone, inferring no field at publication time', async () => {
    const clock = new FakeClock(new Date('2026-08-20T11:00:00.000Z'));
    const repository = new DrizzleOrderRepository(fixture.db, clock);
    const unitOfWork = new DrizzleUnitOfWork(fixture.db);

    const rootCommandId = UniqueId.generate();
    const input = placeInput();
    const order = Order.place(input, { occurredAt: clock.now(), causationId: rootCommandId });

    await unitOfWork.execute((tx) => repository.save(order, tx));

    const [row] = await fixture.db
      .select()
      .from(ordersSchema.outbox)
      .where(eq(ordersSchema.outbox.aggregateId, order.id.value));
    expect(row).toBeDefined();

    const envelope = outboxRowToEnvelope(row!);

    // All seven envelope fields survive the round trip.
    expect(envelope.eventId).toBe(row!.eventId);
    expect(envelope.eventType).toBe('order.placed.v1');
    expect(envelope.aggregateId).toBe(order.id.value);
    expect(envelope.correlationId).toBe(order.id.value);
    expect(envelope.causationId).toBe(rootCommandId.value);
    expect(envelope.occurredAt).toBe(row!.occurredAt.toISOString());
    expect(envelope.payload).toEqual(row!.payload);

    // A record missing an envelope field cannot even be committed —
    // NOT NULL at the schema level (A1). Proven here as a defensive belt:
    // the mapper itself refuses to synthesise a missing field.
    expect(() =>
      outboxRowToEnvelope({ ...row!, causationId: null as unknown as string }),
    ).toThrow(/missing envelope field/);
  });
});
