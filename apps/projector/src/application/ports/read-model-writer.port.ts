// The ONLY write surface application code touches (design.md §2). Mirrors
// `MongoIdempotentConsumer.runOnce`'s own shape (infrastructure/messaging/idempotent-consumer.ts)
// deliberately: `afterApplied` is invoked exactly once, AFTER the atomic
// apply, and ONLY when it matched (PR18) — never on a suppressed
// redelivery. This is what makes "no signal for a duplicate" structural
// rather than a second `if` in application code.
import type { ProjectionDelta } from '../../domain/projection-delta';
import type { ConsumerName } from './consumer-name';

export const READ_MODEL_WRITER = Symbol('ReadModelWriter');

export type ApplyOutcome = 'processed' | 'duplicate';

/** The narrow shape `application/projection-apply.service.ts` needs from a post-apply document — enough to build both signal payloads (PR17), nothing store-specific. */
export interface AppliedOrderTimeline {
  readonly orderId: string;
  readonly orderReference: string | null;
  readonly status: string;
  readonly cancellationReason: string | null;
  readonly references: {
    readonly despatchReference: string | null;
    readonly invoiceReference: string | null;
    readonly paymentReference: string | null;
  };
  readonly totals: { readonly initialAmount: number | null; readonly initialDiscount: number | null; readonly totalAmount: number | null };
  readonly latestEntry: {
    readonly eventId: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly summary: string;
    // Amendment A1 (PR33) — carried through to TimelineStreamEntry so the
    // SSE-visible shape stays consistent with the wire's TimelineEntry.
    readonly causationId: string;
  };
}

export interface ReadModelWriter {
  /**
   * Applies one fact's `delta` to the read model in exactly two operations
   * (PR6): a `$setOnInsert` upsert bringing the document into existence
   * (a no-op on an existing document), then one `findOneAndUpdate` whose
   * filter IS the idempotency check. `afterApplied` runs exactly once,
   * only when the second operation matched.
   */
  apply(
    delta: ProjectionDelta,
    eventId: string,
    consumer: ConsumerName,
    afterApplied: (document: AppliedOrderTimeline) => Promise<void>,
  ): Promise<ApplyOutcome>;
}
