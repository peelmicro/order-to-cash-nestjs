// The `Reservation` child entity of `StockItem` (domain-model.md §4.1) — one
// per order line, and the concrete resource that saga compensation releases
// (§4.2, invariants F1–F5). `stockId` is a local FK, fine within this one
// service's database (CLAUDE.md § Database per service). `orderReference`,
// `companyCode`, `retailerCode`, `productCode` are business identifiers
// carried in messages, never FKs into the Orders database.
import { char, datetime, index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { stock } from './stock.schema';

// domain-model.md §4.1: `status` is `reserved` | `released` | `consumed`.
// varchar, deliberately NOT a MySQL ENUM — same reasoning as orders.status
// (see apps/orders/.../schema/orders.schema.ts header): the domain owns the
// state machine (§4.2) and its legal set of values can grow without an
// ALTER TABLE.
export const RESERVATION_STATUS_VALUES = ['reserved', 'released', 'consumed'] as const;

export type ReservationStatusRow = (typeof RESERVATION_STATUS_VALUES)[number];

export const reservations = mysqlTable(
  'reservations',
  {
    id: char('id', { length: 36 }).primaryKey(),
    stockId: char('stock_id', { length: 36 })
      .notNull()
      .references(() => stock.id),
    companyCode: varchar('company_code', { length: 20 }).notNull(),
    retailerCode: varchar('retailer_code', { length: 20 }).notNull(),
    productCode: varchar('product_code', { length: 30 }).notNull(),
    orderReference: varchar('order_reference', { length: 20 }).notNull(),
    units: int('units').notNull(),
    status: varchar('status', { length: 20 }).$type<ReservationStatusRow>().notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // Compensation ("release every reservation of this order still in
    // status reserved") and idempotent despatch ("has this order already
    // been consumed?") both filter by this pair — an index scan, not a
    // table scan.
    index('idx_reservations_order_status').on(table.orderReference, table.status),
  ],
);
