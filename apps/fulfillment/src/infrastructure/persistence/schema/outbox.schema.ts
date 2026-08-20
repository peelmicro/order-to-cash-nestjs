// The transactional outbox (domain-model.md §7.1 envelope, R13/R14 in
// specs/shared/requirements.md — implemented by the `outbox_and_idempotency`
// feature). This table is written in the SAME transaction as the aggregate
// row it accompanies; a separate relay polls it and stamps `publishedAt`
// only after the broker acknowledges. The `(published_at, occurred_at)`
// index exists specifically so that poll is an index scan, never a table
// scan, as the relay grows the table (see the integration test that asserts
// this index exists via information_schema).
//
// IDENTICAL shape to apps/orders' outbox.schema.ts — divergence between the
// three services' outboxes (orders/fulfillment/billing) would be a defect;
// copied verbatim per db_fulfillment's task prompt. No `causation_id` column
// here either — that decision belongs to feature 14 (outbox_and_idempotency)
// and must land in all three DBs together (see progress/review_db_orders.md
// advisory #1).
import { char, datetime, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const outbox = mysqlTable(
  'outbox',
  {
    id: char('id', { length: 36 }).primaryKey(),
    // The domain-generated envelope id (domain-model.md §7.1) — the
    // idempotency key of every consumer. Unique: a dual-write bug must
    // fail loudly, not silently duplicate a fact.
    eventId: char('event_id', { length: 36 }).notNull().unique(),
    // `<aggregate>.<fact>.v<n>`, e.g. "stock.reserved.v1".
    eventType: varchar('event_type', { length: 60 }).notNull(),
    aggregateId: char('aggregate_id', { length: 36 }).notNull(),
    correlationId: char('correlation_id', { length: 36 }).notNull(),
    payload: json('payload').notNull(),
    occurredAt: datetime('occurred_at', { mode: 'date' }).notNull(),
    publishedAt: datetime('published_at', { mode: 'date' }),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // The relay's poll: "unpublished records, oldest first" — must be an
    // index scan (spec, verified by the integration test).
    index('idx_outbox_published_occurred').on(table.publishedAt, table.occurredAt),
  ],
);
