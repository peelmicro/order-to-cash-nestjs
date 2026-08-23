// Rows <-> `Invoice` aggregate (design.md §7). Adapter-internal: no query
// lives here, only shape translation. Mirrors `buyer-credit.mapper.ts`'s
// split. **This is the one place the store-side half of `BI10` is
// closed** — `paid_at` is read straight off the row and handed to
// `Invoice.reconstitute`, which refuses a row whose `status`/`paid_at`
// disagree (B9) — and the one place the two vocabularies
// (`InvoiceLine` the class / `invoice_items` the table) meet (open-point
// row 8).
import { InvoiceReference, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { InvoiceLineSnapshot } from '../../domain/invoice-line.js';
import type { InvoiceSnapshot } from '../../domain/invoice-snapshot.js';
import { Invoice } from '../../domain/invoice.js';
import type { invoiceItems, invoices } from './schema';

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceItemRow = typeof invoiceItems.$inferSelect;

export function toInvoiceSnapshot(row: InvoiceRow, itemRows: readonly InvoiceItemRow[]): InvoiceSnapshot {
  return {
    id: UniqueId.from(row.id),
    invoiceReference: InvoiceReference.of(row.invoiceReference),
    invoiceDate: row.invoiceDate,
    orderReference: OrderNumber.of(row.orderReference),
    retailerCode: row.retailerCode,
    companyCode: row.companyCode,
    currency: row.currencyCode,
    lines: itemRows.map(
      (item): InvoiceLineSnapshot => ({
        id: UniqueId.from(item.id),
        productCode: item.productCode,
        units: Quantity.of(item.units),
        unitPrice: Money.of(item.price, row.currencyCode),
      }),
    ),
    amount: Money.of(row.amount, row.currencyCode),
    discount: Money.of(row.discount, row.currencyCode),
    totalAmount: Money.of(row.totalAmount, row.currencyCode),
    status: row.status,
    paidAt: row.paidAt,
  };
}

export function reconstituteInvoice(row: InvoiceRow, itemRows: readonly InvoiceItemRow[]): Invoice {
  return Invoice.reconstitute(toInvoiceSnapshot(row, itemRows));
}

/** One `invoices` row for one `save()` — INSERT only, never an UPDATE on the issue path (feature 22 adds `markPaid`'s UPDATE to this same file). */
export interface InvoiceTableRow {
  id: string;
  invoiceReference: string;
  invoiceDate: Date;
  companyCode: string;
  retailerCode: string;
  orderReference: string;
  amount: number;
  discount: number;
  totalAmount: number;
  currencyCode: string;
  status: 'issued' | 'paid';
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One `invoice_items` row per line for one `save()`. */
export interface InvoiceItemTableRow {
  id: string;
  invoiceId: string;
  productCode: string;
  units: number;
  price: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toInvoiceTableRow(invoice: Invoice, timestamps: { readonly createdAt: Date; readonly updatedAt: Date }): InvoiceTableRow {
  return {
    id: invoice.id.value,
    invoiceReference: invoice.invoiceReference.value,
    invoiceDate: invoice.invoiceDate,
    companyCode: invoice.companyCode,
    retailerCode: invoice.retailerCode,
    orderReference: invoice.orderReference.value,
    amount: invoice.amount.amount,
    discount: invoice.discount.amount,
    totalAmount: invoice.totalAmount.amount,
    currencyCode: invoice.currency,
    status: invoice.status,
    paidAt: invoice.paidAt,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  };
}

export function toInvoiceItemTableRows(invoice: Invoice, timestamps: { readonly createdAt: Date; readonly updatedAt: Date }): InvoiceItemTableRow[] {
  return invoice.lines.map((line) => ({
    id: line.id.value,
    invoiceId: invoice.id.value,
    productCode: line.productCode,
    units: line.units.value,
    price: line.unitPrice.amount,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  }));
}
