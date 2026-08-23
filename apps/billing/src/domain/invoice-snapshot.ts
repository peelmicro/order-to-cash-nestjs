// The reconstitution input type — design.md §3.1, mirrors
// `buyer-credit-snapshot.ts`. A domain-shaped structure of value objects,
// not a Drizzle row: the repository adapter maps rows -> snapshot
// (`invoice.mapper.ts`).
import type { InvoiceReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { InvoiceLineSnapshot } from './invoice-line.js';

export interface InvoiceSnapshot {
  readonly id: UniqueId;
  readonly invoiceReference: InvoiceReference;
  readonly invoiceDate: Date;
  readonly orderReference: OrderNumber;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly currency: string;
  readonly lines: readonly InvoiceLineSnapshot[];
  /** The stored, snapshotted totals (B6) — reconstitute recomputes from `lines` and refuses a disagreement. */
  readonly amount: Money;
  readonly discount: Money;
  readonly totalAmount: Money;
  readonly status: 'issued' | 'paid';
  /** B9: present iff status = paid, null while issued. */
  readonly paidAt: Date | null;
}
