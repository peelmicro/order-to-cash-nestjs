// The transactional outbox (domain-model.md §7.1 envelope, R13/R14 in
// specs/shared/requirements.md — implemented by the `outbox_and_idempotency`
// feature). This table is written in the SAME transaction as the aggregate
// row it accompanies; a separate relay polls it and stamps `publishedAt`
// only after the broker acknowledges.
//
// `causationId`, `seq` and `traceParent` — and the `occurredAt` precision
// change — are the coordinated three-database migration of
// `outbox_and_idempotency` (feature 14), landing in all three databases
// together. Resolves progress/review_db_orders.md advisory #1
// (`causationId` was thrown away at persistence time — design.md §3.1) and
// advisory #2 (the `(published_at, occurred_at)` poll order was
// nondeterministic — design.md §3.2, `seq`). `traceParent` is provisioned
// now, unused, for feature 27 (design.md §3.3).
import { bigint, char, datetime, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const outbox = mysqlTable(
  'outbox',
  {
    id: char('id', { length: 36 }).primaryKey(),
    // The domain-generated envelope id (domain-model.md §7.1) — the
    // idempotency key of every consumer. Unique: a dual-write bug must
    // fail loudly, not silently duplicate a fact.
    eventId: char('event_id', { length: 36 }).notNull().unique(),
    // `<aggregate>.<fact>.v<n>`, e.g. "order.placed.v1".
    eventType: varchar('event_type', { length: 60 }).notNull(),
    aggregateId: char('aggregate_id', { length: 36 }).notNull(),
    correlationId: char('correlation_id', { length: 36 }).notNull(),
    // The eventId of the causing fact, or the id of the causing command
    // (R12, design.md §3.1). A promoted, NOT NULL column — a fact without
    // causation cannot be committed.
    causationId: char('causation_id', { length: 36 }).notNull(),
    payload: json('payload').notNull(),
    // datetime(3) — millisecond precision. Not for the relay (`seq` orders
    // that): occurredAt is what the relay copies into the published
    // envelope, and R50 makes it the only ordering key the read model
    // trusts (design.md §3.2).
    occurredAt: datetime('occurred_at', { mode: 'date', fsp: 3 }).notNull(),
    publishedAt: datetime('published_at', { mode: 'date' }),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    // The tie-free, strictly-increasing publication order the relay polls
    // by (design.md §3.2, OI2/OI3). Assigned by the store at INSERT, never
    // by the domain — not an identity (domain-model.md §8 rule 3): it
    // never leaves infrastructure, never appears in an envelope.
    seq: bigint('seq', { mode: 'number', unsigned: true }).autoincrement().unique(),
    // W3C trace context, nullable, reserved for feature 27 (design.md
    // §3.3). Written NULL by this feature; unused until the OTel SDK lands.
    traceParent: varchar('trace_parent', { length: 64 }),
  },
  (table) => [
    // The relay's poll: "unpublished records, oldest first" — must be an
    // index scan (spec, verified by the integration test). No longer the
    // poll index (see idx_outbox_unpublished_seq below), kept for the
    // outbox-lag metric feature 27 needs (R59).
    index('idx_outbox_published_occurred').on(table.publishedAt, table.occurredAt),
    // The poll index (design.md §5.2): a range scan over the NULL prefix,
    // already ordered by seq — no filesort, never touches the published
    // tail.
    index('idx_outbox_unpublished_seq').on(table.publishedAt, table.seq),
  ],
);
