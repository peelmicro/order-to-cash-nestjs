// VARIANT OF — apps/orders/src/infrastructure/messaging/idempotent-consumer.ts
//
// Divergence: the ledger is not a MySQL `processed_events` row inside a SQL
// transaction; it is the `processedEventKeys` array of the read-model
// document itself, written by the SAME single `findOneAndUpdate` that
// applies the projection. There is no transaction spanning a mark and an
// effect because there is nothing to keep consistent: the mark and the
// effect are the same bytes in the same write (design.md §9.1, PR23). The
// canonical's `work(tx)` — run INSIDE the transaction that inserts the
// dedup row — has no equivalent here (there is no transaction to run
// inside), so `work` becomes a POST-APPLY callback instead: invoked exactly
// once, AFTER the write, ONLY when it matched (design.md §6.2). This is a
// deliberate, considered divergence, not an oversight — see design.md §6.2
// for why a "stages-builder-as-work" shape was rejected (it would have to
// run before the write, including on duplicates, breaking conformance
// case 2).
//
// Behavioural conformance: apps/projector/src/infrastructure/messaging/idempotent-consumer.parity.integration.spec.ts
import type { Collection, Document } from 'mongodb';
import type { ConsumerName } from '../../application/ports/consumer-name';
import type { OrderTimelineDocument } from '../persistence/order-timeline.document';

export type ConsumptionOutcome = 'processed' | 'duplicate';

const MONGO_DUPLICATE_KEY_ERROR = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === MONGO_DUPLICATE_KEY_ERROR;
}

export class MongoIdempotentConsumer {
  constructor(private readonly collection: Collection<OrderTimelineDocument>) {}

  /**
   * @param scopeId       the document the dedup key lives in (= orderId)
   * @param eventId       the fact's eventId
   * @param consumer      the consumer name — the key is the PAIR (R17)
   * @param stages        the projection, merged into the SAME atomic write
   * @param afterApplied  runs exactly once, AFTER the write, only when it matched
   *
   * THE FILTER IS THE CHECK (PR6/design.md §5.2): there is no `findOne`
   * beforehand, no `.includes()` in TypeScript, no compare-and-set loop.
   * Under two concurrent deliveries of the SAME eventId, MongoDB's own
   * write-conflict retry re-evaluates this filter AFTER the winner's write
   * has landed — the loser's filter then finds its own key already
   * present, matches nothing, and this method returns 'duplicate' without
   * ever calling `afterApplied`. This is the store's own concurrency
   * control doing the serialising; there is no application-level check to
   * defeat.
   */
  async runOnce(
    scopeId: string,
    eventId: string,
    consumer: ConsumerName,
    stages: (dedupKey: string) => Document[],
    afterApplied: (applied: OrderTimelineDocument) => Promise<void>,
  ): Promise<ConsumptionOutcome> {
    const dedupKey = `${consumer}:${eventId}`;

    const applied = await this.collection.findOneAndUpdate(
      { _id: scopeId, processedEventKeys: { $ne: dedupKey } } as never,
      stages(dedupKey) as never,
      { returnDocument: 'after' },
    );

    if (!applied) {
      return 'duplicate';
    }

    await afterApplied(applied);
    return 'processed';
  }

  /** Exposed so `mongo-read-model-writer.ts`'s Phase 1 upsert can share this class's own duplicate-key detection — never duplicated as a second implementation. */
  static isDuplicateKeyError(error: unknown): boolean {
    return isDuplicateKeyError(error);
  }
}
