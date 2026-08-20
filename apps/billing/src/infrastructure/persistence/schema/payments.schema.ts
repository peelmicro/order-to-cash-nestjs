// `Payment` — the remittance child entity of `Invoice` (domain-model.md
// §5.2). `invoiceId` is a local FK within this one service's database.
// `paymentReference` is the idempotency key of the remittance intake
// endpoint (B10: a Payment is recorded at most once per paymentReference).
//
// No `updated_at` — the blanket "All tables: id, created_at" rule from this
// feature's task prompt carves out `payments` explicitly (a remittance is
// recorded once and never mutated, same append-only reasoning as
// processed_events).
import { char, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { invoices } from './invoices.schema';

// domain-model.md §5.2: `source` is `operator` | `robot` | `test`. varchar,
// deliberately NOT a MySQL ENUM — same reasoning as every other status/type
// column in this schema. Per the task prompt's explicit instruction: `robot`
// (not `n8n`), an approved spec decision — provenance is a role, not the
// name of whichever automation tool plays it.
export const PAYMENT_SOURCE_VALUES = ['operator', 'robot', 'test'] as const;

export type PaymentSourceRow = (typeof PAYMENT_SOURCE_VALUES)[number];

export const payments = mysqlTable('payments', {
  id: char('id', { length: 36 }).primaryKey(),
  paymentReference: varchar('payment_reference', { length: 30 }).notNull().unique(),
  invoiceId: char('invoice_id', { length: 36 })
    .notNull()
    .references(() => invoices.id),
  // Integer minor units (CLAUDE.md § Money) — never a float.
  amount: int('amount').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  valueDate: datetime('value_date', { mode: 'date' }).notNull(),
  source: varchar('source', { length: 20 }).$type<PaymentSourceRow>().notNull(),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
});
