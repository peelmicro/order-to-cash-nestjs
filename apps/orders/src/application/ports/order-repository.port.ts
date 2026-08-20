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
   * Persists the aggregate AND drains its uncommitted domain events into
   * the outbox, inside `tx`. Never opens a transaction of its own — `tx`
   * is required, not optional (R13): a write outside a transaction is
   * precisely the dual-write R13 forbids, so the type system refuses it.
   */
  save(order: Order, tx: TransactionContext): Promise<void>;
}
