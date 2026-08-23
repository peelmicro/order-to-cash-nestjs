// The `InvoiceReference` allocation port (`billing_invoicing` design.md
// §5.2, §7.3) — mirrors `apps/fulfillment/.../despatch-number-allocator.port.ts`
// exactly, one word changed.
import type { InvoiceReference } from '@otc/shared-kernel';
import type { TransactionContext } from './unit-of-work.port.js';

export const INVOICE_NUMBER_ALLOCATOR = Symbol('InvoiceNumberAllocator');

export interface InvoiceNumberAllocator {
  /**
   * Allocates the next `InvoiceReference`, inside `tx` — never opens a
   * transaction of its own. Must be concurrency-safe: two callers racing
   * this method must never receive the same value (see
   * `invoice-number-allocator.ts` for the mechanism, the same InnoDB
   * counter-table recipe `DrizzleDespatchNumberAllocator` uses). ALWAYS the
   * LAST lock taken in this service's issue transaction (`BI8`) — the
   * counter row is a global hot spot every invoice contends on.
   */
  next(tx: TransactionContext): Promise<InvoiceReference>;
}
