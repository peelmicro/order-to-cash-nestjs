// The `DespatchReference` allocation port (fulfillment_despatch feature) —
// mirrors `apps/orders/.../order-number-allocator.port.ts` exactly.
import type { DespatchReference } from '@otc/shared-kernel';
import type { TransactionContext } from './unit-of-work.port.js';

export const DESPATCH_NUMBER_ALLOCATOR = Symbol('DespatchNumberAllocator');

export interface DespatchNumberAllocator {
  /**
   * Allocates the next `DespatchReference`, inside `tx` — never opens a
   * transaction of its own. Must be concurrency-safe: two callers racing
   * this method must never receive the same value (see
   * `despatch-number-allocator.ts` for the mechanism, the same InnoDB
   * counter-table recipe `DrizzleOrderNumberAllocator` uses).
   */
  next(tx: TransactionContext): Promise<DespatchReference>;
}
