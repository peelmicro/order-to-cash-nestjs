// Pure unit — fakes only. `ReserveStockHandler`/`ReleaseStockHandler` prove
// plain delegation to `StockReservationHandler`; `ReplenishStockHandler`
// (its own transactional unit) proves the all-or-nothing lock-then-replenish
// flow and the `UnknownStockItemError` refusal (FS14).
import { UniqueId } from '@otc/shared-kernel';
import { describe, expect, it, vi } from 'vitest';
import type { StockReleaseReplyPayload, StockReserveReplyPayload } from '@otc/contracts';
import { StockItem } from '../../domain/stock-item.js';
import type { StockItemSnapshot } from '../../domain/stock-item-snapshot.js';
import type { StockItemRepository } from '../ports/stock-item-repository.port.js';
import type { TransactionContext, UnitOfWork } from '../ports/unit-of-work.port.js';
import { StockReservationHandler } from '../stock-reservation.handler.js';
import { UnknownStockItemError } from '../stock-application-errors.js';
import { ReleaseStockCommand, ReplenishStockCommand, ReserveStockCommand } from './stock.commands.js';
import { ReleaseStockHandler, ReplenishStockHandler, ReserveStockHandler } from './stock.command-handlers.js';

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

function fakeUnitOfWork(): UnitOfWork {
  return {
    async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return work(fakeTx());
    },
  };
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

describe('ReserveStockHandler / ReleaseStockHandler — plain delegation', () => {
  it('ReserveStockHandler.execute delegates to StockReservationHandler.reserve', async () => {
    const reply: StockReserveReplyPayload = { outcome: 'accepted', orderReference: 'ORD-000001', reservations: [] };
    const inner = { reserve: vi.fn().mockResolvedValue(reply), release: vi.fn() } as unknown as StockReservationHandler;
    const handler = new ReserveStockHandler(inner);
    const command = new ReserveStockCommand(
      { orderReference: 'ORD-000001', retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode: 'PRD-0001', units: 1 }] },
      UniqueId.generate(),
      UniqueId.generate(),
    );

    const result = await handler.execute(command);

    expect(result).toBe(reply);
    expect((inner as unknown as { reserve: ReturnType<typeof vi.fn> }).reserve).toHaveBeenCalledWith(command);
  });

  it('ReleaseStockHandler.execute delegates to StockReservationHandler.release', async () => {
    const reply: StockReleaseReplyPayload = { outcome: 'released', orderReference: 'ORD-000001', released: [] };
    const inner = { reserve: vi.fn(), release: vi.fn().mockResolvedValue(reply) } as unknown as StockReservationHandler;
    const handler = new ReleaseStockHandler(inner);
    const command = new ReleaseStockCommand(
      { orderReference: 'ORD-000001', reason: 'credit_rejected' },
      UniqueId.generate(),
      UniqueId.generate(),
    );

    const result = await handler.execute(command);

    expect(result).toBe(reply);
    expect((inner as unknown as { release: ReturnType<typeof vi.fn> }).release).toHaveBeenCalledWith(command);
  });
});

describe('ReplenishStockHandler', () => {
  it('replenishes every known line, saves and replies StockViews', async () => {
    const itemA = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 2 });
    const itemB = stockItem({ productCode: 'PRD-0002', units: 5, reservedUnits: 0 });
    const saved: StockItem[][] = [];
    const stock: StockItemRepository = {
      async lockForOrder() {
        throw new Error('not used by this test');
      },
      async stockIdsOfOrder() {
        throw new Error('not used by this test');
      },
      async lockByIdsForOrder() {
        throw new Error('not used by this test');
      },
      async lockByProductCodes() {
        return new Map([
          ['PRD-0001', itemA],
          ['PRD-0002', itemB],
        ]);
      },
      async saveAll(items) {
        saved.push([...items]);
      },
    };
    const handler = new ReplenishStockHandler(fakeUnitOfWork(), stock);
    const command = new ReplenishStockCommand({
      companyCode: 'COM-0001',
      lines: [
        { productCode: 'PRD-0001', units: 5 },
        { productCode: 'PRD-0002', units: 3 },
      ],
    });

    const result = await handler.execute(command);

    expect(itemA.units).toBe(15);
    expect(itemB.units).toBe(8);
    expect(saved).toHaveLength(1);
    expect(result.items).toEqual([
      { companyCode: 'COM-0001', productCode: 'PRD-0001', units: 15, reservedUnits: 2, availableUnits: 13, lowStockThreshold: 2 },
      { companyCode: 'COM-0001', productCode: 'PRD-0002', units: 8, reservedUnits: 0, availableUnits: 8, lowStockThreshold: 2 },
    ]);
  });

  it('FS14 — throws UnknownStockItemError and replenishes NO line when any line names an unknown product', async () => {
    const itemA = stockItem({ productCode: 'PRD-0001', units: 10, reservedUnits: 0 });
    let saveAllCalled = false;
    const stock: StockItemRepository = {
      async lockForOrder() {
        throw new Error('not used by this test');
      },
      async stockIdsOfOrder() {
        throw new Error('not used by this test');
      },
      async lockByIdsForOrder() {
        throw new Error('not used by this test');
      },
      async lockByProductCodes() {
        return new Map([['PRD-0001', itemA]]);
      },
      async saveAll() {
        saveAllCalled = true;
      },
    };
    const handler = new ReplenishStockHandler(fakeUnitOfWork(), stock);
    const command = new ReplenishStockCommand({
      companyCode: 'COM-0001',
      lines: [
        { productCode: 'PRD-0001', units: 5 },
        { productCode: 'PRD-9999', units: 1 },
      ],
    });

    await expect(handler.execute(command)).rejects.toThrow(UnknownStockItemError);
    expect(itemA.units).toBe(10);
    expect(saveAllCalled).toBe(false);
  });
});
