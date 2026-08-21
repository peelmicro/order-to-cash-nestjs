// The durable R25 ignored-fact record (`order_saga_orchestrator` design.md
// §5.4, §7) — "why did the saga ignore this?" is an operations question the
// database answers, not a log line. Written inside the same transaction as
// the dedup record (design.md §5.1), so it is idempotent under the
// idempotent-consumer's first-delivery `runOnce`.
import { char, datetime, index, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const SAGA_IGNORED_FACT_MARKER_VALUES = ['precondition_unmet', 'unknown_order'] as const;

export type SagaIgnoredFactMarkerRow = (typeof SAGA_IGNORED_FACT_MARKER_VALUES)[number];

export const sagaIgnoredFacts = mysqlTable(
  'saga_ignored_facts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    eventId: char('event_id', { length: 36 }).notNull(),
    eventType: varchar('event_type', { length: 60 }).notNull(),
    // Nullable — the unknown-order case (SO8) has no order row to point at.
    orderId: char('order_id', { length: 36 }),
    correlationId: char('correlation_id', { length: 36 }).notNull(),
    observedStatus: varchar('observed_status', { length: 20 }),
    expectedStatus: varchar('expected_status', { length: 20 }),
    marker: varchar('marker', { length: 20 }).$type<SagaIgnoredFactMarkerRow>().notNull(),
    recordedAt: datetime('recorded_at', { mode: 'date' }).notNull(),
  },
  (table) => [
    // Operator lookup: "what happened to this order's facts" (design.md §5.3).
    index('idx_saga_ignored_facts_correlation').on(table.correlationId),
  ],
);
