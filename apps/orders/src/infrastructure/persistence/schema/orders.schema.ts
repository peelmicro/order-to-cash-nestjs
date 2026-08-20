// The `Order` aggregate's write model (domain-model.md §3). `status` is a
// plain varchar, deliberately NOT a MySQL ENUM: the domain owns the state
// machine (Table T-1) and its legal set of values can grow without an
// `ALTER TABLE` — the column is a projection of the domain type, not the
// other way around. `OrderStatusRow` below is the TS-side mirror of that
// set for this infrastructure layer only; the domain's own `OrderStatus`
// union type (implemented in a later, sdd:true feature) is the source of
// truth and this type must track it, never the reverse.
import { char, datetime, index, int, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import { companies } from './companies.schema';
import { currencies } from './currencies.schema';
import { retailers } from './retailers.schema';

export const ORDER_STATUS_VALUES = [
  'placed',
  'stock_reserved',
  'credit_approved',
  'confirmed',
  'despatched',
  'invoiced',
  'paid',
  'completed',
  'cancelled',
] as const;

export type OrderStatusRow = (typeof ORDER_STATUS_VALUES)[number];

export const orders = mysqlTable(
  'orders',
  {
    id: char('id', { length: 36 }).primaryKey(),
    orderReference: varchar('order_reference', { length: 20 }).notNull().unique(),
    orderDate: datetime('order_date', { mode: 'date' }).notNull(),
    companyId: char('company_id', { length: 36 })
      .notNull()
      .references(() => companies.id),
    retailerId: char('retailer_id', { length: 36 })
      .notNull()
      .references(() => retailers.id),
    currencyId: char('currency_id', { length: 36 })
      .notNull()
      .references(() => currencies.id),
    // Integer minor units (CLAUDE.md § Money) — never a float.
    initialAmount: int('initial_amount').notNull(),
    initialDiscount: int('initial_discount').notNull(),
    totalAmount: int('total_amount').notNull(),
    // See the note above: varchar, not ENUM.
    status: varchar('status', { length: 20 }).$type<OrderStatusRow>().notNull(),
    cancellationReason: varchar('cancellation_reason', { length: 100 }),
    notes: text('notes'),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // The saga orchestrator and read-model catch-up both filter "orders of
    // this retailer in status X" — an index scan, not a table scan.
    index('idx_orders_retailer_status').on(table.retailerId, table.status),
    // The outbox-relay-adjacent "orders in status X, oldest first" query.
    index('idx_orders_status_order_date').on(table.status, table.orderDate),
  ],
);
