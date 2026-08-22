// The domain errors of the `StockItem` aggregate and its `Reservation`
// child entity — design.md §3.4. Every class extends `DomainError`
// (`@otc/shared-kernel`), carries a stable `code` and the fields a caller
// (and a test) needs, the same shape `apps/orders/src/domain/order-errors.ts`
// established. Codes are the vocabulary `rpc-error-mapper.ts` (§6.4)
// translates into the AsyncAPI `RpcError.code` vocabulary.
import { DomainError, type UniqueId } from '@otc/shared-kernel';
import type { ReservationStatus } from './reservation.js';

/** F1 (`R30`) — a `reserve` that would push `reservedUnits` above `units`. */
export class InsufficientStockError extends DomainError {
  readonly code = 'INSUFFICIENT_STOCK';

  constructor(
    readonly productCode: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(
      `product ${productCode}: requested ${requested} unit(s) but only ${available} available (invariant F1)`,
    );
  }
}

/** F4 — `release`/`consume` attempted on a reservation whose status is already terminal (`released` or `consumed`). */
export class ReservationTerminalError extends DomainError {
  readonly code = 'RESERVATION_TERMINAL';

  constructor(
    readonly reservationId: UniqueId,
    readonly from: ReservationStatus,
    readonly attempted: 'release' | 'consume',
  ) {
    super(`reservation ${reservationId.value}: cannot ${attempted} from terminal status "${from}"`);
  }
}

/** `StockItem.reconstitute` given a snapshot that violates F1 (`reservedUnits > units`) or carries a negative counter. */
export class InvalidStockItemSnapshotError extends DomainError {
  readonly code = 'INVALID_STOCK_ITEM_SNAPSHOT';

  constructor(
    readonly reason: string,
    readonly stockItemId?: UniqueId,
  ) {
    super(`${stockItemId ? `stock item ${stockItemId.value}: ` : ''}invalid snapshot: ${reason}`);
  }
}

/** `StockItem.recordOrderFact` refuses an envelope whose `aggregateId` is not this item's own id — the one guard keeping the method from being a generic "emit anything" hole (design.md §3.1). */
export class FactAggregateMismatchError extends DomainError {
  readonly code = 'FACT_AGGREGATE_MISMATCH';

  constructor(
    readonly stockItemId: UniqueId,
    readonly eventAggregateId: UniqueId,
  ) {
    super(
      `stock item ${stockItemId.value}: refuses to record a fact whose aggregateId (${eventAggregateId.value}) is not its own`,
    );
  }
}

/** Raised when a caller names a reservation id this `StockItem` does not hold — defensive; the repository only ever loads reservations that belong to the item it attaches them to. */
export class UnknownReservationError extends DomainError {
  readonly code = 'UNKNOWN_RESERVATION';

  constructor(
    readonly stockItemId: UniqueId,
    readonly reservationId: UniqueId,
  ) {
    super(`stock item ${stockItemId.value}: no reservation with id ${reservationId.value}`);
  }
}
