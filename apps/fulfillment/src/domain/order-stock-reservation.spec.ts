// Pure unit — no framework, no DB, no clock. `describe('reservation-release')`
// carries the R34 domain case (matrix name: `reservation-release.spec`) and
// the F5 no-op; FS8 (unknown product); FS13 (the carrier-aggregate rule);
// the three-item short-order case; the repeated-product-sums-for-
// availability case.
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { releaseOrderStock, reserveOrderStock, type ReserveOrderInput } from './order-stock-reservation.js';
import { StockItem, type StockContext } from './stock-item.js';
import type { StockItemSnapshot } from './stock-item-snapshot.js';
import type { ReservationSnapshot } from './reservation.js';

const ORDER = OrderNumber.fromSequence(1);

function ctx(): StockContext {
  return { occurredAt: new Date('2026-08-21T10:00:00.000Z'), causationId: UniqueId.generate() };
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

function baseInput(overrides: Partial<ReserveOrderInput> = {}): ReserveOrderInput {
  return {
    orderReference: ORDER,
    companyCode: 'COM-0001',
    retailerCode: 'RET-0001',
    lines: [{ productCode: 'PRD-0001', units: Quantity.of(3) }],
    correlationId: UniqueId.generate(),
    ...overrides,
  };
}

describe('reservation-release', () => {
  it('releases the reservations, decreases reservedUnits and emits exactly one stock.released.v1', () => {
    const reserved = reservationSnapshot({ units: Quantity.of(4) });
    const item = stockItem({ reservedUnits: 4, reservations: [reserved] });

    const outcome = releaseOrderStock(
      [item],
      { orderReference: ORDER, companyCode: 'COM-0001', reason: 'credit_rejected', correlationId: UniqueId.generate() },
      ctx(),
    );

    expect(outcome.kind).toBe('released');
    if (outcome.kind !== 'released') throw new Error('unreachable');
    expect(outcome.released).toHaveLength(1);
    expect(item.reservedUnits).toBe(0);
    expect(item.reservations[0]?.status).toBe('released');

    const events = item.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('stock.released.v1');
  });

  it('F5 — releasing an order whose reservations are all already released is a success no-op: no counter change, no fact', () => {
    const alreadyReleased = reservationSnapshot({ status: 'released', units: Quantity.of(4) });
    const item = stockItem({ reservedUnits: 0, reservations: [alreadyReleased] });

    const outcome = releaseOrderStock(
      [item],
      { orderReference: ORDER, companyCode: 'COM-0001', reason: 'credit_rejected', correlationId: UniqueId.generate() },
      ctx(),
    );

    expect(outcome).toEqual({ kind: 'already_released' });
    expect(item.reservedUnits).toBe(0);
    expect(item.pullDomainEvents()).toHaveLength(0);
  });
});

describe('order-stock-reservation.spec — FS8', () => {
  it('rejects the whole order with reason unknown_product and available 0 when any line names a product the company does not stock', () => {
    const knownItem = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    const input = baseInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(2) },
        { productCode: 'PRD-9999', units: Quantity.of(1) },
      ],
    });

    const outcome = reserveOrderStock([knownItem], input, ctx(), () => UniqueId.generate());

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toBe('unknown_product');
    expect(outcome.shortages).toContainEqual({ productCode: 'PRD-9999', requested: 1, available: 0 });
    expect(knownItem.reservedUnits).toBe(0);
    expect(knownItem.reservations).toHaveLength(0);
  });

  it('replies with no carrier when NO line resolves to a known item', () => {
    const input = baseInput({ lines: [{ productCode: 'PRD-9999', units: Quantity.of(1) }] });

    const outcome = reserveOrderStock([], input, ctx(), () => UniqueId.generate());

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('unreachable');
    expect(outcome.carrier).toBeNull();
  });
});

describe('order-stock-reservation.spec — FS13', () => {
  it('stamps aggregateId with the first known line\'s stock item on stock.reserved.v1 and stock.rejected.v1, and the first released reservation\'s item on stock.released.v1', () => {
    const itemA = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    const itemB = stockItem({ productCode: 'PRD-0002', units: 10, reservedUnits: 0 });
    const reserveInput = baseInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(2) },
        { productCode: 'PRD-0002', units: Quantity.of(3) },
      ],
    });

    const reserved = reserveOrderStock([itemA, itemB], reserveInput, ctx(), () => UniqueId.generate());
    expect(reserved.kind).toBe('reserved');
    if (reserved.kind !== 'reserved') throw new Error('unreachable');
    expect(reserved.carrier.id.equals(itemA.id)).toBe(true);
    const reservedEvent = itemA.pullDomainEvents()[0];
    itemB.pullDomainEvents();
    expect(reservedEvent?.aggregateId.equals(itemA.id)).toBe(true);

    // Rejected — carrier is still the first KNOWN line's item, even though it is itemB this time.
    const itemC = stockItem({ productCode: 'PRD-0003', units: 1, reservedUnits: 0 });
    const rejectInput = baseInput({
      lines: [
        { productCode: 'PRD-9999', units: Quantity.of(1) },
        { productCode: 'PRD-0003', units: Quantity.of(5) },
      ],
    });
    const rejected = reserveOrderStock([itemC], rejectInput, ctx(), () => UniqueId.generate());
    expect(rejected.kind).toBe('rejected');
    if (rejected.kind !== 'rejected') throw new Error('unreachable');
    expect(rejected.carrier?.id.equals(itemC.id)).toBe(true);

    // Released — carrier is the item of the FIRST released reservation, in item-array order.
    const releasedResA = reservationSnapshot({ productCode: 'PRD-0002', units: Quantity.of(1) });
    const releasedResB = reservationSnapshot({ productCode: 'PRD-0001', units: Quantity.of(1) });
    const releaseItemA = stockItem({ productCode: 'PRD-0002', reservedUnits: 1, reservations: [releasedResA] });
    const releaseItemB = stockItem({ productCode: 'PRD-0001', reservedUnits: 1, reservations: [releasedResB] });
    const releaseOutcome = releaseOrderStock(
      [releaseItemA, releaseItemB],
      { orderReference: ORDER, companyCode: 'COM-0001', reason: 'order_cancelled', correlationId: UniqueId.generate() },
      ctx(),
    );
    expect(releaseOutcome.kind).toBe('released');
    if (releaseOutcome.kind !== 'released') throw new Error('unreachable');
    expect(releaseOutcome.carrier.id.equals(releaseItemA.id)).toBe(true);
  });
});

describe('order-stock-reservation.spec — three-item order with the third line short', () => {
  it('creates zero reservations on all three items and emits one stock.rejected.v1 naming only the short line', () => {
    const itemA = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    const itemB = stockItem({ productCode: 'PRD-0002', units: 10, reservedUnits: 0 });
    const itemC = stockItem({ productCode: 'PRD-0003', units: 2, reservedUnits: 0 });
    const input = baseInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(3) },
        { productCode: 'PRD-0002', units: Quantity.of(4) },
        { productCode: 'PRD-0003', units: Quantity.of(5) },
      ],
    });

    const outcome = reserveOrderStock([itemA, itemB, itemC], input, ctx(), () => UniqueId.generate());

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('unreachable');
    expect(outcome.shortages).toEqual([{ productCode: 'PRD-0003', requested: 5, available: 2 }]);
    for (const item of [itemA, itemB, itemC]) {
      expect(item.reservedUnits).toBe(0);
      expect(item.reservations).toHaveLength(0);
    }
    const events = [itemA, itemB, itemC].flatMap((item) => item.pullDomainEvents());
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('stock.rejected.v1');
  });
});

describe('order-stock-reservation.spec — a repeated product on two lines', () => {
  it('sums for availability and yields two reservations', () => {
    const item = stockItem({ productCode: 'PRD-0001', units: 5, reservedUnits: 0 });
    const input = baseInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(2) },
        { productCode: 'PRD-0001', units: Quantity.of(3) },
      ],
    });

    const outcome = reserveOrderStock([item], input, ctx(), () => UniqueId.generate());

    expect(outcome.kind).toBe('reserved');
    if (outcome.kind !== 'reserved') throw new Error('unreachable');
    expect(outcome.reservations).toHaveLength(2);
    expect(item.reservations).toHaveLength(2);
    expect(item.reservedUnits).toBe(5);
  });

  it('rejects the whole order when the summed request for the repeated product exceeds availability', () => {
    const item = stockItem({ productCode: 'PRD-0001', units: 4, reservedUnits: 0 });
    const input = baseInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(2) },
        { productCode: 'PRD-0001', units: Quantity.of(3) },
      ],
    });

    const outcome = reserveOrderStock([item], input, ctx(), () => UniqueId.generate());

    expect(outcome.kind).toBe('rejected');
    expect(item.reservedUnits).toBe(0);
    expect(item.reservations).toHaveLength(0);
  });
});
