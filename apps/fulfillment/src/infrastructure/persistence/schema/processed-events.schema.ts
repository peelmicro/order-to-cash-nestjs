// The idempotent-consumer ledger (domain-model.md §7.1, R17/R18 in
// specs/shared/requirements.md — implemented by the `outbox_and_idempotency`
// feature). One row per (eventId, consumer): redelivery of a fact already
// recorded here for that consumer is acknowledged without mutating any
// aggregate state, without emitting a fact and without issuing a command.
//
// IDENTICAL shape to apps/orders' processed-events.schema.ts — copied
// verbatim per db_fulfillment's task prompt (divergence between the three
// services' processed_events tables would be a defect).
import { char, datetime, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

export const processedEvents = mysqlTable(
  'processed_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    eventId: char('event_id', { length: 36 }).notNull(),
    consumer: varchar('consumer', { length: 50 }).notNull(),
    processedAt: datetime('processed_at', { mode: 'date' }).notNull(),
    // The blanket "All tables: id, created_at" rule (spec § Tables) — no
    // updated_at, since this ledger is append-only (R17/R18: a row is
    // written once and never mutated).
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_processed_events_event_consumer').on(table.eventId, table.consumer),
  ],
);
