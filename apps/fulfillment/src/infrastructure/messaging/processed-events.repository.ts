// COPY OF — apps/orders/src/infrastructure/messaging/processed-events.repository.ts
//
// VERBATIM copy of the canonical idempotent-consumer ledger write
// (specs/outbox_and_idempotency/design.md §6), byte-identical (after this
// banner) to the canonical, guarded by idempotent-consumer.parity.spec.ts
// (OI12). If you are editing this file, edit the canonical and re-copy;
// never fork it here.
import { UniqueId } from '@otc/shared-kernel';
import type { ConsumerName } from '../../application/ports/consumer-name';
import type { TransactionContext } from '../../application/ports/unit-of-work.port';
import { asDrizzleTx } from '../persistence/drizzle-unit-of-work';
import { processedEvents } from '../persistence/schema/processed-events.schema';

export type ProcessedEventResult = 'recorded' | 'duplicate';

export interface RecordProcessedEventInput {
  readonly eventId: string;
  readonly consumer: ConsumerName;
  readonly processedAt: Date;
}

const MYSQL_DUPLICATE_ENTRY_CODE = 'ER_DUP_ENTRY';

/**
 * Inserts one `(eventId, consumer)` row inside the supplied `tx`. Surfaces
 * a MySQL duplicate-key violation as a typed `'duplicate'` result rather
 * than letting the raw driver error escape — the unique index is the
 * dedup guarantee, so this is the only check performed; no prior `SELECT`.
 */
export async function recordProcessedEvent(
  tx: TransactionContext,
  input: RecordProcessedEventInput,
): Promise<ProcessedEventResult> {
  const db = asDrizzleTx(tx);
  try {
    await db.insert(processedEvents).values({
      id: UniqueId.generate().value,
      eventId: input.eventId,
      consumer: input.consumer,
      processedAt: input.processedAt,
      createdAt: input.processedAt,
    });
    return 'recorded';
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      return 'duplicate';
    }
    throw error;
  }
}

function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('cause' in error)) {
    return false;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return false;
  }
  return (cause as { code?: unknown }).code === MYSQL_DUPLICATE_ENTRY_CODE;
}
