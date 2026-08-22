// Pure unit — no framework, no DB, no clock (CLAUDE.md § Testing
// conventions). The three matrix-named cases (specs/shared/test-matrix.md
// §4, verbatim) for R32/R33/R35, plus every illegal transition out of
// `released` and `consumed`.
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { reserveOrderStock, type ReserveOrderInput } from './order-stock-reservation.js';
import { Reservation } from './reservation.js';
import { ReservationTerminalError } from './stock-errors.js';
import { StockItem, type StockContext } from './stock-item.js';
import type { StockItemSnapshot } from './stock-item-snapshot.js';

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

function baseInput(overrides: Partial<ReserveOrderInput> = {}): ReserveOrderInput {
  return {
    orderReference: OrderNumber.fromSequence(1),
    companyCode: 'COM-0001',
    retailerCode: 'RET-0001',
    lines: [{ productCode: 'PRD-0001', units: Quantity.of(3) }],
    correlationId: UniqueId.generate(),
    ...overrides,
  };
}

describe('reservation.spec — R32', () => {
  it('creates one reservation per line, increases reservedUnits and emits exactly one stock.reserved.v1', () => {
    const itemA = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    const itemB = stockItem({ productCode: 'PRD-0002', units: 5, reservedUnits: 0 });
    const input = baseInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(3) },
        { productCode: 'PRD-0002', units: Quantity.of(2) },
      ],
    });

    const outcome = reserveOrderStock([itemA, itemB], input, ctx(), () => UniqueId.generate());

    expect(outcome.kind).toBe('reserved');
    if (outcome.kind !== 'reserved') throw new Error('unreachable');
    expect(outcome.reservations).toHaveLength(2);
    expect(itemA.reservedUnits).toBe(3);
    expect(itemB.reservedUnits).toBe(2);
    expect(itemA.reservations).toHaveLength(1);
    expect(itemB.reservations).toHaveLength(1);

    const eventsA = itemA.pullDomainEvents();
    const eventsB = itemB.pullDomainEvents();
    const allEvents = [...eventsA, ...eventsB];
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]?.eventType).toBe('stock.reserved.v1');
  });
});

describe('reservation.spec — R33', () => {
  it('creates no reservation at all and emits stock.rejected.v1 naming requested and available units when one line is short', () => {
    const itemA = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    const itemB = stockItem({ productCode: 'PRD-0002', units: 1, reservedUnits: 0 });
    const input = baseInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(3) },
        { productCode: 'PRD-0002', units: Quantity.of(5) },
      ],
    });

    const outcome = reserveOrderStock([itemA, itemB], input, ctx(), () => UniqueId.generate());

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toBe('insufficient_stock');
    expect(outcome.shortages).toEqual([{ productCode: 'PRD-0002', requested: 5, available: 1 }]);
    expect(itemA.reservedUnits).toBe(0);
    expect(itemB.reservedUnits).toBe(0);
    expect(itemA.reservations).toHaveLength(0);
    expect(itemB.reservations).toHaveLength(0);

    const events = [...itemA.pullDomainEvents(), ...itemB.pullDomainEvents()];
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('stock.rejected.v1');
    expect(events[0]?.payload).toMatchObject({
      shortages: [{ productCode: 'PRD-0002', requested: 5, available: 1 }],
      reason: 'insufficient_stock',
    });
  });
});

describe('reservation.spec — R35', () => {
  function reservedReservation(): Reservation {
    return Reservation.create({
      id: UniqueId.generate(),
      orderReference: OrderNumber.fromSequence(1),
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode: 'PRD-0001',
      units: Quantity.of(2),
    });
  }

  it('refuses every transition out of released and out of consumed and changes nothing', () => {
    const released = reservedReservation();
    released.release();
    expect(() => released.release()).toThrow(ReservationTerminalError);
    expect(() => released.consume()).toThrow(ReservationTerminalError);
    expect(released.status).toBe('released');

    const consumed = reservedReservation();
    consumed.consume();
    expect(() => consumed.release()).toThrow(ReservationTerminalError);
    expect(() => consumed.consume()).toThrow(ReservationTerminalError);
    expect(consumed.status).toBe('consumed');
  });
});
