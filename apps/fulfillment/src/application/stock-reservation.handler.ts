// The reserve/release transactional flow (design.md §4.3, §4.4, §5.3) as a
// PLAIN class (no decorator) — the `@CommandHandler` wrappers in
// `commands/stock.command-handlers.ts` delegate to this, the same split
// `SagaFactHandler` uses so a unit test can `new` it with fakes.
import { OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type {
  StockReleaseReplyPayload,
  StockReserveReplyPayload,
} from '@otc/contracts';
import type { ReleaseStockCommand, ReserveStockCommand } from './commands/stock.commands.js';
import type { Clock } from './ports/clock.port.js';
import type { StockItemRepository } from './ports/stock-item-repository.port.js';
import type { UnitOfWork } from './ports/unit-of-work.port.js';
import { ConcurrentReservationChangeError, NoKnownStockItemError } from './stock-application-errors.js';
import { releaseOrderStock, reserveOrderStock } from '../domain/order-stock-reservation.js';
import type { StockContext } from '../domain/stock-item.js';

export class StockReservationHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly stock: StockItemRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * §4.3: `unitOfWork.execute(tx => lockForOrder → if any reservation rows
   * for the order already loaded on any item → build already_reserved from
   * them (no domain call, nothing written) → else reserveOrderStock(...) →
   * saveAll(items) → map outcome to reply)`. The reply is built from the
   * domain outcome BEFORE commit but returned only AFTER `execute` resolves,
   * so a rollback can never have produced a success reply. Throws
   * `NoKnownStockItemError` when no line resolves to a known item (→
   * `NOT_FOUND`, design.md §3.3).
   */
  async reserve(cmd: ReserveStockCommand): Promise<StockReserveReplyPayload> {
    const request = cmd.request;
    const orderReference = OrderNumber.of(request.orderReference);
    const distinctProductCodes = [...new Set(request.lines.map((line) => line.productCode))];

    return this.unitOfWork.execute(async (tx) => {
      const itemsByProduct = await this.stock.lockForOrder(tx, request.companyCode, distinctProductCodes, orderReference);
      const items = [...itemsByProduct.values()];

      const existingReservations = items.flatMap((item) =>
        item.reservations.filter((reservation) => reservation.orderReference.equals(orderReference)),
      );
      if (existingReservations.length > 0) {
        // FS5 — responder idempotency: ANY reservation rows for the order,
        // whatever their status, short-circuit before any domain call.
        return {
          outcome: 'already_reserved' as const,
          orderReference: request.orderReference,
          reservations: existingReservations.map((reservation) => ({
            reservationId: reservation.id.value,
            productCode: reservation.productCode,
            units: reservation.units.value,
          })),
        };
      }

      const ctx: StockContext = { occurredAt: this.clock.now(), causationId: cmd.requestId };
      const outcome = reserveOrderStock(
        items,
        {
          orderReference,
          companyCode: request.companyCode,
          retailerCode: request.retailerCode,
          lines: request.lines.map((line) => ({ productCode: line.productCode, units: Quantity.of(line.units) })),
          correlationId: cmd.correlationId,
        },
        ctx,
        () => UniqueId.generate(),
      );

      if (outcome.kind === 'rejected' && !outcome.carrier) {
        throw new NoKnownStockItemError(request.orderReference);
      }

      // Persists the counters/reservation rows AND drains the carrier's
      // pending fact into the outbox, all inside `tx` (R13) — for BOTH the
      // reserved and the rejected-with-carrier outcome.
      await this.stock.saveAll(items, tx);

      if (outcome.kind === 'reserved') {
        return { outcome: 'accepted' as const, orderReference: request.orderReference, reservations: [...outcome.reservations] };
      }
      return { outcome: 'rejected' as const, orderReference: request.orderReference, shortages: [...outcome.shortages] };
    });
  }

  /**
   * §4.4: a non-locking pre-read of the order's stock ids first — an order
   * with NO reservation at all short-circuits to `already_released` WITHOUT
   * opening a transaction (FS9). Otherwise locks those stock rows
   * (index-ordered) and the order's reservations, then
   * `releaseOrderStock(...)`. Lets `ReservationTerminalError` propagate
   * unchanged (→ `PRECONDITION_FAILED`, FS10).
   */
  async release(cmd: ReleaseStockCommand): Promise<StockReleaseReplyPayload> {
    const request = cmd.request;
    const orderReference = OrderNumber.of(request.orderReference);

    const stockIds = await this.stock.stockIdsOfOrder(orderReference);
    if (stockIds.length === 0) {
      return { outcome: 'already_released', orderReference: request.orderReference, released: [] };
    }

    return this.unitOfWork.execute(async (tx) => {
      const items = await this.stock.lockByIdsForOrder(tx, stockIds, orderReference);
      if (items.length !== stockIds.length) {
        // Defensive: the pre-read named a stock id the locking read did not
        // confirm — abort rather than release under a lock not held.
        throw new ConcurrentReservationChangeError(request.orderReference);
      }

      const ctx: StockContext = { occurredAt: this.clock.now(), causationId: cmd.requestId };
      const outcome = releaseOrderStock(
        items,
        {
          orderReference,
          companyCode: items[0]!.companyCode,
          reason: request.reason,
          correlationId: cmd.correlationId,
        },
        ctx,
      );

      if (outcome.kind === 'already_released') {
        return { outcome: 'already_released' as const, orderReference: request.orderReference, released: [] };
      }

      await this.stock.saveAll(items, tx);
      return { outcome: 'released' as const, orderReference: request.orderReference, released: [...outcome.released] };
    });
  }
}
