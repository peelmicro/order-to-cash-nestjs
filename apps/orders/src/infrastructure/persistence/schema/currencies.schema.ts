// Reference catalogue — ISO 4217 currencies. Owned by the Orders context
// (see specs/shared/domain-model.md §1): products, retailers and companies
// all carry a currency, and an order's lines and totals share one.
import { char, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const currencies = mysqlTable('currencies', {
  id: char('id', { length: 36 }).primaryKey(),
  // ISO 4217 alpha-3, e.g. "EUR".
  code: varchar('code', { length: 3 }).notNull().unique(),
  isoNumber: varchar('iso_number', { length: 3 }).notNull(),
  symbol: varchar('symbol', { length: 5 }).notNull(),
  decimalPoints: int('decimal_points').notNull(),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
