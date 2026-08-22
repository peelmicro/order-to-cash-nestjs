// Rows <-> `BuyerCredit` aggregate (design.md §7). Adapter-internal: no
// query lives here, only shape translation. Mirrors
// `apps/fulfillment/.../stock-item.mapper.ts`'s split.
import { CreditLineReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { BuyerCreditSnapshot } from '../../domain/buyer-credit-snapshot.js';
import type { CreditEntryType } from '../../domain/credit-ledger-entry.js';
import { BuyerCredit } from '../../domain/buyer-credit.js';
import type { creditItems, credits } from './schema';

export type CreditRow = typeof credits.$inferSelect;
export type CreditItemRow = typeof creditItems.$inferSelect;

export function toBuyerCreditSnapshot(row: CreditRow, committedExposure: number, orderItemRows: readonly CreditItemRow[]): BuyerCreditSnapshot {
  return {
    id: UniqueId.from(row.id),
    code: CreditLineReference.of(row.code),
    retailerCode: row.retailerCode,
    companyCode: row.companyCode,
    creditLimit: row.creditLimit,
    currency: row.currencyCode,
    committedExposure,
    orderEntries: orderItemRows.map((item) => ({
      id: UniqueId.from(item.id),
      orderReference: OrderNumber.of(item.orderReference),
      amount: Money.of(item.amount, row.currencyCode),
      type: item.type as CreditEntryType,
      entryDate: item.creditDate,
    })),
  };
}

export function reconstituteBuyerCredit(row: CreditRow, committedExposure: number, orderItemRows: readonly CreditItemRow[]): BuyerCredit {
  return BuyerCredit.reconstitute(toBuyerCreditSnapshot(row, committedExposure, orderItemRows));
}

/** One `credit_items` row for one `save()` — INSERT only, never an UPDATE (B2). */
export interface CreditItemTableRow {
  id: string;
  creditId: string;
  orderReference: string;
  amount: number;
  type: CreditEntryType;
  creditDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function toCreditItemTableRows(
  credit: BuyerCredit,
  timestamps: { readonly createdAt: Date; readonly updatedAt: Date },
): CreditItemTableRow[] {
  return credit.appendedEntries.map((entry) => ({
    id: entry.id.value,
    creditId: credit.id.value,
    orderReference: entry.orderReference.value,
    amount: entry.amount.amount,
    type: entry.type,
    creditDate: entry.entryDate,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  }));
}
