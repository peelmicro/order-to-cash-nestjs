// The `InvoiceReference` (`INV-######`) allocation counter (`billing_invoicing`
// feature) — byte-for-byte the shape of
// `apps/fulfillment/.../schema/despatch-number-sequences.schema.ts` (design.md
// §6, §7.3): a single-row table used as the concurrency-safe sequence
// generator (domain-model.md §2.3), incremented under `SELECT ... FOR
// UPDATE` + `UPDATE` by `DrizzleInvoiceNumberAllocator`. Not a business
// entity: no `created_at`/`updated_at`, a technical allocation primitive.
import { int, mysqlTable, tinyint } from 'drizzle-orm/mysql-core';

export const INVOICE_NUMBER_SEQUENCE_ROW_ID = 1;

export const invoiceNumberSequences = mysqlTable('invoice_number_sequences', {
  id: tinyint('id').primaryKey(),
  nextValue: int('next_value').notNull(),
});
