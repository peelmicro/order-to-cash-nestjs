// `InvoiceLine` — the ordered list of lines on an `Invoice`
// (domain-model.md §5.2: `lines` — `productCode`, `units`, `unitPrice`).
// `invoiceId` is a local FK within this one service's database,
// cascade-deleted with the parent invoice (same pattern as
// orders/order_items and fulfillment despatches/despatch_items).
import { char, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { invoices } from './invoices.schema';

export const invoiceItems = mysqlTable('invoice_items', {
  id: char('id', { length: 36 }).primaryKey(),
  invoiceId: char('invoice_id', { length: 36 })
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  productCode: varchar('product_code', { length: 30 }).notNull(),
  units: int('units').notNull(),
  // Integer minor units (CLAUDE.md § Money) — never a float.
  price: int('price').notNull(),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
