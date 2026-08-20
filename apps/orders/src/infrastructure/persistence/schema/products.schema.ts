// Reference catalogue — products sold to retailers. `price` is snapshotted
// per order line at order time (domain-model.md §3.1); this row is the
// current catalogue price only.
import { char, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { currencies } from './currencies.schema';

export const products = mysqlTable('products', {
  id: char('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 30 }).notNull().unique(),
  // EAN-13 barcode.
  ean: varchar('ean', { length: 13 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: varchar('description', { length: 255 }).notNull(),
  // Integer minor units (CLAUDE.md § Money) — never a float.
  price: int('price').notNull(),
  currencyId: char('currency_id', { length: 36 })
    .notNull()
    .references(() => currencies.id),
  disabledAt: datetime('disabled_at', { mode: 'date' }),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
