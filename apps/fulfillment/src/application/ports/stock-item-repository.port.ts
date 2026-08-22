// The write-model port for `stock.reserve`/`stock.release`/`stock.replenish`
// (design.md §5.2, §7) — locking loads and the drain-on-save discipline
// `apps/orders/.../order-repository.port.ts` established.
import type { OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { StockItem } from '../../domain/stock-item.js';
import type { TransactionContext } from './unit-of-work.port.js';

export const STOCK_ITEM_REPOSITORY = Symbol('StockItemRepository');

export interface StockItemRepository {
  /**
   * `FOR UPDATE`, one statement, `ORDER BY (company_code, product_code)`
   * (design.md §4.3 step 1). Loads, for each item, ONLY the reservations of
   * `orderReference` (design.md §3.1). Unknown product codes are simply
   * absent from the returned `Map`.
   */
  lockForOrder(
    tx: TransactionContext,
    companyCode: string,
    productCodes: readonly string[],
    orderReference: OrderNumber,
  ): Promise<ReadonlyMap<string, StockItem>>;

  /** Non-locking pre-read for release (design.md §4.4 step 0) — the distinct stock ids the order's reservations point at. */
  stockIdsOfOrder(orderReference: OrderNumber): Promise<readonly UniqueId[]>;

  /** `FOR UPDATE` by id list, index-ordered (design.md §4.4 step 1), loading the order's reservations. */
  lockByIdsForOrder(tx: TransactionContext, ids: readonly UniqueId[], orderReference: OrderNumber): Promise<readonly StockItem[]>;

  /** `FOR UPDATE`, one statement, index-ordered, by explicit `(companyCode, productCode)` pairs — the replenish flow's lock (no order to scope reservations by). */
  lockByProductCodes(
    tx: TransactionContext,
    companyCode: string,
    productCodes: readonly string[],
  ): Promise<ReadonlyMap<string, StockItem>>;

  /** Upserts each item's row and its loaded reservations, then drains EVERY item's `pullDomainEvents()` into the outbox, all inside `tx` (R13). `tx` required — never opens its own. */
  saveAll(items: readonly StockItem[], tx: TransactionContext): Promise<void>;
}
