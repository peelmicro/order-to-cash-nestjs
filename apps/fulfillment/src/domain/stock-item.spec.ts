// Pure unit — no framework, no DB, no clock. R30 (matrix name), FS10, FS11,
// FS12's unit half, R61's domain half (`stock-replenishment` describe block,
// matrix name kept), and the `recordOrderFact` aggregate-id guard.
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { DomainEventEnvelope } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { ReservationSnapshot } from './reservation.js';
import { FactAggregateMismatchError, InsufficientStockError, ReservationTerminalError } from './stock-errors.js';
import { StockItem } from './stock-item.js';
import type { StockItemSnapshot } from './stock-item-snapshot.js';

const ORDER = OrderNumber.fromSequence(1);

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

function snapshot(overrides: Partial<StockItemSnapshot> = {}): StockItemSnapshot {
  return {
    id: UniqueId.generate(),
    companyCode: 'COM-0001',
    productCode: 'PRD-0001',
    units: 10,
    reservedUnits: 0,
    lowStockThreshold: 2,
    reservations: [],
    ...overrides,
  };
}

describe('stock-item.spec — R30', () => {
  it('rejects in full any operation that would push reservedUnits above units and changes no stock item', () => {
    const item = StockItem.reconstitute(snapshot({ units: 5, reservedUnits: 4 }));

    expect(() =>
      item.reserve({ reservationId: UniqueId.generate(), orderReference: ORDER, retailerCode: 'RET-0001', units: Quantity.of(2) }),
    ).toThrow(InsufficientStockError);

    expect(item.units).toBe(5);
    expect(item.reservedUnits).toBe(4);
    expect(item.reservations).toHaveLength(0);
    expect(item.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses to reconstitute a snapshot where reservedUnits exceeds units', () => {
    expect(() => StockItem.reconstitute(snapshot({ units: 3, reservedUnits: 4 }))).toThrow();
  });
});

describe('stock-item.spec — FS10', () => {
  it('refuses to release a consumed reservation and changes nothing', () => {
    const consumed = reservationSnapshot({ status: 'consumed', units: Quantity.of(3) });
    const item = StockItem.reconstitute(snapshot({ reservedUnits: 3, reservations: [consumed] }));

    expect(() => item.release(ORDER)).toThrow(ReservationTerminalError);
    expect(item.reservedUnits).toBe(3);
    expect(item.reservations[0]?.status).toBe('consumed');
  });
});

describe('stock-item.spec — FS11', () => {
  it('consume moves the order\'s reservations to consumed, decreases units and reservedUnits by the same total and appends no domain event', () => {
    const reserved = reservationSnapshot({ units: Quantity.of(4) });
    const item = StockItem.reconstitute(snapshot({ units: 10, reservedUnits: 4, reservations: [reserved] }));

    const consumed = item.consume(ORDER);

    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.status).toBe('consumed');
    expect(item.units).toBe(6);
    expect(item.reservedUnits).toBe(0);
    expect(item.pullDomainEvents()).toHaveLength(0);
  });

  it('is idempotent — consuming an order with nothing reserved returns an empty array and changes nothing', () => {
    const item = StockItem.reconstitute(snapshot({ units: 10, reservedUnits: 0, reservations: [] }));

    const consumed = item.consume(ORDER);

    expect(consumed).toEqual([]);
    expect(item.units).toBe(10);
    expect(item.reservedUnits).toBe(0);
  });

  it('refuses to consume a released reservation', () => {
    const released = reservationSnapshot({ status: 'released', units: Quantity.of(3) });
    const item = StockItem.reconstitute(snapshot({ reservedUnits: 0, reservations: [released] }));

    expect(() => item.consume(ORDER)).toThrow(ReservationTerminalError);
  });
});

describe('stock-item.spec — FS12 (unit half)', () => {
  it('reconstitutes from a snapshot and keeps reservedUnits equal to the sum of reserved reservations after reserve, release and consume', () => {
    const item = StockItem.reconstitute(snapshot({ units: 20, reservedUnits: 0, reservations: [] }));

    item.reserve({ reservationId: UniqueId.generate(), orderReference: ORDER, retailerCode: 'RET-0001', units: Quantity.of(5) });
    expect(item.reservedUnits).toBe(sumReserved(item));

    const otherOrder = OrderNumber.fromSequence(2);
    item.reserve({ reservationId: UniqueId.generate(), orderReference: otherOrder, retailerCode: 'RET-0001', units: Quantity.of(3) });
    expect(item.reservedUnits).toBe(sumReserved(item));

    item.release(ORDER);
    expect(item.reservedUnits).toBe(sumReserved(item));

    item.consume(otherOrder);
    expect(item.reservedUnits).toBe(sumReserved(item));
  });

  function sumReserved(item: StockItem): number {
    return item.reservations.filter((r) => r.status === 'reserved').reduce((sum, r) => sum + r.units.value, 0);
  }
});

describe('stock-replenishment', () => {
  it('increases units by the requested quantity, leaves reservedUnits and every reservation unchanged and appends no domain event', () => {
    const reserved = reservationSnapshot({ units: Quantity.of(4) });
    const item = StockItem.reconstitute(snapshot({ units: 10, reservedUnits: 4, reservations: [reserved] }));

    item.replenish(Quantity.of(6));

    expect(item.units).toBe(16);
    expect(item.reservedUnits).toBe(4);
    expect(item.reservations).toHaveLength(1);
    expect(item.reservations[0]?.status).toBe('reserved');
    expect(item.pullDomainEvents()).toHaveLength(0);
  });
});

describe('stock-item.spec — recordOrderFact', () => {
  it('refuses a foreign aggregateId and appends nothing', () => {
    const item = StockItem.reconstitute(snapshot());
    const foreignEvent: DomainEventEnvelope = {
      eventId: UniqueId.generate(),
      eventType: 'stock.reserved.v1',
      aggregateId: UniqueId.generate(),
      correlationId: UniqueId.generate(),
      causationId: UniqueId.generate(),
      occurredAt: new Date('2026-08-21T10:00:00.000Z'),
      payload: { a: 1 },
    };

    expect(() => item.recordOrderFact(foreignEvent)).toThrow(FactAggregateMismatchError);
    expect(item.pullDomainEvents()).toHaveLength(0);
  });

  it('accepts an envelope whose aggregateId is its own', () => {
    const item = StockItem.reconstitute(snapshot());
    const event: DomainEventEnvelope = {
      eventId: UniqueId.generate(),
      eventType: 'stock.reserved.v1',
      aggregateId: item.id,
      correlationId: UniqueId.generate(),
      causationId: UniqueId.generate(),
      occurredAt: new Date('2026-08-21T10:00:00.000Z'),
      payload: { a: 1 },
    };

    item.recordOrderFact(event);

    expect(item.pullDomainEvents()).toEqual([event]);
  });
});
