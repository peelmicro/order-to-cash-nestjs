// Reference catalogue — companies (suppliers). Same shape as `retailers`
// (spec §"Tables"), kept as a separate table rather than a shared "party"
// table because the two roles never share identity or a foreign key in
// this schema — see CLAUDE.md § Database per service / no cross-context FKs.
import { char, datetime, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { currencies } from './currencies.schema';

export const companies = mysqlTable('companies', {
  id: char('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 20 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  // ISO 3166-1 alpha-2.
  country: char('country', { length: 2 }).notNull(),
  vat: varchar('vat', { length: 15 }).notNull(),
  gln: varchar('gln', { length: 13 }).notNull(),
  currencyId: char('currency_id', { length: 36 })
    .notNull()
    .references(() => currencies.id),
  disabledAt: datetime('disabled_at', { mode: 'date' }),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
