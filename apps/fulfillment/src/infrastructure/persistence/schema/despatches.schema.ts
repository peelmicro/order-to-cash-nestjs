// The `DespatchAdvice` aggregate root (DESADV, domain-model.md §4.3).
// `orderReference`, `companyCode`, `retailerCode` are business identifiers
// carried in messages, never FKs into the Orders database (CLAUDE.md
// § Database per service).
//
// `uq_despatches_order_reference` (fulfillment_despatch, feature 18)
// enforces invariant **F8** ("at most one DespatchAdvice per orderReference")
// as a durable DB-level guarantee, defense-in-depth alongside the
// `stock.reserve`/`.release` lock protocol's FOR-UPDATE ordering
// (`stock-item.repository.ts` §4.3/§4.4) that `despatch.create` reuses
// unchanged: two concurrent `despatch.create` requests for the same order
// both lock the same stock rows before touching a reservation, so the
// second is blocked until the first commits and then observes the
// reservations already `consumed` — the race is already structurally
// impossible before this constraint is ever tested. The constraint is added
// anyway for the same reason `stock.schema.ts`'s `uq_stock_company_product`
// exists even though `StockItem.reserve` already enforces F1: a durable
// invariant should not depend solely on application discipline. It touches
// neither `outbox` nor `processed_events`, so the OI11 byte-parity guard
// (`apps/seed/src/outbox-parity.spec.ts`) is unaffected.
import { char, datetime, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

export const despatches = mysqlTable(
  'despatches',
  {
    id: char('id', { length: 36 }).primaryKey(),
    despatchReference: varchar('despatch_reference', { length: 20 }).notNull().unique(),
    despatchDate: datetime('despatch_date', { mode: 'date' }).notNull(),
    companyCode: varchar('company_code', { length: 20 }).notNull(),
    retailerCode: varchar('retailer_code', { length: 20 }).notNull(),
    orderReference: varchar('order_reference', { length: 20 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // F8 — at most one DespatchAdvice per orderReference.
    uniqueIndex('uq_despatches_order_reference').on(table.orderReference),
  ],
);
