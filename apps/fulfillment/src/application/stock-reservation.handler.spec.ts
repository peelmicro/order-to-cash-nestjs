// Pure unit — fake `UnitOfWork`/`StockItemRepository`/`Clock` (CLAUDE.md §
// Testing conventions). Proves: the reply is built from the domain outcome
// and returned only AFTER `execute` resolves; a rollback (the transactional
// work rejects) propagates the rejection and never produces a reply; the
// already_reserved path calls no domain function (and no `saveAll`); the
// release pre-read being empty short-circuits WITHOUT opening a transaction.
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { StockReserveRequestPayload } from '@otc/contracts';
import { describe, expect, it } from 'vitest';
import { StockItem } from '../domain/stock-item.js';
import type { StockItemSnapshot } from '../domain/stock-item-snapshot.js';
import { ReleaseStockCommand, ReserveStockCommand } from './commands/stock.commands.js';
import type { Clock } from './ports/clock.port.js';
import type { StockItemRepository } from './ports/stock-item-repository.port.js';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port.js';
import { StockReservationHandler } from './stock-reservation.handler.js';

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

class FakeUnitOfWork implements UnitOfWork {
  executeCalls = 0;

  async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.executeCalls += 1;
    return work(fakeTx());
  }
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

const fixedClock: Clock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

function reserveCommand(overrides: Partial<StockReserveRequestPayload> = {}): ReserveStockCommand {
  const request: StockReserveRequestPayload = {
    orderReference: 'ORD-000001',
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    lines: [{ productCode: 'PRD-0001', units: 2 }],
    ...overrides,
  };
  return new ReserveStockCommand(request, UniqueId.generate(), UniqueId.generate());
}

describe('StockReservationHandler.reserve', () => {
  it('builds the reply from the domain outcome and returns it only after execute resolves, calling saveAll', async () => {
    const item = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    const saveAllCalls: StockItem[][] = [];
    const stock: StockItemRepository = {
      async lockForOrder() {
        return new Map([['PRD-0001', item]]);
      },
      async stockIdsOfOrder() {
        throw new Error('not used');
      },
      async lockByIdsForOrder() {
        throw new Error('not used');
      },
      async lockByProductCodes() {
        throw new Error('not used');
      },
      async saveAll(items) {
        saveAllCalls.push([...items]);
      },
    };
    const unitOfWork = new FakeUnitOfWork();
    const handler = new StockReservationHandler(unitOfWork, stock, fixedClock);

    const reply = await handler.reserve(reserveCommand());

    expect(reply.outcome).toBe('accepted');
    expect(unitOfWork.executeCalls).toBe(1);
    expect(saveAllCalls).toHaveLength(1);
    expect(item.reservedUnits).toBe(2);
  });

  it('already_reserved path calls no domain function and no saveAll', async () => {
    const orderReference = OrderNumber.of('ORD-000001');
    const existing = {
      id: UniqueId.generate(),
      orderReference,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode: 'PRD-0001',
      units: Quantity.of(2),
      status: 'reserved' as const,
    };
    const item = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 2, reservations: [existing] });
    let saveAllCalled = false;
    const stock: StockItemRepository = {
      async lockForOrder() {
        return new Map([['PRD-0001', item]]);
      },
      async stockIdsOfOrder() {
        throw new Error('not used');
      },
      async lockByIdsForOrder() {
        throw new Error('not used');
      },
      async lockByProductCodes() {
        throw new Error('not used');
      },
      async saveAll() {
        saveAllCalled = true;
      },
    };
    const unitOfWork = new FakeUnitOfWork();
    const handler = new StockReservationHandler(unitOfWork, stock, fixedClock);

    const reply = await handler.reserve(reserveCommand());

    expect(reply.outcome).toBe('already_reserved');
    expect(saveAllCalled).toBe(false);
    // reservedUnits/reservation count on the item are UNCHANGED — no domain
    // call (`reserveOrderStock`) was ever made.
    expect(item.reservedUnits).toBe(2);
    expect(item.reservations).toHaveLength(1);
  });

  it.each(['released', 'consumed'] as const)(
    'FS5 — already_reserved path short-circuits on a %s reservation (any status), calling no domain function and no saveAll',
    async (status) => {
      const orderReference = OrderNumber.of('ORD-000001');
      const existing = {
        id: UniqueId.generate(),
        orderReference,
        companyCode: 'COM-0001',
        retailerCode: 'RET-0001',
        productCode: 'PRD-0001',
        units: Quantity.of(2),
        status,
      };
      const item = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0, reservations: [existing] });
      let saveAllCalled = false;
      const stock: StockItemRepository = {
        async lockForOrder() {
          return new Map([['PRD-0001', item]]);
        },
        async stockIdsOfOrder() {
          throw new Error('not used');
        },
        async lockByIdsForOrder() {
          throw new Error('not used');
        },
        async lockByProductCodes() {
          throw new Error('not used');
        },
        async saveAll() {
          saveAllCalled = true;
        },
      };
      const unitOfWork = new FakeUnitOfWork();
      const handler = new StockReservationHandler(unitOfWork, stock, fixedClock);

      const reply = await handler.reserve(reserveCommand());

      expect(reply.outcome).toBe('already_reserved');
      expect((reply as { reservations: unknown[] }).reservations).toEqual([
        { reservationId: existing.id.value, productCode: existing.productCode, units: existing.units.value },
      ]);
      expect(saveAllCalled).toBe(false);
      // reservedUnits/reservation count/status on the item are UNCHANGED —
      // no domain call (`reserveOrderStock`) was ever made, whatever the
      // existing reservation's own status.
      expect(item.reservedUnits).toBe(0);
      expect(item.reservations).toHaveLength(1);
      expect(item.reservations[0]?.status).toBe(status);
    },
  );

  it('rollback (saveAll rejects) propagates the rejection and produces no reply', async () => {
    const item = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    const boom = new Error('boom — simulated commit failure');
    const stock: StockItemRepository = {
      async lockForOrder() {
        return new Map([['PRD-0001', item]]);
      },
      async stockIdsOfOrder() {
        throw new Error('not used');
      },
      async lockByIdsForOrder() {
        throw new Error('not used');
      },
      async lockByProductCodes() {
        throw new Error('not used');
      },
      async saveAll() {
        throw boom;
      },
    };
    const unitOfWork = new FakeUnitOfWork();
    const handler = new StockReservationHandler(unitOfWork, stock, fixedClock);

    await expect(handler.reserve(reserveCommand())).rejects.toThrow(boom);
  });
});

describe('StockReservationHandler.release', () => {
  it('an empty pre-read short-circuits to already_released WITHOUT opening a transaction', async () => {
    const unitOfWork = new FakeUnitOfWork();
    const stock: StockItemRepository = {
      async lockForOrder() {
        throw new Error('not used');
      },
      async stockIdsOfOrder() {
        return [];
      },
      async lockByIdsForOrder() {
        throw new Error('not used — the pre-read is empty');
      },
      async lockByProductCodes() {
        throw new Error('not used');
      },
      async saveAll() {
        throw new Error('not used — nothing to save');
      },
    };
    const handler = new StockReservationHandler(unitOfWork, stock, fixedClock);

    const reply = await handler.release(new ReleaseStockCommand({ orderReference: 'ORD-000001', reason: 'credit_rejected' }, UniqueId.generate(), UniqueId.generate()));

    expect(reply).toEqual({ outcome: 'already_released', orderReference: 'ORD-000001', released: [] });
    expect(unitOfWork.executeCalls).toBe(0);
  });
});
