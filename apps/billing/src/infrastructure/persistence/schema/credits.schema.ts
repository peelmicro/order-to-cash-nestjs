// The `BuyerCredit` aggregate root's write model (domain-model.md §5.1). One
// credit line per (retailerCode, companyCode) pair. `retailerCode`,
// `companyCode` are business identifiers carried in messages — deliberately
// NOT a foreign key into the Orders database (CLAUDE.md § Database per
// service: no cross-database joins, no FKs across service boundaries;
// Billing is a separate service with its own database).
//
// Invariant B1 (`Σ(active holds) + Σ(open invoice exposure) ≤ creditLimit`)
// is deliberately NOT a DB CHECK constraint — it is a derived quantity over
// the whole `credit_items` ledger for an order (domain-model.md §5.1
// "Derived quantities"), not a value this row itself carries, so no CHECK
// on this table could express it. It is enforced in the `BuyerCredit`
// AGGREGATE (a later, sdd:true feature), the one place that can see the
// whole ledger atomically and produce a domain rejection instead of a raw
// DB error. Per CLAUDE.md's Clean Architecture layering, invariants live in
// the domain, not the schema — same reasoning as apps/fulfillment's stock
// schema for invariant F1 (see progress/impl_db_fulfillment.md Decisions §3).
import { char, datetime, int, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

export const credits = mysqlTable(
  'credits',
  {
    id: char('id', { length: 36 }).primaryKey(),
    code: varchar('code', { length: 30 }).notNull().unique(),
    retailerCode: varchar('retailer_code', { length: 20 }).notNull(),
    companyCode: varchar('company_code', { length: 20 }).notNull(),
    // Integer minor units (CLAUDE.md § Money) — never a float.
    creditLimit: int('credit_limit').notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // One BuyerCredit per (retailerCode, companyCode) — domain-model.md
    // §5.1 "One credit line per (retailerCode, companyCode) pair".
    uniqueIndex('uq_credits_retailer_company').on(table.retailerCode, table.companyCode),
  ],
);
