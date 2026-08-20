// Reconstructs the published `Envelope` from a stored `outbox` row ALONE
// (OI1, design.md §4.4) — reads only stored columns, infers, defaults or
// regenerates nothing at publication time. `occurredAt` is rendered
// `toISOString()` exactly once, here: the row's `Date` becomes the wire's
// `Instant`.
import type { Envelope } from '@otc/contracts';
import type { InferSelectModel } from 'drizzle-orm';
import type { outbox } from '../persistence/schema';

export type OutboxRow = InferSelectModel<typeof outbox>;

/** IF any envelope field is absent from the row, THEN this throws rather than publish an incomplete envelope (OI1). */
export function outboxRowToEnvelope(row: OutboxRow): Envelope {
  const missing = (
    ['eventId', 'eventType', 'aggregateId', 'correlationId', 'causationId', 'occurredAt', 'payload'] as const
  ).filter((field) => row[field] === null || row[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`outboxRowToEnvelope: outbox row ${row.id} is missing envelope field(s): ${missing.join(', ')}`);
  }

  return {
    eventId: row.eventId,
    eventType: row.eventType,
    aggregateId: row.aggregateId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload as Record<string, unknown>,
  };
}
