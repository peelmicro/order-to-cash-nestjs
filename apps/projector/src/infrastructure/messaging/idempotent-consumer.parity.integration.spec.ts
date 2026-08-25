// OI12 — the behavioural half of the parity guard for THIS service's
// documented variant (design.md §6.2, requirements.md PR25/PR26). Named
// exactly as `idempotent-consumer.ts`'s own banner cites it — see
// `apps/orders/src/infrastructure/messaging/idempotent-consumer.parity.spec.ts`'s
// case 4, which checks that this file exists on disk.
//
// Runs the SAME generic suite `idempotent-consumer.parity.integration.spec.ts`
// (canonical) runs against MySQL here against the REAL `MongoIdempotentConsumer`
// over Testcontainers MongoDB, through the thin `toConformable` adapter
// design.md §6.2 describes: one `FIXED_SCOPE_ID` document created once per
// suite (the analogue of "one table"), `dedupOnlyStages` writing the dedup
// key and nothing else — so what this suite exercises is exactly the dedup
// mechanism; the projection itself is proved by R50-R53's own integration
// specs (timeline-projection.integration.spec.ts and neighbours).
import type { Collection, Document } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsumerName } from '../../application/ports/consumer-name';
import { startMongoTestFixture, type MongoTestFixture } from '../../test-support/mongo-test-fixture';
import type { OrderTimelineDocument } from '../persistence/order-timeline.document';
import { MongoIdempotentConsumer } from './idempotent-consumer';
import {
  describeIdempotentConsumerConformance,
  type ConformableIdempotentConsumer,
} from './test-support/idempotent-consumer-conformance';

const FIXED_SCOPE_ID = 'fixed-scope-order';

function fixedScopeSkeleton(): OrderTimelineDocument {
  return {
    _id: FIXED_SCOPE_ID,
    orderId: FIXED_SCOPE_ID,
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
    updatedAt: '2026-08-24T00:00:00.000Z',
    statusRank: 0,
    processedEventKeys: [],
  };
}

/** Writes ONLY the dedup key — nothing else — so the suite exercises exactly the dedup mechanism, per design.md §6.2. */
function dedupOnlyStages(dedupKey: string): Document[] {
  return [
    {
      $set: {
        processedEventKeys: {
          $sortArray: {
            input: { $setUnion: [{ $ifNull: ['$processedEventKeys', []] }, [dedupKey]] },
            sortBy: 1,
          },
        },
      },
    },
  ];
}

describe('idempotent-consumer.parity — OI12, the MongoDB variant over real MongoDB (Testcontainers, mongo:8.3.8)', () => {
  let fixture: MongoTestFixture;
  // ONE database/collection for the whole conformance describe block below
  // — "the analogue of one table" (design.md §6.2). `createConsumer` must
  // return a FRESH `MongoIdempotentConsumer` instance every call while
  // every instance talks to this SAME collection, or conformance case 3
  // (fresh instance, same store) is vacuous.
  let conformanceCollection: Collection<OrderTimelineDocument>;

  beforeAll(async () => {
    fixture = await startMongoTestFixture();
    conformanceCollection = fixture.db().collection<OrderTimelineDocument>('order_timeline');
    await conformanceCollection.updateOne(
      { _id: FIXED_SCOPE_ID } as never,
      { $setOnInsert: fixedScopeSkeleton() } as never,
      { upsert: true },
    );
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  function toConformable(real: MongoIdempotentConsumer): ConformableIdempotentConsumer {
    return {
      runOnce: (eventId, consumer, work) =>
        real.runOnce(FIXED_SCOPE_ID, eventId, consumer as ConsumerName, dedupOnlyStages, () => work()),
    };
  }

  describeIdempotentConsumerConformance('the MongoDB variant over real MongoDB', {
    createConsumer: () => toConformable(new MongoIdempotentConsumer(conformanceCollection)),
    newEventId: () => randomUUID(),
  });

  describe('PR23/PR26 — the real variant class over the real driver', () => {
    it('records the consumer:eventId pair in the SAME single write that applies the projection', async () => {
      const db = fixture.db();
      const orderId = 'order-pr23';
      const localCollection = db.collection<OrderTimelineDocument>('order_timeline');
      await localCollection.insertOne({ ...fixedScopeSkeleton(), _id: orderId, orderId });

      const consumer = new MongoIdempotentConsumer(localCollection);
      let afterAppliedCalls = 0;
      const eventId = randomUUID();

      const outcome = await consumer.runOnce(
        orderId,
        eventId,
        'projector',
        (dedupKey) => [
          {
            $set: {
              processedEventKeys: {
                $sortArray: { input: { $setUnion: [{ $ifNull: ['$processedEventKeys', []] }, [dedupKey]] }, sortBy: 1 },
              },
              events: { $concatArrays: [{ $ifNull: ['$events', []] }, [{ eventId, eventType: 'x', occurredAt: '2026-01-01T00:00:00.000Z', summary: 's' }]] },
            },
          },
        ],
        async () => {
          afterAppliedCalls += 1;
        },
      );

      expect(outcome).toBe('processed');
      expect(afterAppliedCalls).toBe(1);

      const document = await localCollection.findOne({ _id: orderId } as never);
      expect(document!.processedEventKeys).toContain(`projector:${eventId}`);
      expect(document!.events).toHaveLength(1);
    });

    it('the post-apply callback runs exactly once on processed and NOT AT ALL on duplicate', async () => {
      const db = fixture.db();
      const orderId = 'order-pr26';
      const localCollection = db.collection<OrderTimelineDocument>('order_timeline');
      await localCollection.insertOne({ ...fixedScopeSkeleton(), _id: orderId, orderId });

      const consumer = new MongoIdempotentConsumer(localCollection);
      const eventId = randomUUID();
      let calls = 0;
      const afterApplied = async () => {
        calls += 1;
      };

      const first = await consumer.runOnce(orderId, eventId, 'projector', dedupOnlyStages, afterApplied);
      const second = await consumer.runOnce(orderId, eventId, 'projector', dedupOnlyStages, afterApplied);

      expect(first).toBe('processed');
      expect(second).toBe('duplicate');
      expect(calls).toBe(1);
    });
  });
}, 180_000);
