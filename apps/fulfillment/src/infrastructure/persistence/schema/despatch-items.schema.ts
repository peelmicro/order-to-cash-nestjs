// `DespatchLine` — the ordered list of lines on a `DespatchAdvice`
// (domain-model.md §4.3: `lines` — `productCode`, `units`). `despatchId` is
// a local FK within this one service's database, cascade-deleted with the
// parent despatch (same pattern as orders/order_items).
import { char, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { despatches } from './despatches.schema';

export const despatchItems = mysqlTable('despatch_items', {
  id: char('id', { length: 36 }).primaryKey(),
  despatchId: char('despatch_id', { length: 36 })
    .notNull()
    .references(() => despatches.id, { onDelete: 'cascade' }),
  productCode: varchar('product_code', { length: 30 }).notNull(),
  units: int('units').notNull(),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
