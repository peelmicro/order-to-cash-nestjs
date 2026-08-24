// N6 (notifications_service re-review) — the compensating DELETE for
// "insert-first, then send, then delete the row if the send throws".
//
// This file is deliberately NOT part of the canonical idempotent-consumer
// pair (idempotent-consumer.ts / processed-events.repository.ts stay
// byte-identical to apps/fulfillment's own copies — N1/N2, never a
// notifications-specific variant of THOSE two files). It exists because an
// SMTP send should not be enrolled in the SAME MySQL transaction as the
// dedup insert: holding a transaction (and the connection it occupies, and
// the row lock the unique index takes) open across a slow, unpredictable
// external network call is bad practice on its own merits, independent of
// whether it would also "work" mechanically.
//
// So `NotificationDispatchService.dispatch` (application layer) calls
// `IdempotentConsumer.runOnce` with a NO-OP `work` — the dedup row commits
// on its own, as a short, ordinary transaction, exactly per the canonical
// pattern's insert-first semantics — and only AFTER that commits does it
// call `NotificationSender.send`, outside any transaction. If the send
// throws, this function deletes the just-committed row (a second, separate
// statement) before the caller rethrows — converting "duplicate an email"
// into "possibly lose one at redelivery", the direction domain-model.md §6
// ("one delivery") points when a choice must be made. Kafka's own
// at-least-once redelivery (no offset commit on a thrown
// `@EventPattern` handler) is what turns "possibly lose one" back into "try
// again", so the residual risk is only a crash in the narrow window between
// this DELETE's own commit and the next redelivery attempt.
import { and, eq } from 'drizzle-orm';
import type { ConsumerName } from '../../application/ports/consumer-name';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import { asDrizzleTx } from '../persistence/drizzle-unit-of-work';
import { processedEvents } from '../persistence/schema/processed-events.schema';

export async function deleteProcessedEvent(
  tx: TransactionContext,
  input: { eventId: string; consumer: ConsumerName },
): Promise<void> {
  const db = asDrizzleTx(tx);
  await db
    .delete(processedEvents)
    .where(and(eq(processedEvents.eventId, input.eventId), eq(processedEvents.consumer, input.consumer)));
}

/** The narrow capability `NotificationDispatchService` needs — satisfied structurally by `DrizzleProcessedEventCompensation` below, faked directly in unit tests. */
export interface DeletesProcessedEvent {
  delete(eventId: string, consumer: ConsumerName): Promise<void>;
}

export class DrizzleProcessedEventCompensation implements DeletesProcessedEvent {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async delete(eventId: string, consumer: ConsumerName): Promise<void> {
    await this.unitOfWork.execute((tx) => deleteProcessedEvent(tx, { eventId, consumer }));
  }
}
