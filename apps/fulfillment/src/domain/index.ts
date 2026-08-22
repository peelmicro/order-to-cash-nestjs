// The deliberate public surface of the Fulfillment domain — design.md §2.
// The aggregate, its child entity, the pure order-scoped service, the fact
// builders, the domain errors and the snapshot shapes. Everything else in
// this directory stays internal and is reached only through what is
// exported here.
export { StockItem, type StockContext } from './stock-item.js';

export { Reservation, RESERVATION_STATUSES, type ReservationStatus, type ReservationView } from './reservation.js';

export {
  reserveOrderStock,
  releaseOrderStock,
  type ReleaseOrderOutcome,
  type ReserveOrderInput,
  type ReserveOrderLine,
  type ReserveOrderOutcome,
} from './order-stock-reservation.js';

export { stockRejectedEvent, stockReleasedEvent, stockReservedEvent } from './stock-events.js';

export {
  FactAggregateMismatchError,
  InsufficientStockError,
  InvalidStockItemSnapshotError,
  ReservationTerminalError,
  UnknownReservationError,
} from './stock-errors.js';

export type { StockItemSnapshot } from './stock-item-snapshot.js';
export type { ReservationSnapshot } from './reservation.js';
