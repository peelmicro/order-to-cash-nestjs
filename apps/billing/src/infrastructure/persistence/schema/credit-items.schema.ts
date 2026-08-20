// `CreditLedgerEntry` — the append-only hold/release/consume ledger of the
// `BuyerCredit` aggregate (domain-model.md §5.1). `creditId` is a local FK
// within this one service's database (CLAUDE.md § Database per service).
// `orderReference` is a business identifier carried in messages, never a FK
// into the Orders database.
import { char, datetime, index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { credits } from './credits.schema';

// domain-model.md §5.1: `type` is `hold` | `release` | `consume`. varchar,
// deliberately NOT a MySQL ENUM — same reasoning as orders.status /
// reservations.status (the domain owns the set, no ALTER TABLE to grow it).
export const CREDIT_ITEM_TYPE_VALUES = ['hold', 'release', 'consume'] as const;

export type CreditItemTypeRow = (typeof CREDIT_ITEM_TYPE_VALUES)[number];

export const creditItems = mysqlTable(
  'credit_items',
  {
    id: char('id', { length: 36 }).primaryKey(),
    creditId: char('credit_id', { length: 36 })
      .notNull()
      .references(() => credits.id),
    orderReference: varchar('order_reference', { length: 20 }).notNull(),
    // Integer minor units (CLAUDE.md § Money) — never a float.
    amount: int('amount').notNull(),
    type: varchar('type', { length: 20 }).$type<CreditItemTypeRow>().notNull(),
    creditDate: datetime('credit_date', { mode: 'date' }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // B4 ("at most one active hold per orderReference") and the
    // activeHold/openExposure derivation (§5.1) both filter "entries of this
    // credit line for this order" — an index scan, not a table scan.
    index('idx_credit_items_credit_order').on(table.creditId, table.orderReference),
  ],
);
