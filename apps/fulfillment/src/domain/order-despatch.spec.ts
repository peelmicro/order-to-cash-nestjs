// Pure unit — no framework, no DB, no clock. R36 domain half: consuming the
// order's `reserved` reservations across its items, building the
// `DespatchAdvice` and its one `order.despatched.v1` fact (F6/F7), and the
// defensive `no_reservations` branch the caller is expected never to reach
// in practice (fulfillment_despatch feature — matrix name `order-despatch.spec`).
import { DespatchReference, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { createDespatchForOrder, type CreateDespatchInput } from './order-despatch.js';
import { StockItem, type StockContext } from './stock-item.js';
import type { StockItemSnapshot } from './stock-item-snapshot.js';
import type { ReservationSnapshot } from './reservation.js';
import { ReservationTerminalError } from './stock-errors.js';

const ORDER = OrderNumber.fromSequence(1);
const DESPATCH_REFERENCE = DespatchReference.fromSequence(1);

function ctx(): StockContext {
  return { occurredAt: new Date('2026-08-22T10:00:00.000Z'), causationId: UniqueId.generate() };
}

function stockItem(overrides: Partial<StockItemSnapshot> = {}): StockItem {
  const snapshot: StockItemSnapshot = {
    id: UniqueId.generate(),
    companyCode: 'COM-0001',
    productCode: 'PRD-0001',
    units: 10,
    reservedUnits: 0,
    lowStockThreshold: 2,
    reservations: [],
    ...overrides,
  };
  return StockItem.reconstitute(snapshot);
}

function reservationSnapshot(overrides: Partial<ReservationSnapshot> = {}): ReservationSnapshot {
  return {
    id: UniqueId.generate(),
    orderReference: ORDER,
    companyCode: 'COM-0001',
    retailerCode: 'RET-0001',
    productCode: 'PRD-0001',
    units: Quantity.of(3),
    status: 'reserved',
    ...overrides,
  };
}

function baseInput(overrides: Partial<CreateDespatchInput> = {}): CreateDespatchInput {
  return {
    orderReference: ORDER,
    companyCode: 'COM-0001',
    retailerCode: 'RET-0001',
    correlationId: UniqueId.generate(),
    ...overrides,
  };
}

describe('order-despatch.spec — R36', () => {
  it('consumes every reserved reservation of the order across two items, moves them to consumed, and creates one DespatchAdvice with one fact', () => {
    const reservationA = reservationSnapshot({ productCode: 'PRD-0001', units: Quantity.of(3) });
    const reservationB = reservationSnapshot({ productCode: 'PRD-0002', units: Quantity.of(5) });
    const itemA = stockItem({
      productCode: 'PRD-0001',
      units: 10,
      reservedUnits: 3,
      reservations: [reservationA],
    });
    const itemB = stockItem({
      productCode: 'PRD-0002',
      units: 10,
      reservedUnits: 5,
      reservations: [reservationB],
    });

    const outcome = createDespatchForOrder(
      [itemA, itemB],
      baseInput(),
      DESPATCH_REFERENCE,
      ctx(),
      () => UniqueId.generate(),
    );

    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.despatch.lines).toEqual([
      { productCode: 'PRD-0001', units: Quantity.of(3) },
      { productCode: 'PRD-0002', units: Quantity.of(5) },
    ]);

    // F7 — units despatched equal units reserved, and units/reservedUnits both drop (StockItem.consume, feature 17).
    expect(itemA.units).toBe(7);
    expect(itemA.reservedUnits).toBe(0);
    expect(itemA.reservations[0]?.status).toBe('consumed');
    expect(itemB.units).toBe(5);
    expect(itemB.reservedUnits).toBe(0);
    expect(itemB.reservations[0]?.status).toBe('consumed');

    const despatchEvents = outcome.despatch.pullDomainEvents();
    expect(despatchEvents).toHaveLength(1);
    expect(despatchEvents[0]?.eventType).toBe('order.despatched.v1');

    // StockItem.consume itself emits nothing (design.md §3.1: "order.despatched.v1 is feature 18's DespatchAdvice fact").
    expect(itemA.pullDomainEvents()).toHaveLength(0);
    expect(itemB.pullDomainEvents()).toHaveLength(0);
  });

  it('defensive: no_reservations when no item holds a reserved reservation of the order', () => {
    const item = stockItem({
      productCode: 'PRD-0001',
      units: 10,
      reservedUnits: 0,
      reservations: [],
    });

    const outcome = createDespatchForOrder([item], baseInput(), DESPATCH_REFERENCE, ctx(), () =>
      UniqueId.generate(),
    );

    expect(outcome).toEqual({ kind: 'no_reservations' });
  });

  it('F4 — propagates ReservationTerminalError when a matched reservation is already released, and mutates nothing on that item', () => {
    const released = reservationSnapshot({ status: 'released' });
    const item = stockItem({ reservedUnits: 0, reservations: [released] });

    expect(() =>
      createDespatchForOrder([item], baseInput(), DESPATCH_REFERENCE, ctx(), () =>
        UniqueId.generate(),
      ),
    ).toThrow(ReservationTerminalError);
    expect(item.reservations[0]?.status).toBe('released');
  });
});
