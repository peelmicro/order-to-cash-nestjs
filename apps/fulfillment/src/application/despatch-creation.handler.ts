// The despatch.create transactional flow — the same plain-class split
// `StockReservationHandler` uses (design.md §5.3), so a unit test can `new`
// it with fakes. Reuses feature 17's lock protocol UNCHANGED
// (`StockItemRepository.stockIdsOfOrder` + `.lockByIdsForOrder`, the same
// stock-rows-first FOR UPDATE ordering `stock.release` established) rather
// than inventing a new one — the task brief's explicit instruction.
import { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { DespatchCreateReplyPayload, DespatchLine } from '@otc/contracts';
import type { CreateDespatchCommand } from './commands/despatch.commands.js';
import type { Clock } from './ports/clock.port.js';
import type { DespatchNumberAllocator } from './ports/despatch-number-allocator.port.js';
import type { DespatchRepository } from './ports/despatch-repository.port.js';
import type { StockItemRepository } from './ports/stock-item-repository.port.js';
import type { UnitOfWork } from './ports/unit-of-work.port.js';
import { NoReservedStockForDespatchError } from './despatch-application-errors.js';
import { ConcurrentReservationChangeError } from './stock-application-errors.js';
import { createDespatchForOrder } from '../domain/order-despatch.js';
import type { StockContext } from '../domain/stock-item.js';
import type { DespatchAdviceSnapshot } from '../domain/despatch-advice-snapshot.js';

function replyFromSnapshot(
  snapshot: DespatchAdviceSnapshot,
  created: boolean,
): DespatchCreateReplyPayload {
  return {
    orderReference: snapshot.orderReference,
    despatchReference: snapshot.despatchReference,
    despatchDate: snapshot.despatchDate.toISOString(),
    created,
    lines: snapshot.lines.map((line): DespatchLine => ({
      productCode: line.productCode,
      units: line.units,
    })),
  };
}

export class DespatchCreationHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly stock: StockItemRepository,
    private readonly despatches: DespatchRepository,
    private readonly despatchNumbers: DespatchNumberAllocator,
    private readonly clock: Clock,
  ) {}

  /**
   * F8 fast path first (no transaction opened for the common repeat case),
   * then the same stock-rows-first lock protocol `stock.release` uses.
   * Inside the lock: no reservation at all for the order names a genuine
   * `NoReservedStockForDespatchError` (R36); reservations already
   * `consumed` (a repeat that raced the fast path, or ran concurrently with
   * the first caller) return the now-committed existing despatch, still no
   * second fact; otherwise `createDespatchForOrder` consumes the `reserved`
   * ones and creates the `DespatchAdvice`.
   */
  async create(cmd: CreateDespatchCommand): Promise<DespatchCreateReplyPayload> {
    const orderReference = OrderNumber.of(cmd.request.orderReference);

    const existing = await this.despatches.findByOrderReference(orderReference);
    if (existing) {
      return replyFromSnapshot(existing, false);
    }

    const stockIds = await this.stock.stockIdsOfOrder(orderReference);
    if (stockIds.length === 0) {
      throw new NoReservedStockForDespatchError(cmd.request.orderReference);
    }

    return this.unitOfWork.execute(async (tx) => {
      const items = await this.stock.lockByIdsForOrder(tx, stockIds, orderReference);
      if (items.length !== stockIds.length) {
        // Defensive — mirrors StockReservationHandler.release's identical guard.
        throw new ConcurrentReservationChangeError(cmd.request.orderReference);
      }

      const orderReservations = items.flatMap((item) =>
        item.reservations.filter((r) => r.orderReference.equals(orderReference)),
      );
      const anyReserved = orderReservations.some((r) => r.status === 'reserved');

      if (!anyReserved) {
        const anyConsumed = orderReservations.some((r) => r.status === 'consumed');
        if (anyConsumed) {
          // F8 — the fast path above raced a concurrent despatch.create that
          // has since committed (it holds the same stock locks first); now
          // that we hold them too, its write is guaranteed visible.
          const existingAfterLock = await this.despatches.findByOrderReference(orderReference);
          if (!existingAfterLock) {
            throw new Error(
              `despatch-creation: order ${cmd.request.orderReference}'s reservations show consumed but no despatch row exists`,
            );
          }
          return replyFromSnapshot(existingAfterLock, false);
        }
        // Every reservation is released (compensation ran) — R36's refusal.
        throw new NoReservedStockForDespatchError(cmd.request.orderReference);
      }

      const companyCode = items[0]!.companyCode;
      const retailerCode = orderReservations.find((r) => r.status === 'reserved')!.retailerCode;
      const ctx: StockContext = { occurredAt: this.clock.now(), causationId: cmd.requestId };
      const despatchReference = await this.despatchNumbers.next(tx);

      const outcome = createDespatchForOrder(
        items,
        { orderReference, companyCode, retailerCode, correlationId: cmd.correlationId },
        despatchReference,
        ctx,
        () => UniqueId.generate(),
      );

      if (outcome.kind === 'no_reservations') {
        // Unreachable given anyReserved === true above — defensive.
        throw new NoReservedStockForDespatchError(cmd.request.orderReference);
      }

      await this.stock.saveAll(items, tx);
      await this.despatches.save(outcome.despatch, tx);

      return {
        orderReference: cmd.request.orderReference,
        despatchReference: despatchReference.value,
        despatchDate: ctx.occurredAt.toISOString(),
        created: true,
        lines: outcome.despatch.lines.map((line): DespatchLine => ({
          productCode: line.productCode,
          units: line.units.value,
        })),
      };
    });
  }
}
