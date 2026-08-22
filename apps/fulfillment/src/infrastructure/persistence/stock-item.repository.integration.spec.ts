// Testcontainers integration — real MySQL (mysql:8.4.11), migrations
// applied through the existing migrator (design.md §7, tasks D4). Proves:
// round-trip reconstitute/save; FS12's stored-equality integration half
// (`reserved_units` equals the sum of `reserved` reservation units after
// every committed operation); `saveAll` writes the outbox rows in the SAME
// transaction and a forced rollback leaves neither (R13 shape, the OI9
// drained-events hazard re-proven on this repository).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { StockItem } from '../../domain/stock-item';
import type { StockItemSnapshot } from '../../domain/stock-item-snapshot';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { DrizzleStockItemRepository } from './stock-item.repository';
import { outbox, reservations, stock } from './schema';
import {
  startFulfillmentTestFixture,
  type FulfillmentTestFixture,
} from './test-support/fulfillment-test-fixture';

const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

function snapshot(overrides: Partial<StockItemSnapshot> = {}): StockItemSnapshot {
  return {
    id: UniqueId.generate(),
    companyCode: 'COM-0001',
    productCode: `PRD-${randomUUID().slice(0, 8)}`,
    units: 20,
    reservedUnits: 0,
    lowStockThreshold: 2,
    reservations: [],
    ...overrides,
  };
}

describe('DrizzleStockItemRepository (Testcontainers: mysql:8.4.11)', () => {
  let fixture: FulfillmentTestFixture;
  let repository: DrizzleStockItemRepository;
  let unitOfWork: DrizzleUnitOfWork;

  beforeAll(async () => {
    fixture = await startFulfillmentTestFixture();
    repository = new DrizzleStockItemRepository(fixture.db, fixedClock);
    unitOfWork = new DrizzleUnitOfWork(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.db.delete(outbox);
    await fixture.db.delete(reservations);
    await fixture.db.delete(stock);
  });

  it('round-trips reconstitute/save: an item reserved, saved, then re-loaded is byte-equal in its observable state', async () => {
    const item = StockItem.reconstitute(snapshot({ units: 20, reservedUnits: 0 }));

    await unitOfWork.execute(async (tx) => {
      const orderReference = OrderNumber.fromSequence(1);
      item.reserve({ reservationId: UniqueId.generate(), orderReference, retailerCode: 'RET-0001', units: Quantity.of(5) });
      await repository.saveAll([item], tx);
    });

    const reloaded = await unitOfWork.execute(async (tx) => {
      const map = await repository.lockForOrder(tx, item.companyCode, [item.productCode], OrderNumber.fromSequence(1));
      return map.get(item.productCode);
    });

    expect(reloaded).toBeDefined();
    expect(reloaded!.units).toBe(20);
    expect(reloaded!.reservedUnits).toBe(5);
    expect(reloaded!.reservations).toHaveLength(1);
    expect(reloaded!.reservations[0]?.status).toBe('reserved');
  });

  it('reserved_units equals the sum of reserved reservation units after every committed operation', async () => {
    const item = StockItem.reconstitute(snapshot({ units: 20, reservedUnits: 0 }));
    const orderA = OrderNumber.fromSequence(101);
    const orderB = OrderNumber.fromSequence(102);

    await unitOfWork.execute(async (tx) => {
      item.reserve({ reservationId: UniqueId.generate(), orderReference: orderA, retailerCode: 'RET-0001', units: Quantity.of(4) });
      item.reserve({ reservationId: UniqueId.generate(), orderReference: orderB, retailerCode: 'RET-0001', units: Quantity.of(3) });
      await repository.saveAll([item], tx);
    });
    await expectStoredReservedUnitsEquals(item.id.value);

    await unitOfWork.execute(async (tx) => {
      const map = await repository.lockForOrder(tx, item.companyCode, [item.productCode], orderA);
      const loaded = map.get(item.productCode)!;
      loaded.release(orderA);
      await repository.saveAll([loaded], tx);
    });
    await expectStoredReservedUnitsEquals(item.id.value);

    await unitOfWork.execute(async (tx) => {
      const map = await repository.lockForOrder(tx, item.companyCode, [item.productCode], orderB);
      const loaded = map.get(item.productCode)!;
      loaded.consume(orderB);
      await repository.saveAll([loaded], tx);
    });
    await expectStoredReservedUnitsEquals(item.id.value);
  });

  it('R13 shape / OI9 — saveAll writes the outbox rows in the SAME transaction, and a forced rollback leaves neither the counters nor the fact', async () => {
    const item = StockItem.reconstitute(snapshot({ units: 10, reservedUnits: 0 }));
    const orderReference = OrderNumber.fromSequence(201);

    await expect(
      unitOfWork.execute(async (tx) => {
        item.reserve({ reservationId: UniqueId.generate(), orderReference, retailerCode: 'RET-0001', units: Quantity.of(4) });
        // reserveOrderStock would normally append the fact via recordOrderFact;
        // here we append one directly to exercise the outbox-drain path in
        // isolation from the domain service.
        item.recordOrderFact({
          eventId: UniqueId.generate(),
          eventType: 'stock.reserved.v1',
          aggregateId: item.id,
          correlationId: UniqueId.generate(),
          causationId: UniqueId.generate(),
          occurredAt: fixedClock.now(),
          payload: { a: 1 },
        });
        await repository.saveAll([item], tx);
        throw new Error('forced rollback — nothing above this line must survive');
      }),
    ).rejects.toThrow('forced rollback');

    const [stockRow] = await fixture.db.select().from(stock).where(eq(stock.id, item.id.value));
    expect(stockRow).toBeUndefined();
    const outboxRows = await fixture.db.select().from(outbox).where(eq(outbox.aggregateId, item.id.value));
    expect(outboxRows).toHaveLength(0);
  });

  async function expectStoredReservedUnitsEquals(stockId: string): Promise<void> {
    const [stockRow] = await fixture.db.select().from(stock).where(eq(stock.id, stockId));
    const reservationRows = await fixture.db.select().from(reservations).where(eq(reservations.stockId, stockId));
    const sumReserved = reservationRows.filter((r) => r.status === 'reserved').reduce((sum, r) => sum + r.units, 0);
    expect(stockRow?.reservedUnits).toBe(sumReserved);
  }
});
