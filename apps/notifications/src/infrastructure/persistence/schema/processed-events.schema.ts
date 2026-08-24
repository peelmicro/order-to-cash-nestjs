// The idempotent-consumer ledger (specs/shared/saga.md §6, layer 1). One
// row per (eventId, consumer): redelivery of a fact already recorded here
// for that consumer is acknowledged without a second send.
//
// IDENTICAL shape to apps/orders'/apps/fulfillment's/apps/billing's
// processed-events.schema.ts — copied verbatim (notifications_service
// re-review, N1/N2): divergence between the services' processed_events
// tables would be a defect. This is the ONLY table in `otc_notifications` —
// this service owns no aggregate (domain-model.md §6).
//
// NOTE (N14, notifications_service re-review): unlike the other three
// services' copies, this table is NOT append-only in this service. A row is
// still never UPDATEd, but it CAN be deleted:
// `infrastructure/messaging/processed-events-compensation.ts`'s
// `DrizzleProcessedEventCompensation` removes a just-inserted row when the
// SMTP send that followed it throws (N6's "insert-first, then send, then
// delete the row if the send throws") — the notification was never
// actually delivered, so the dedup entry claiming it was must not survive.
// This file itself is NOT part of the byte-identity set
// `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts`
// (OI12) enforces across the three MySQL write models — only
// `idempotent-consumer.ts` and `processed-events.repository.ts` are — so
// this note is safe to carry here without disturbing Orders'/Fulfillment's
// own copies or their own comments.
import { char, datetime, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

export const processedEvents = mysqlTable(
  'processed_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    eventId: char('event_id', { length: 36 }).notNull(),
    consumer: varchar('consumer', { length: 50 }).notNull(),
    processedAt: datetime('processed_at', { mode: 'date' }).notNull(),
    // The blanket "All tables: id, created_at" rule — no updated_at, since a
    // row is never UPDATEd (it is written once, and — only in this
    // service, see this file's header NOTE — sometimes deleted outright by
    // the N6 compensation path, never mutated in place).
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_processed_events_event_consumer').on(table.eventId, table.consumer),
  ],
);
