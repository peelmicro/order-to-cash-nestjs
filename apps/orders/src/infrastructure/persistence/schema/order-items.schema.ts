// The `Order` aggregate's line items (domain-model.md §3.1 `OrderLine`).
// `productId` is a local FK for referential integrity within this one
// service's database (CLAUDE.md § Database per service: fine within a
// service, never across a service boundary) — the wire/event contract still
// carries `productCode`, never this row's id.
import { char, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { orders } from './orders.schema';
import { products } from './products.schema';

export const orderItems = mysqlTable('order_items', {
  id: char('id', { length: 36 }).primaryKey(),
  orderId: char('order_id', { length: 36 })
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  productId: char('product_id', { length: 36 })
    .notNull()
    .references(() => products.id),
  // Snapshot taken at order time (domain-model.md §3.1) — NOT a join into
  // `products`. `OrderLine.description` is a required field of the domain
  // entity and of `OrderPlacedPayload.lines[].description`; joining the
  // catalogue at read time would let a later catalogue edit silently
  // rewrite a historical order's description, un-snapshotting it exactly
  // the way `price` below is deliberately not un-snapshotted either. Added
  // by the post-gate amendment of 2026-08-20 (design.md §9.1) — see
  // migration 0001.
  description: varchar('description', { length: 255 }).notNull(),
  // Integer minor units (CLAUDE.md § Money) — never a float. Snapshotted at
  // order time (domain-model.md §3.1: "a later catalogue price change never
  // rewrites an order").
  price: int('price').notNull(),
  quantity: int('quantity').notNull(),
  discount: int('discount').notNull(),
  createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
});
