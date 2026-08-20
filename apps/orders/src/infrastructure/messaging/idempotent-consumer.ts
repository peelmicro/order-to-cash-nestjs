// CANONICAL COPY — apps/orders/src/infrastructure/messaging/idempotent-consumer.ts
//
// This is the reference implementation of the idempotent-consumer pattern
// (specs/outbox_and_idempotency/design.md §6, saga.md §6 layer 1). Every
// other write model that consumes facts (features 17-22 and onward — the
// eventual consumers in fulfillment, billing, and any sibling that gains
// an `@EventPattern`) copies this file, together with the sibling
// processed-events.repository.ts, VERBATIM into the same relative path —
// never forked, edited or "improved" per service. Byte-identity (after
// this banner) with every copy is enforced mechanically by
// idempotent-consumer.parity.spec.ts (OI12). If you are editing this file,
// that guard tells you what else must change.
import type { Clock } from '../../application/ports/clock.port';
import type { ConsumerName } from '../../application/ports/consumer-name';
import type { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work.port';
import { recordProcessedEvent } from './processed-events.repository';

export type ConsumptionOutcome = 'processed' | 'duplicate';

/** Internal signal only — never escapes `runOnce`. Thrown to force the unit of work to roll back the failed dedup insert attempt before `runOnce` reports `'duplicate'`. */
class DuplicateEventSignal extends Error {}

export class IdempotentConsumer {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Runs `work` at most once for `(eventId, consumer)`:
   *   BEGIN
   *     INSERT INTO processed_events (...)   -- FIRST
   *     -> duplicate key ? ROLLBACK and return 'duplicate' without calling `work`   (R18)
   *     await work(tx)                       -- effects + outbox rows, same tx     (R17)
   *   COMMIT
   *
   * Insert-first, not read-then-write: the unique index's lock is what
   * makes two concurrent deliveries of the same event serialise — the
   * second blocks until the first commits, then observes the duplicate key
   * and reports `'duplicate'`, never applying `work` twice.
   */
  async runOnce(
    eventId: string,
    consumer: ConsumerName,
    work: (tx: TransactionContext) => Promise<void>,
  ): Promise<ConsumptionOutcome> {
    try {
      await this.unitOfWork.execute(async (tx) => {
        const result = await recordProcessedEvent(tx, {
          eventId,
          consumer,
          processedAt: this.clock.now(),
        });
        if (result === 'duplicate') {
          throw new DuplicateEventSignal();
        }
        await work(tx);
      });
      return 'processed';
    } catch (error) {
      if (error instanceof DuplicateEventSignal) {
        return 'duplicate';
      }
      throw error;
    }
  }
}
