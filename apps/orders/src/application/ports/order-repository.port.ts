// The application's requirement of the outside world — design.md §4.2. The
// port interface landed in feature 13; this is the revision `orders_aggregate`
// §8 promised: "feature 14 will add a transactional-context parameter to
// `save` (`save(order, tx)` or a unit-of-work wrapper)". The first option
// is taken. `Symbol` is used as the injection token so this file needs no
// `@nestjs/common` import.
//
// The Drizzle adapter (`DrizzleOrderRepository`) also lands in THIS
// feature, bounded to `save`/`findById`/`findByReference` and the row <->
// aggregate mapping — a deliberate reversal of `orders_aggregate` §8's
// deferral to feature 15, argued in design.md §4.3 and ratified at the
// approval gate (progress/spec_outbox_and_idempotency.md §7, open point
// 11). No order-number allocation, no NATS, no command handler: those stay
// in feature 15.
import type { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { Order } from '../../domain/order.js';
import type { TransactionContext } from './unit-of-work.port.js';

export const ORDER_REPOSITORY = Symbol('OrderRepository');

export interface OrderRepository {
  /** Reads outside a transaction by default; pass `tx` to read your own uncommitted writes. */
  findById(id: UniqueId, tx?: TransactionContext): Promise<Order | null>;
  findByReference(reference: OrderNumber, tx?: TransactionContext): Promise<Order | null>;
  /**
   * RI1/RI2's lookup (`observability_reliability` design.md §3.2) — reads
   * outside a transaction by default; pass `tx` to read your own
   * uncommitted writes (RI3's re-read-the-winner path, inside the same
   * transaction as the losing `save`'s duplicate-key catch).
   */
  findByRequestId(requestId: string, tx?: TransactionContext): Promise<Order | null>;
  /**
   * Persists the aggregate AND drains its uncommitted domain events into
   * the outbox, inside `tx`. Never opens a transaction of its own — `tx`
   * is required, not optional (R13): a write outside a transaction is
   * precisely the dual-write R13 forbids, so the type system refuses it.
   *
   * `requestId`, when supplied, is written ONLY on a genuine INSERT (a
   * brand-new order carrying `order.placed.v1` among its pulled domain
   * events) — never on the UPDATE path a saga-step transition takes, since
   * `requestId` is set once, at placement, and never revisited. A
   * collision on `uq_orders_request_id` propagates as a raw duplicate-key
   * error (RI3) rather than being swallowed here — `PlaceOrderHandler`
   * decides what a collision means, the repository only reports it.
   */
  save(order: Order, tx: TransactionContext, requestId?: string): Promise<void>;
}
