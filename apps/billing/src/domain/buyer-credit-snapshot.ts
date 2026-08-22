// The reconstitution input type — design.md §3.1, mirrors
// `apps/fulfillment/src/domain/stock-item-snapshot.ts`. A domain-shaped
// structure of value objects, not a Drizzle row: the repository adapter
// maps rows -> snapshot.
//
// **What the aggregate holds, honestly (design.md §3.1).** `BuyerCredit` is
// reconstituted with (a) the `credits` row, (b) `committedExposure` — one
// scalar, the `BC5` two-term sum over the WHOLE line, computed in SQL —
// and (c) the complete entry list of the ONE order the command names,
// which is all B4/B5/BC7 need. It never loads the whole ledger.
import type { CreditLineReference, UniqueId } from '@otc/shared-kernel';
import type { CreditLedgerEntrySnapshot } from './credit-ledger-entry.js';

export interface BuyerCreditSnapshot {
  readonly id: UniqueId;
  readonly code: CreditLineReference;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly creditLimit: number;
  readonly currency: string;
  /** The BC5 scalar over the WHOLE line — `Σhold − Σrelease`, computed in SQL, `FOR UPDATE`. */
  readonly committedExposure: number;
  /** Only the entries of the ONE order the command names (design.md §3.1). */
  readonly orderEntries: readonly CreditLedgerEntrySnapshot[];
}
