// Pure unit — fake `UnitOfWork`/`StockItemRepository`/`DespatchRepository`/
// `DespatchNumberAllocator`/`Clock` (CLAUDE.md § Testing conventions).
// Proves: F8's fast idempotent-repeat path opens no transaction; the
// never-reserved precondition (R36) also opens no transaction; the happy
// path consumes reservations and saves both the stock items and the new
// despatch inside the SAME transaction; the in-flight race (reservations
// already consumed by a concurrent committer) resolves to the existing
// despatch without allocating a second reference or writing a second row.
import { DespatchReference, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { DespatchCreateRequestPayload } from '@otc/contracts';
import { describe, expect, it } from 'vitest';
import { StockItem } from '../domain/stock-item.js';
import type { StockItemSnapshot } from '../domain/stock-item-snapshot.js';
import type { DespatchAdviceSnapshot } from '../domain/despatch-advice-snapshot.js';
import { CreateDespatchCommand } from './commands/despatch.commands.js';
import { DespatchCreationHandler } from './despatch-creation.handler.js';
import { NoReservedStockForDespatchError } from './despatch-application-errors.js';
import type { Clock } from './ports/clock.port.js';
import type { DespatchNumberAllocator } from './ports/despatch-number-allocator.port.js';
import type { DespatchRepository } from './ports/despatch-repository.port.js';
import type { StockItemRepository } from './ports/stock-item-repository.port.js';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port.js';

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

const fixedClock: Clock = { now: () => new Date('2026-08-22T10:00:00.000Z') };

function despatchCommand(
  overrides: Partial<DespatchCreateRequestPayload> = {},
): CreateDespatchCommand {
  const request: DespatchCreateRequestPayload = { orderReference: 'ORD-000001', ...overrides };
  return new CreateDespatchCommand(request, UniqueId.generate(), UniqueId.generate());
}

function notUsedStock(overrides: Partial<StockItemRepository> = {}): StockItemRepository {
  return {
    async lockForOrder() {
      throw new Error('not used');
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
      throw new Error('not used');
    },
    ...overrides,
  };
}

function notUsedDespatches(overrides: Partial<DespatchRepository> = {}): DespatchRepository {
  return {
    async findByOrderReference() {
      throw new Error('not used');
    },
    async save() {
      throw new Error('not used');
    },
    ...overrides,
  };
}

const fixedAllocator = (reference: DespatchReference): DespatchNumberAllocator => ({
  async next() {
    return reference;
  },
});

describe('DespatchCreationHandler.create — F8 fast path', () => {
  it('returns the existing despatch with created:false and opens no transaction', async () => {
    const existing: DespatchAdviceSnapshot = {
      id: UniqueId.generate(),
      despatchReference: 'DES-000001',
      despatchDate: new Date('2026-08-21T10:00:00.000Z'),
      orderReference: 'ORD-000001',
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      lines: [{ productCode: 'PRD-0001', units: 3 }],
    };
    const unitOfWork = new FakeUnitOfWork();
    const stock = notUsedStock();
    const despatches = notUsedDespatches({
      async findByOrderReference() {
        return existing;
      },
    });
    const handler = new DespatchCreationHandler(
      unitOfWork,
      stock,
      despatches,
      fixedAllocator(DespatchReference.of('DES-000099')),
      fixedClock,
    );

    const reply = await handler.create(despatchCommand());

    expect(reply).toEqual({
      orderReference: 'ORD-000001',
      despatchReference: 'DES-000001',
      despatchDate: '2026-08-21T10:00:00.000Z',
      created: false,
      lines: [{ productCode: 'PRD-0001', units: 3 }],
    });
    expect(unitOfWork.executeCalls).toBe(0);
  });
});

describe('DespatchCreationHandler.create — R36 precondition', () => {
  it('never reserved (no stock ids for the order) throws NoReservedStockForDespatchError without opening a transaction', async () => {
    const unitOfWork = new FakeUnitOfWork();
    const stock = notUsedStock({
      async stockIdsOfOrder() {
        return [];
      },
    });
    const despatches = notUsedDespatches({
      async findByOrderReference() {
        return null;
      },
    });
    const handler = new DespatchCreationHandler(
      unitOfWork,
      stock,
      despatches,
      fixedAllocator(DespatchReference.of('DES-000001')),
      fixedClock,
    );

    await expect(handler.create(despatchCommand())).rejects.toThrow(
      NoReservedStockForDespatchError,
    );
    expect(unitOfWork.executeCalls).toBe(0);
  });

  it('every reservation already released throws NoReservedStockForDespatchError inside the transaction', async () => {
    const orderReference = OrderNumber.of('ORD-000001');
    const released = {
      id: UniqueId.generate(),
      orderReference,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode: 'PRD-0001',
      units: Quantity.of(3),
      status: 'released' as const,
    };
    const item = stockItem({ reservedUnits: 0, reservations: [released] });
    const unitOfWork = new FakeUnitOfWork();
    const stock = notUsedStock({
      async stockIdsOfOrder() {
        return [item.id];
      },
      async lockByIdsForOrder() {
        return [item];
      },
    });
    const despatches = notUsedDespatches({
      async findByOrderReference() {
        return null;
      },
    });
    const handler = new DespatchCreationHandler(
      unitOfWork,
      stock,
      despatches,
      fixedAllocator(DespatchReference.of('DES-000001')),
      fixedClock,
    );

    await expect(handler.create(despatchCommand())).rejects.toThrow(
      NoReservedStockForDespatchError,
    );
    expect(unitOfWork.executeCalls).toBe(1);
  });
});

describe('DespatchCreationHandler.create — happy path', () => {
  it('consumes the reserved reservations, saves the stock items and the despatch inside the same transaction, and returns created:true', async () => {
    const orderReference = OrderNumber.of('ORD-000001');
    const reserved = {
      id: UniqueId.generate(),
      orderReference,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode: 'PRD-0001',
      units: Quantity.of(3),
      status: 'reserved' as const,
    };
    const item = stockItem({ reservedUnits: 3, reservations: [reserved] });
    const unitOfWork = new FakeUnitOfWork();
    const saveAllCalls: StockItem[][] = [];
    const stock: StockItemRepository = notUsedStock({
      async stockIdsOfOrder() {
        return [item.id];
      },
      async lockByIdsForOrder() {
        return [item];
      },
      async saveAll(items) {
        saveAllCalls.push([...items]);
      },
    });
    let savedDespatch: unknown;
    const despatches: DespatchRepository = notUsedDespatches({
      async findByOrderReference() {
        return null;
      },
      async save(despatch) {
        savedDespatch = despatch;
      },
    });
    const despatchReference = DespatchReference.of('DES-000042');
    const handler = new DespatchCreationHandler(
      unitOfWork,
      stock,
      despatches,
      fixedAllocator(despatchReference),
      fixedClock,
    );

    const reply = await handler.create(despatchCommand());

    expect(reply).toEqual({
      orderReference: 'ORD-000001',
      despatchReference: 'DES-000042',
      despatchDate: '2026-08-22T10:00:00.000Z',
      created: true,
      lines: [{ productCode: 'PRD-0001', units: 3 }],
    });
    expect(unitOfWork.executeCalls).toBe(1);
    expect(saveAllCalls).toHaveLength(1);
    expect(item.reservations[0]?.status).toBe('consumed');
    expect(savedDespatch).toBeDefined();
  });

  it('F8 race — reservations already consumed by a concurrent committer resolves to the existing despatch without a second allocation or save', async () => {
    const orderReference = OrderNumber.of('ORD-000001');
    const consumed = {
      id: UniqueId.generate(),
      orderReference,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode: 'PRD-0001',
      units: Quantity.of(3),
      status: 'consumed' as const,
    };
    const item = stockItem({ reservedUnits: 0, units: 7, reservations: [consumed] });
    const existing: DespatchAdviceSnapshot = {
      id: UniqueId.generate(),
      despatchReference: 'DES-000042',
      despatchDate: new Date('2026-08-22T09:59:59.000Z'),
      orderReference: 'ORD-000001',
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      lines: [{ productCode: 'PRD-0001', units: 3 }],
    };
    let findCalls = 0;
    const unitOfWork = new FakeUnitOfWork();
    const stock = notUsedStock({
      async stockIdsOfOrder() {
        return [item.id];
      },
      async lockByIdsForOrder() {
        return [item];
      },
    });
    let allocatorCalls = 0;
    const allocator: DespatchNumberAllocator = {
      async next() {
        allocatorCalls += 1;
        return DespatchReference.of('DES-000099');
      },
    };
    const despatches: DespatchRepository = notUsedDespatches({
      async findByOrderReference() {
        findCalls += 1;
        // First call (the fast path) misses — the race; the second call
        // (inside the transaction, after the lock) sees the committed row.
        return findCalls === 1 ? null : existing;
      },
    });
    const handler = new DespatchCreationHandler(
      unitOfWork,
      stock,
      despatches,
      allocator,
      fixedClock,
    );

    const reply = await handler.create(despatchCommand());

    expect(reply).toEqual({
      orderReference: 'ORD-000001',
      despatchReference: 'DES-000042',
      despatchDate: '2026-08-22T09:59:59.000Z',
      created: false,
      lines: [{ productCode: 'PRD-0001', units: 3 }],
    });
    expect(findCalls).toBe(2);
    expect(allocatorCalls).toBe(0);
  });
});
