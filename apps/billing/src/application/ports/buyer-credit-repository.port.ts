// The write-model port for `credit.hold` (design.md §5.2, §7) — the
// locking load and the drain-on-save discipline
// `apps/fulfillment/.../stock-item-repository.port.ts` established.
import type { OrderNumber } from '@otc/shared-kernel';
import type { BuyerCredit } from '../../domain/buyer-credit.js';
import type { TransactionContext } from './unit-of-work.port.js';

export const BUYER_CREDIT_REPOSITORY = Symbol('BuyerCreditRepository');

export interface BuyerCreditRepository {
  /**
   * §5.5 steps 1-3: `FOR UPDATE` on the `credits` row of `(retailerCode,
   * companyCode)`; then, under that lock, the scalar `committedExposure`
   * and the complete entry list of `orderReference`. Resolves to `null`
   * when no credit line exists (BC3) — the caller turns that into
   * `CreditLineNotFoundError`, and no transaction has written anything.
   */
  lockForOrder(
    tx: TransactionContext,
    retailerCode: string,
    companyCode: string,
    orderReference: OrderNumber,
  ): Promise<BuyerCredit | null>;

  /** INSERTs `credit.appendedEntries` (never an UPDATE, never a DELETE — B2), then drains `credit.pullDomainEvents()` into the outbox, all inside `tx` (R13). `tx` required — never opens its own. */
  save(credit: BuyerCredit, tx: TransactionContext): Promise<void>;
}
