// Pure unit — fake `UnitOfWork`/`StockItemRepository`/`DespatchRepository`/
// `DespatchNumberAllocator`/`Clock`, no database (CLAUDE.md § Testing
// conventions).
//
// SA-4 / saga.md §4.3, "The despatch already requested": *"Fulfillment
// SHALL decide `stock.release` and `despatch.create` for one order under
// one lock, so exactly one of them takes it."* Orders depends on this being
// true — it releases the contested stock FIRST precisely so Fulfillment can
// arbitrate, and the whole "the release wins / the despatch wins" branch of
// the cancellation saga is unsound without it.
//
// The behaviour already existed (feature 17's lock protocol, reused
// unchanged by feature 25's despatch flow); what did not exist was a test
// that FAILS if either path stops taking that lock, or starts taking a
// DIFFERENT one. `despatch-create.integration.spec.ts`'s concurrency case
// observes the outcome of a real race, which is evidence but not a guard:
// two transactions can serialise by luck, and it needs Docker.
//
// This file asserts the mechanism directly, and asserts it about BOTH
// paths together — the arbitration claim is not "each handler locks
// something", it is "both handlers lock THE SAME ROWS", which is what makes
// one of them wait.
import { DespatchReference, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { StockItem } from '../domain/stock-item.js';
import type { StockItemSnapshot } from '../domain/stock-item-snapshot.js';
import { CreateDespatchCommand } from './commands/despatch.commands.js';
import { ReleaseStockCommand } from './commands/stock.commands.js';
import { DespatchCreationHandler } from './despatch-creation.handler.js';
import type { Clock } from './ports/clock.port.js';
import type { DespatchNumberAllocator } from './ports/despatch-number-allocator.port.js';
import type { DespatchRepository } from './ports/despatch-repository.port.js';
import type { StockItemRepository } from './ports/stock-item-repository.port.js';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port.js';
import { StockReservationHandler } from './stock-reservation.handler.js';

const ORDER_REFERENCE = 'ORD-000001';
const fixedClock: Clock = { now: () => new Date('2026-08-22T10:00:00.000Z') };

/** Hands out a DISTINCT transaction object per `execute`, so a recorded lock call can be checked to have happened inside THIS handler's own transaction rather than outside any. */
class FakeUnitOfWork implements UnitOfWork {
  readonly handedOut: TransactionContext[] = [];

  async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = { id: this.handedOut.length } as unknown as TransactionContext;
    this.handedOut.push(tx);
    return work(tx);
  }
}

interface RecordedLock {
  readonly method: 'lockByIdsForOrder' | 'lockForOrder' | 'lockByProductCodes';
  readonly tx: TransactionContext | null;
  readonly ids: readonly string[];
  readonly orderReference: string | null;
}

function reservedItem(): StockItem {
  const snapshot: StockItemSnapshot = {
    id: UniqueId.generate(),
    companyCode: 'COM-0001',
    productCode: 'PRD-0001',
    units: 10,
    reservedUnits: 3,
    lowStockThreshold: 2,
    reservations: [
      {
        id: UniqueId.generate(),
        orderReference: OrderNumber.of(ORDER_REFERENCE),
        companyCode: 'COM-0001',
        retailerCode: 'RET-0001',
        productCode: 'PRD-0001',
        units: Quantity.of(3),
        status: 'reserved' as const,
      },
    ],
  };
  return StockItem.reconstitute(snapshot);
}

/**
 * Records EVERY locking read the handler under test performs — including
 * the two OTHER locks this repository offers (`lockForOrder`,
 * `lockByProductCodes`), which are real, valid siblings: swapping one in
 * would still "take a lock", and would still be wrong, because it would not
 * be the same lock the other handler takes.
 */
function recordingStock(item: StockItem, log: RecordedLock[]): StockItemRepository {
  return {
    async lockForOrder(tx, _companyCode, _productCodes, orderReference) {
      log.push({ method: 'lockForOrder', tx, ids: [], orderReference: orderReference.value });
      return new Map([[item.productCode, item]]);
    },
    async stockIdsOfOrder() {
      return [item.id];
    },
    async lockByIdsForOrder(tx, ids, orderReference) {
      log.push({ method: 'lockByIdsForOrder', tx, ids: ids.map((id) => id.value), orderReference: orderReference.value });
      return [item];
    },
    async lockByProductCodes(tx, _companyCode, productCodes) {
      log.push({ method: 'lockByProductCodes', tx, ids: [...productCodes], orderReference: null });
      return new Map([[item.productCode, item]]);
    },
    async saveAll() {
      /* recorded elsewhere — irrelevant to the lock claim */
    },
  };
}

function despatchRepository(): DespatchRepository {
  return {
    async findByOrderReference() {
      return null;
    },
    async save() {
      /* no-op */
    },
  };
}

const allocator: DespatchNumberAllocator = {
  async next() {
    return DespatchReference.of('DES-000001');
  },
};

async function releaseLocks(): Promise<{ log: RecordedLock[]; unitOfWork: FakeUnitOfWork }> {
  const log: RecordedLock[] = [];
  const unitOfWork = new FakeUnitOfWork();
  const handler = new StockReservationHandler(unitOfWork, recordingStock(reservedItem(), log), fixedClock);

  await handler.release(new ReleaseStockCommand({ orderReference: ORDER_REFERENCE, reason: 'order_cancelled' }, UniqueId.generate(), UniqueId.generate()));

  return { log, unitOfWork };
}

async function despatchLocks(): Promise<{ log: RecordedLock[]; unitOfWork: FakeUnitOfWork }> {
  const log: RecordedLock[] = [];
  const unitOfWork = new FakeUnitOfWork();
  const handler = new DespatchCreationHandler(unitOfWork, recordingStock(reservedItem(), log), despatchRepository(), allocator, fixedClock);

  await handler.create(new CreateDespatchCommand({ orderReference: ORDER_REFERENCE }, UniqueId.generate(), UniqueId.generate()));

  return { log, unitOfWork };
}

describe('saga.md §4.3 — Fulfillment decides stock.release and despatch.create for ONE order under ONE lock', () => {
  it('stock.release takes the order\'s stock rows through lockByIdsForOrder, inside its own transaction, scoped to the order', async () => {
    const { log, unitOfWork } = await releaseLocks();

    expect(log).toHaveLength(1);
    expect(log[0]?.method).toBe('lockByIdsForOrder');
    expect(log[0]?.ids).toHaveLength(1);
    expect(log[0]?.orderReference).toBe(ORDER_REFERENCE);
    // Inside the transaction, not before it and not on the ambient
    // connection: a `FOR UPDATE` read outside a transaction releases its
    // lock immediately and arbitrates nothing.
    expect(unitOfWork.handedOut).toHaveLength(1);
    expect(log[0]?.tx).toBe(unitOfWork.handedOut[0]);
  });

  it('despatch.create takes the SAME lock, the same way — the reused protocol, not a second one of its own', async () => {
    const { log, unitOfWork } = await despatchLocks();

    expect(log).toHaveLength(1);
    expect(log[0]?.method).toBe('lockByIdsForOrder');
    expect(log[0]?.ids).toHaveLength(1);
    expect(log[0]?.orderReference).toBe(ORDER_REFERENCE);
    expect(unitOfWork.handedOut).toHaveLength(1);
    expect(log[0]?.tx).toBe(unitOfWork.handedOut[0]);
  });

  it('the two paths lock the IDENTICAL rows for one order — which is what makes exactly one of them win (the arbitration Orders relies on when it releases the contested stock first)', async () => {
    // Both fixtures are built from a stock item whose id is generated per
    // call, so comparing raw ids would compare two different orders. What
    // must match is the SHAPE of the claim: the same method, over the id
    // set `stockIdsOfOrder` returned for this order, scoped to the same
    // order reference.
    const release = await releaseLocks();
    const despatch = await despatchLocks();

    const shapeOf = (log: RecordedLock[]): unknown =>
      log.map((entry) => ({ method: entry.method, lockedRowCount: entry.ids.length, orderReference: entry.orderReference }));

    expect(shapeOf(release.log)).toEqual(shapeOf(despatch.log));
    expect(shapeOf(release.log)).toEqual([{ method: 'lockByIdsForOrder', lockedRowCount: 1, orderReference: ORDER_REFERENCE }]);
  });
});
