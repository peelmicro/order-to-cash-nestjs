// The `StockItem` aggregate root's write model (domain-model.md §4.1).
// `companyCode`/`productCode` are business identifiers carried in messages —
// deliberately NOT a foreign key into the Orders database (CLAUDE.md
// § Database per service: no cross-database joins, no FKs across service
// boundaries; Fulfillment is a separate service with its own database).
//
// Invariant F1 (`reservedUnits <= units` at all times) is deliberately NOT a
// DB CHECK constraint here — it is enforced in the `StockItem` AGGREGATE
// (phase 9, `fulfillment_aggregate`), which is the one place that can see
// the whole ledger operation atomically. A CHECK on this column would also
// fire on legitimate intermediate states reachable inside a single
// transaction (e.g. decrementing `units` and `reservedUnits` together for a
// despatch is not necessarily a single atomic UPDATE at the SQL level), and
// it would duplicate domain logic that must already exist in the aggregate
// to produce the correct `stock.rejected.v1` fact instead of a raw DB error.
// Per CLAUDE.md's Clean Architecture layering, invariants live in the
// domain, not the schema — the schema only stores the aggregate's state.
import { char, datetime, int, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

export const stock = mysqlTable(
  'stock',
  {
    id: char('id', { length: 36 }).primaryKey(),
    companyCode: varchar('company_code', { length: 20 }).notNull(),
    productCode: varchar('product_code', { length: 30 }).notNull(),
    units: int('units').notNull(),
    reservedUnits: int('reserved_units').notNull(),
    lowStockThreshold: int('low_stock_threshold').notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // One StockItem per (companyCode, productCode) — domain-model.md §4.1
    // "productCode — Unique together with companyCode".
    uniqueIndex('uq_stock_company_product').on(table.companyCode, table.productCode),
  ],
);
