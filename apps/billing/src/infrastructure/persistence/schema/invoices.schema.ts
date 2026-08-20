// The `Invoice` aggregate root's write model (INVOIC, domain-model.md §5.2).
// `companyCode`, `retailerCode`, `orderReference` are business identifiers
// carried in messages — deliberately NOT a foreign key into the Orders
// database (CLAUDE.md § Database per service).
import { char, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

// domain-model.md §5.2: `status` is `issued` | `paid`. varchar, deliberately
// NOT a MySQL ENUM — same reasoning as every other status column in this
// schema (the domain owns the state machine, §5.3).
export const INVOICE_STATUS_VALUES = ['issued', 'paid'] as const;

export type InvoiceStatusRow = (typeof INVOICE_STATUS_VALUES)[number];

export const invoices = mysqlTable('invoices', {
  id: char('id', { length: 36 }).primaryKey(),
  invoiceReference: varchar('invoice_reference', { length: 20 }).notNull().unique(),
  invoiceDate: datetime('invoice_date', { mode: 'date' }).notNull(),
  companyCode: varchar('company_code', { length: 20 }).notNull(),
  retailerCode: varchar('retailer_code', { length: 20 }).notNull(),
  orderReference: varchar('order_reference', { length: 20 }).notNull(),
  // Integer minor units (CLAUDE.md § Money) — never a float. Derived from
  // lines (§5.2), stored here as the aggregate's snapshotted totals — never
  // set directly by a caller, same "totals are derived" pattern as
  // orders.initial_amount/initial_discount/total_amount.
  amount: int('amount').notNull(),
  discount: int('discount').notNull(),
  totalAmount: int('total_amount').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  status: varchar('status', { length: 20 }).$type<InvoiceStatusRow>().notNull(),
  // B9: present iff status = paid, unset while issued.
  paidAt: datetime('paid_at', { mode: 'date' }),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
