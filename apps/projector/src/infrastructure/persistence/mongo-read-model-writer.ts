// Implements `ReadModelWriter` (application/ports/read-model-writer.port.ts)
// over `MongoIdempotentConsumer` (design.md §5.1/§5.2). Phase 1's E11000
// retry-exactly-once is HERE, and ONLY here — every other error propagates
// so the fact is redelivered (PR7).
import type { Collection, Document } from 'mongodb';
import type { ProjectionDelta } from '../../domain/projection-delta';
import type { ConsumerName } from '../../application/ports/consumer-name';
import type {
  AppliedOrderTimeline,
  ApplyOutcome,
  ReadModelWriter,
} from '../../application/ports/read-model-writer.port';
import { deltaToPipeline, dedupKeyOf } from './delta-to-pipeline';
import { MongoIdempotentConsumer } from '../messaging/idempotent-consumer';
import type { OrderTimelineDocument } from './order-timeline.document';

export interface ReadModelWriterLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

const CONSOLE_LOGGER: ReadModelWriterLogger = {
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', message, ...meta })),
};

/**
 * PR8 — the weakest statement that is certainly true: every fact of an
 * order's saga is causally downstream of the order being placed.
 * `statusRank: 0` is strictly below `order.placed.v1`'s own rank (1), so
 * the real fact still writes (design.md §5.1).
 *
 * `updatedAt` is seeded from the TRIGGERING fact's own `occurredAt` — never
 * a wall clock (PR14) — so `openapi.yaml` `OrderDetail`'s required
 * `updatedAt` is present the instant the placeholder exists (PR9), even in
 * the small window between this insert and the atomic apply that follows
 * it. Phase 2's `$ifNull` fallback (delta-to-pipeline.ts) then computes the
 * SAME value from the same fact, so the two never disagree.
 */
function placeholderSkeleton(orderId: string, seedOccurredAt: string): OrderTimelineDocument {
  return {
    _id: orderId,
    orderId,
    orderReference: null,
    orderDate: null,
    retailer: { code: null, name: null, gln: null },
    company: { code: null, name: null, gln: null },
    status: 'placed',
    cancellationReason: null,
    currency: null,
    totals: { initialAmount: null, initialDiscount: null, totalAmount: null },
    items: [],
    references: { despatchReference: null, invoiceReference: null, paymentReference: null },
    events: [],
    headerComplete: false,
    updatedAt: seedOccurredAt,
    statusRank: 0,
    processedEventKeys: [],
  };
}

function toAppliedOrderTimeline(document: OrderTimelineDocument): AppliedOrderTimeline {
  const latest = document.events[document.events.length - 1];
  return {
    orderId: document.orderId,
    orderReference: document.orderReference,
    status: document.status,
    cancellationReason: document.cancellationReason,
    references: document.references,
    totals: document.totals,
    latestEntry: {
      eventId: latest!.eventId,
      eventType: latest!.eventType,
      occurredAt: latest!.occurredAt,
      summary: latest!.summary,
    },
  };
}

export class MongoReadModelWriter implements ReadModelWriter {
  private readonly idempotentConsumer: MongoIdempotentConsumer;
  private readonly logger: ReadModelWriterLogger;

  constructor(
    private readonly collection: Collection<OrderTimelineDocument>,
    logger: ReadModelWriterLogger = CONSOLE_LOGGER,
  ) {
    this.idempotentConsumer = new MongoIdempotentConsumer(collection);
    this.logger = logger;
  }

  async apply(
    delta: ProjectionDelta,
    eventId: string,
    consumer: ConsumerName,
    afterApplied: (document: AppliedOrderTimeline) => Promise<void>,
  ): Promise<ApplyOutcome> {
    await this.upsertPlaceholder(delta.orderId, delta.entry.occurredAt);

    return this.idempotentConsumer.runOnce(
      delta.orderId,
      eventId,
      consumer,
      (dedupKey: string): Document[] => deltaToPipeline(delta, dedupKey),
      async (applied) => afterApplied(toAppliedOrderTimeline(applied)),
    );
  }

  /**
   * PR7 — two concurrent deliveries for DIFFERENT eventIds on the same
   * ABSENT order can both fail to match this filter and both attempt an
   * insert; one wins, the other gets E11000 on `_id`. Retried EXACTLY
   * once — after which it can only match, because the winner's insert has
   * already landed. Every other error propagates (never swallowed
   * generally).
   */
  private async upsertPlaceholder(orderId: string, seedOccurredAt: string): Promise<void> {
    try {
      await this.collection.updateOne(
        { _id: orderId } as never,
        { $setOnInsert: placeholderSkeleton(orderId, seedOccurredAt) } as never,
        { upsert: true },
      );
    } catch (error) {
      if (!MongoIdempotentConsumer.isDuplicateKeyError(error)) {
        throw error;
      }
      this.logger.error('mongo-read-model-writer: placeholder upsert lost the insert race, retrying once', {
        orderId,
      });
      await this.collection.updateOne(
        { _id: orderId } as never,
        { $setOnInsert: placeholderSkeleton(orderId, seedOccurredAt) } as never,
        { upsert: true },
      );
    }
  }
}

export { dedupKeyOf };
