// PR32/PR35 (A1) — the version-stamped migration. Real MongoDB
// (Testcontainers). The load-bearing case (design.md §5.5.4's
// rejected-vs-A1 table): a document ALREADY MIGRATED under a STALE
// version IS re-sorted once the current version moves past it — the exact
// case the rejected `{ $exists: false }` presence filter could not pass,
// because it would have silently skipped a document whose entries already
// carried the (wrong) field.
import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMongoTestFixture, type MongoTestFixture } from '../../test-support/mongo-test-fixture';
import { TIMELINE_ORDER_VERSION } from './delta-to-pipeline';
import { migrateTimelineOrder } from './timeline-order-migration';
import type { OrderTimelineDocument } from './order-timeline.document';

const SHARED_OCCURRED_AT = '2026-08-24T10:10:00.000Z';
// Deliberately eventId-adversarial — cancelledEventId sorts BEFORE
// releasedEventId lexically, so a naive fallback reproduces the exact
// inversion this migration exists to repair.
const CANCELLED_EVENT_ID = '00000000-0000-4000-8000-000000000001';
const RELEASED_EVENT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function baseDocument(orderId: string): Omit<OrderTimelineDocument, 'events' | 'timelineOrderVersion'> {
  return {
    _id: orderId,
    orderId,
    orderReference: 'ORD-000042',
    orderDate: '2026-08-01T09:00:00.000Z',
    retailer: { code: 'RETAILER01', name: null, gln: '1234567890128' },
    company: { code: 'COMPANY01', name: null, gln: '1234567890128' },
    status: 'cancelled',
    cancellationReason: 'credit_rejected',
    currency: 'USD',
    totals: { initialAmount: 24999, initialDiscount: 0, totalAmount: 24999 },
    items: [{ productCode: 'P1', quantity: 1, unitPrice: 24999, lineDiscount: 0 }],
    references: { despatchReference: null, invoiceReference: null, paymentReference: null },
    headerComplete: true,
    updatedAt: SHARED_OCCURRED_AT,
    statusRank: 99,
    processedEventKeys: [`projector:${CANCELLED_EVENT_ID}`, `projector:${RELEASED_EVENT_ID}`],
  };
}

describe('timeline-order-migration — PR32/PR35 (A1) (Testcontainers, real MongoDB)', () => {
  let fixture: MongoTestFixture;
  let db: Db;
  let collection: Collection<OrderTimelineDocument>;

  beforeAll(async () => {
    fixture = await startMongoTestFixture();
    db = fixture.db();
    collection = db.collection('order_timeline');
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  it(
    'PR32 — selects on the VERSION STAMP, not on field presence: a document ALREADY stamped at CURRENT − 1 IS re-sorted (the case the rejected presence-filter could not pass)',
    async () => {
      const orderId = randomUUID();
      // Stamped at CURRENT − 1: this document was ALREADY "migrated" once,
      // under a PRIOR version of the rule, but its entries are still in
      // the WRONG (cancellation-first) causal order and carry NO
      // causationId (that prior rule did not compute one).
      await collection.insertOne({
        ...baseDocument(orderId),
        timelineOrderVersion: TIMELINE_ORDER_VERSION - 1,
        events: [
          { eventId: CANCELLED_EVENT_ID, eventType: 'order.cancelled.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'Order ORD-000042 cancelled (credit_rejected)' } as unknown as OrderTimelineDocument['events'][number],
          { eventId: RELEASED_EVENT_ID, eventType: 'stock.released.v1', occurredAt: SHARED_OCCURRED_AT, summary: '1 unit(s) released back to stock (compensation)' } as unknown as OrderTimelineDocument['events'][number],
        ],
      } as OrderTimelineDocument);

      const result = await migrateTimelineOrder(db);
      expect(result.migrated).toBe(1);
      // Neither entry carries a causationId, so the re-sort falls back to
      // (occurredAt, eventId) for BOTH — it is still counted edgeless,
      // and honestly reported as such (PR35), not silently "repaired".
      expect(result.stillEdgeless).toBe(1);

      const after = await collection.findOne({ _id: orderId } as never);
      expect(after!.timelineOrderVersion).toBe(TIMELINE_ORDER_VERSION);
      // No causationId was INVENTED — order.cancelled.v1 (eventId
      // "0...") still sorts before stock.released.v1 (eventId "f...")
      // because with NO recorded edge, PR31's fallback alone decides —
      // this is the honestly-unrepaired case PR35 exists to report, not
      // a claim that the migration divined the causal truth from nothing.
      expect(after!.events.map((e) => e.eventType)).toEqual(['order.cancelled.v1', 'stock.released.v1']);
    },
    60_000,
  );

  it(
    'PR32 — a document carrying a causal edge but stamped at CURRENT − 1 IS re-sorted into causal order, and is counted NOT edgeless',
    async () => {
      const orderId = randomUUID();
      await collection.insertOne({
        ...baseDocument(orderId),
        timelineOrderVersion: TIMELINE_ORDER_VERSION - 1,
        events: [
          // WRONG stored order (cancellation before its cause), but the
          // causal edge IS present this time.
          {
            eventId: CANCELLED_EVENT_ID,
            eventType: 'order.cancelled.v1',
            occurredAt: SHARED_OCCURRED_AT,
            summary: 'Order ORD-000042 cancelled (credit_rejected)',
            causationId: RELEASED_EVENT_ID,
          },
          {
            eventId: RELEASED_EVENT_ID,
            eventType: 'stock.released.v1',
            occurredAt: SHARED_OCCURRED_AT,
            summary: '1 unit(s) released back to stock (compensation)',
            causationId: 'some-earlier-command-id',
          },
        ],
      } as OrderTimelineDocument);

      const result = await migrateTimelineOrder(db);
      expect(result.migrated).toBe(1);
      expect(result.stillEdgeless).toBe(0);

      const after = await collection.findOne({ _id: orderId } as never);
      expect(after!.timelineOrderVersion).toBe(TIMELINE_ORDER_VERSION);
      expect(after!.events.map((e) => e.eventType)).toEqual(['stock.released.v1', 'order.cancelled.v1']);
    },
    60_000,
  );

  it(
    'PR32 — is a no-op on a document already at the CURRENT version, and strips the RETIRED entry-level statusRank of a document it DOES migrate',
    async () => {
      // Already current — untouched.
      const currentOrderId = randomUUID();
      await collection.insertOne({
        ...baseDocument(currentOrderId),
        timelineOrderVersion: TIMELINE_ORDER_VERSION,
        events: [
          { eventId: RELEASED_EVENT_ID, eventType: 'stock.released.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'released', causationId: 'root' },
          { eventId: CANCELLED_EVENT_ID, eventType: 'order.cancelled.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'cancelled', causationId: RELEASED_EVENT_ID },
        ],
      } as OrderTimelineDocument);

      // Stamped stale AND still carrying the retired entry-level
      // statusRank key (the rejected first attempt's own shape).
      const legacyOrderId = randomUUID();
      await collection.insertOne({
        ...baseDocument(legacyOrderId),
        timelineOrderVersion: TIMELINE_ORDER_VERSION - 1,
        events: [
          { eventId: CANCELLED_EVENT_ID, eventType: 'order.cancelled.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'cancelled', causationId: RELEASED_EVENT_ID, statusRank: 99 } as unknown as OrderTimelineDocument['events'][number],
          { eventId: RELEASED_EVENT_ID, eventType: 'stock.released.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'released', causationId: 'root', statusRank: 0 } as unknown as OrderTimelineDocument['events'][number],
        ],
      } as OrderTimelineDocument);

      const result = await migrateTimelineOrder(db);
      expect(result.migrated).toBe(1); // only the stale one
      expect(result.stillEdgeless).toBe(0);

      const untouched = await collection.findOne({ _id: currentOrderId } as never);
      expect(untouched!.events.map((e) => e.eventType)).toEqual(['stock.released.v1', 'order.cancelled.v1']); // unchanged, never touched

      const migrated = await collection.findOne({ _id: legacyOrderId } as never);
      expect(migrated!.timelineOrderVersion).toBe(TIMELINE_ORDER_VERSION);
      expect(migrated!.events.map((e) => e.eventType)).toEqual(['stock.released.v1', 'order.cancelled.v1']);
      for (const entry of migrated!.events) {
        expect(entry).not.toHaveProperty('statusRank');
      }

      // Idempotent — a second run is a no-op on both documents now.
      const secondRun = await migrateTimelineOrder(db);
      expect(secondRun.migrated).toBe(0);
      expect(secondRun.stillEdgeless).toBe(0);
    },
    60_000,
  );

  it(
    'PR35 — never invents a causationId for an entry that has none, and reports the count of migrated documents still holding such an entry',
    async () => {
      const edgelessOrderId = randomUUID();
      await collection.insertOne({
        ...baseDocument(edgelessOrderId),
        timelineOrderVersion: TIMELINE_ORDER_VERSION - 1,
        events: [
          { eventId: CANCELLED_EVENT_ID, eventType: 'order.cancelled.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'cancelled' } as unknown as OrderTimelineDocument['events'][number],
          { eventId: RELEASED_EVENT_ID, eventType: 'stock.released.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'released' } as unknown as OrderTimelineDocument['events'][number],
        ],
      } as OrderTimelineDocument);

      const edgedOrderId = randomUUID();
      await collection.insertOne({
        ...baseDocument(edgedOrderId),
        timelineOrderVersion: TIMELINE_ORDER_VERSION - 1,
        events: [
          { eventId: CANCELLED_EVENT_ID, eventType: 'order.cancelled.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'cancelled', causationId: RELEASED_EVENT_ID },
          { eventId: RELEASED_EVENT_ID, eventType: 'stock.released.v1', occurredAt: SHARED_OCCURRED_AT, summary: 'released', causationId: 'root' },
        ],
      } as OrderTimelineDocument);

      const result = await migrateTimelineOrder(db);
      expect(result.migrated).toBe(2);
      expect(result.stillEdgeless).toBe(1); // only edgelessOrderId

      const edgeless = await collection.findOne({ _id: edgelessOrderId } as never);
      // No causationId invented — every entry still lacks it.
      for (const entry of edgeless!.events) {
        expect(entry).not.toHaveProperty('causationId');
      }
    },
    60_000,
  );
}, 180_000);
