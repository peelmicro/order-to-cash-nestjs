// The `DespatchAdvice` aggregate root (DESADV, domain-model.md §4.3).
// `orderReference`, `companyCode`, `retailerCode` are business identifiers
// carried in messages, never FKs into the Orders database (CLAUDE.md
// § Database per service).
import { char, datetime, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const despatches = mysqlTable('despatches', {
  id: char('id', { length: 36 }).primaryKey(),
  despatchReference: varchar('despatch_reference', { length: 20 }).notNull().unique(),
  despatchDate: datetime('despatch_date', { mode: 'date' }).notNull(),
  companyCode: varchar('company_code', { length: 20 }).notNull(),
  retailerCode: varchar('retailer_code', { length: 20 }).notNull(),
  orderReference: varchar('order_reference', { length: 20 }).notNull(),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
