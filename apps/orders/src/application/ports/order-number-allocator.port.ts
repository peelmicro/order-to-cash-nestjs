// The `OrderNumber` allocation port (`orders_acceptance` feature —
// `orders_aggregate/design.md` §4.2 deferred sequence allocation here as "a
// persistence concern"). `orderReference` is pre-allocated by the caller
// BEFORE `Order.place(...)` runs, so this port is consulted from the
// application-layer command handler, not from the aggregate.
import type { OrderNumber } from '@otc/shared-kernel';
import type { TransactionContext } from './unit-of-work.port';

export const ORDER_NUMBER_ALLOCATOR = Symbol('OrderNumberAllocator');

export interface OrderNumberAllocator {
  /**
   * Allocates the next `OrderNumber`, inside `tx` — never opens a
   * transaction of its own, the same asymmetry `OrderRepository.save`
   * already establishes (outbox_and_idempotency design.md §4.2). Must be
   * concurrency-safe: two callers racing this method must never receive the
   * same value (see `order-number-allocator.ts` for the mechanism and why).
   */
  next(tx: TransactionContext): Promise<OrderNumber>;
}
