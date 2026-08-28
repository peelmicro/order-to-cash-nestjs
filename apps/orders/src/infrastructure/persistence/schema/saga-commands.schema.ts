// The durable pending/parked command mechanism (`order_saga_orchestrator`
// design.md §6.3, §7). One row per (order_id, command) — a step can never
// owe the same command twice (the unique index below). Enqueued inside the
// owning fact's transaction (SO3); the in-line dispatcher and the sweeper
// both read/write this table, never a status the domain owns.
import { char, datetime, index, int, json, mysqlTable, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

// The full `Envelope` type lives in `@otc/contracts`; this schema file
// stays framework/contracts-import-free (mirrors every other schema file's
// convention) — `triggering_event_envelope` is typed `json`, mapped to
// `Envelope` only at the repository/store boundary (observability_
// reliability design.md §4.2).

export const SAGA_COMMAND_KIND_VALUES = [
  'stock.reserve',
  'stock.release',
  'despatch.create',
  'credit.hold',
  'invoice.issue',
  // feature 41's follow-up pass — `CancelOrderHandler` enqueues this
  // directly for the `credit_approved`/`confirmed` cancel branch, the
  // same "outside the fact-driven step table" shape `stock.release`'s
  // operator-cancel variant already uses.
  'credit.release',
] as const;

export type SagaCommandKindRow = (typeof SAGA_COMMAND_KIND_VALUES)[number];

// `rejected` (feature 42) — the terminal end state for a command whose
// responder replied with a terminal-business `RpcError` (e.g.
// `PRECONDITION_FAILED`); distinct from `parked`, which stays
// retry-eligible on a capped backoff schedule. Six characters, well
// within the existing `varchar(10)` column — no column-length migration
// needed, only this TS-level enum widening (drizzle-kit generate
// confirmed no SQL diff, see progress/impl_orders_saga_terminal_rejection.md).
export const SAGA_COMMAND_STATUS_VALUES = ['pending', 'sent', 'parked', 'rejected'] as const;

export type SagaCommandStatusRow = (typeof SAGA_COMMAND_STATUS_VALUES)[number];

export const sagaCommands = mysqlTable(
  'saga_commands',
  {
    id: char('id', { length: 36 }).primaryKey(),
    orderId: char('order_id', { length: 36 }).notNull(),
    orderReference: varchar('order_reference', { length: 20 }).notNull(),
    // varchar, not ENUM — same "the domain/application owns the closed set,
    // not the column" reasoning as orders.schema.ts's `status`.
    command: varchar('command', { length: 30 }).$type<SagaCommandKindRow>().notNull(),
    // The full typed RPC request payload, snapshotted from the loaded
    // aggregate at enqueue time (design.md §6.3) — the sweeper never
    // re-derives it.
    payload: json('payload').notNull(),
    // The fact that owed this command — the causal link, and the join key
    // for feature 27's eventual dead-lettering (design.md §6.5).
    triggeringEventId: char('triggering_event_id', { length: 36 }).notNull(),
    // The full, unmodified `Envelope` the fact handler held at `enqueue`
    // time, and the Kafka topic it arrived on — captured verbatim so
    // `SagaCommandDispatcher.park(...)` can dead-letter the triggering
    // fact without a cross-service read (observability_reliability
    // design.md §4.2, R29's DLQ clause / OR3).
    triggeringEventEnvelope: json('triggering_event_envelope'),
    triggeringEventTopic: varchar('triggering_event_topic', { length: 64 }),
    // OR3's "at most once per row" marker: NULL until the row's first
    // park, set exactly once in the same transaction as that park.
    deadLetteredAt: datetime('dead_lettered_at', { mode: 'date' }),
    status: varchar('status', { length: 10 }).$type<SagaCommandStatusRow>().notNull().default('pending'),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: datetime('next_attempt_at', { mode: 'date' }),
    createdAt: datetime('created_at', { mode: 'date' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date' }).notNull(),
    sentAt: datetime('sent_at', { mode: 'date' }),
  },
  (table) => [
    // "A step can never owe the same command twice" (design.md §6.3) —
    // mirrors the RPC idempotency key (orderReference, operation).
    uniqueIndex('uq_saga_commands_order_command').on(table.orderId, table.command),
    // The sweeper's two claim predicates (design.md §6.4): pending rows
    // older than the crash-window grace period...
    index('idx_saga_commands_status_created').on(table.status, table.createdAt),
    // ...and parked rows whose capped-backoff retry time has arrived.
    index('idx_saga_commands_status_next_attempt').on(table.status, table.nextAttemptAt),
  ],
);
