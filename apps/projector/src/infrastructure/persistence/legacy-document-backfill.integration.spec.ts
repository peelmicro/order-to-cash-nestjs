// PR29, both cases. The fixture reproduces `apps/seed`'s own
// `toTimelineDocument` OUTPUT SHAPE by hand (never imported across apps —
// CLAUDE.md: the only shared runtime code is `packages/shared-kernel` and
// `packages/contracts`) — a `completed` document with nine timeline
// entries, headerComplete: true, NO `statusRank`, NO `processedEventKeys`:
// exactly what `apps/seed` has ever written (design.md §11).
import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectFact } from '../../domain/fact-projection';
import {
  creditApprovedEnvelope,
  creditReleasedEnvelope,
  invoiceIssuedEnvelope,
  orderCompletedEnvelope,
  orderConfirmedEnvelope,
  orderDespatchedEnvelope,
  orderPlacedEnvelope,
  paymentReceivedEnvelope,
  stockReservedEnvelope,
} from '../../test-support/envelope-fixtures';
import { startMongoTestFixture, type MongoTestFixture } from '../../test-support/mongo-test-fixture';
import { backfillLegacyDocuments } from './legacy-document-backfill';
import { MongoReadModelWriter } from './mongo-read-model-writer';
import type { OrderTimelineDocument } from './order-timeline.document';

/** By-hand reproduction of apps/seed's `toTimelineDocument` OUTPUT SHAPE — see this file's header. Nine facts, `completed`, no `statusRank`/`processedEventKeys` document-level (PR29), and no `causationId`/`timelineOrderVersion` either (amendment A1 — the pre-PR30/PR34 shape every document written before A1 has). */
function seededCompletedDocument(
  orderId: string,
  eventIds: readonly string[],
): Omit<OrderTimelineDocument, 'statusRank' | 'processedEventKeys' | 'events' | 'timelineOrderVersion'> & {
  events: Omit<OrderTimelineDocument['events'][number], 'causationId'>[];
} {
  const [
    placedId,
    reservedId,
    approvedId,
    confirmedId,
    despatchedId,
    invoicedId,
    paidId,
    releasedId,
    completedId,
  ] = eventIds;

  return {
    _id: orderId,
    orderId,
    orderReference: 'ORD-000099',
    orderDate: '2026-08-01T09:00:00.000Z',
    retailer: { code: 'RETAILER01', name: 'Retailer One', gln: '1234567890128' },
    company: { code: 'COMPANY01', name: 'Company One', gln: '1234567890128' },
    status: 'completed',
    cancellationReason: null,
    currency: 'USD',
    totals: { initialAmount: 2000, initialDiscount: 0, totalAmount: 2000 },
    items: [{ productCode: 'P1', name: 'Product One', quantity: 2, unitPrice: 1000, lineDiscount: 0 }],
    references: {
      despatchReference: 'DES-000099',
      invoiceReference: 'INV-000099',
      paymentReference: 'PAY-000099',
    },
    events: [
      { eventId: placedId!, eventType: 'order.placed.v1', occurredAt: '2026-08-01T09:00:00.000Z', summary: 'Order ORD-000099 placed for RETAILER01' },
      { eventId: reservedId!, eventType: 'stock.reserved.v1', occurredAt: '2026-08-01T10:00:00.000Z', summary: 'Stock reserved for 1 line(s)' },
      { eventId: approvedId!, eventType: 'credit.approved.v1', occurredAt: '2026-08-01T11:00:00.000Z', summary: 'Credit hold of 2 000 USD approved' },
      { eventId: confirmedId!, eventType: 'order.confirmed.v1', occurredAt: '2026-08-01T12:00:00.000Z', summary: 'Order confirmed (ORDRSP)' },
      { eventId: despatchedId!, eventType: 'order.despatched.v1', occurredAt: '2026-08-01T13:00:00.000Z', summary: 'Despatch DES-000099 created' },
      { eventId: invoicedId!, eventType: 'invoice.issued.v1', occurredAt: '2026-08-01T14:00:00.000Z', summary: 'Invoice INV-000099 issued' },
      { eventId: paidId!, eventType: 'payment.received.v1', occurredAt: '2026-08-01T15:00:00.000Z', summary: 'Payment PAY-000099 received' },
      { eventId: releasedId!, eventType: 'credit.released.v1', occurredAt: '2026-08-01T16:00:00.000Z', summary: 'Credit exposure released — invoice paid' },
      { eventId: completedId!, eventType: 'order.completed.v1', occurredAt: '2026-08-01T17:00:00.000Z', summary: 'Order ORD-000099 completed' },
    ],
    headerComplete: true,
    updatedAt: '2026-08-01T17:00:00.000Z',
  };
}

describe('legacy-document-backfill — PR29 (Testcontainers, real MongoDB)', () => {
  let fixture: MongoTestFixture;

  beforeAll(async () => {
    fixture = await startMongoTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  it(
    'backfills statusRank from status and processedEventKeys from events[].eventId, and a replay of all nine facts leaves events.length, status and references UNCHANGED',
    async () => {
      const db = fixture.db();
      const collection: Collection<OrderTimelineDocument> = db.collection('order_timeline');
      const orderId = randomUUID();
      const eventIds = Array.from({ length: 9 }, () => randomUUID());
      const seeded = seededCompletedDocument(orderId, eventIds);
      await collection.insertOne(seeded as OrderTimelineDocument);

      const modified = await backfillLegacyDocuments(db);
      expect(modified).toBe(1);

      const afterBackfill = await collection.findOne({ _id: orderId } as never);
      expect(afterBackfill!.statusRank).toBe(98); // completed
      expect(afterBackfill!.processedEventKeys).toHaveLength(9);
      expect(afterBackfill!.processedEventKeys).toEqual([...afterBackfill!.processedEventKeys].sort());
      for (const eventId of eventIds) {
        expect(afterBackfill!.processedEventKeys).toContain(`projector:${eventId}`);
      }

      // Replay ALL NINE facts, using the SAME eventIds the seeded document
      // already carries — exactly what a fresh `projector` consumer group
      // starting `fromBeginning: true` against an already-seeded database
      // does (design.md §11).
      const writer = new MongoReadModelWriter(collection);
      const [placedId, reservedId, approvedId, confirmedId, despatchedId, invoicedId, paidId, releasedId, completedId] = eventIds;
      const facts = [
        orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: placedId, occurredAt: '2026-08-01T09:00:00.000Z' }),
        stockReservedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: reservedId, occurredAt: '2026-08-01T10:00:00.000Z' }),
        creditApprovedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: approvedId, occurredAt: '2026-08-01T11:00:00.000Z' }),
        orderConfirmedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: confirmedId, occurredAt: '2026-08-01T12:00:00.000Z' }),
        orderDespatchedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: despatchedId, occurredAt: '2026-08-01T13:00:00.000Z' }),
        invoiceIssuedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: invoicedId, occurredAt: '2026-08-01T14:00:00.000Z' }),
        paymentReceivedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: paidId, occurredAt: '2026-08-01T15:00:00.000Z' }),
        creditReleasedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: releasedId, occurredAt: '2026-08-01T16:00:00.000Z' }),
        orderCompletedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: completedId, occurredAt: '2026-08-01T17:00:00.000Z' }),
      ];

      for (const envelope of facts) {
        await writer.apply(projectFact(envelope), envelope.eventId, 'projector', async () => {});
      }

      const afterReplay = await collection.findOne({ _id: orderId } as never);
      expect(afterReplay!.events).toHaveLength(9); // NOT 18 — every fact was suppressed as a duplicate
      expect(afterReplay!.status).toBe('completed'); // NOT regressed to "placed"
      expect(afterReplay!.references).toEqual(seeded.references);
      expect(afterReplay!.totals).toEqual(seeded.totals);
    },
    60_000,
  );

  it('is a no-op on its second run, and on a document this projector wrote itself (statusRank already present)', async () => {
    const db = fixture.db();
    const collection: Collection<OrderTimelineDocument> = db.collection('order_timeline');
    const orderId = randomUUID();
    const eventIds = Array.from({ length: 9 }, () => randomUUID());
    await collection.insertOne(seededCompletedDocument(orderId, eventIds) as OrderTimelineDocument);

    const firstRun = await backfillLegacyDocuments(db);
    expect(firstRun).toBe(1);
    const secondRun = await backfillLegacyDocuments(db);
    expect(secondRun).toBe(0);

    // A document with statusRank already present (this projector's own
    // output shape) is untouched — filtered on { statusRank: { $exists: false } }.
    const projectorOwnOrderId = randomUUID();
    await collection.insertOne({
      ...(seededCompletedDocument(projectorOwnOrderId, eventIds) as OrderTimelineDocument),
      statusRank: 98,
      processedEventKeys: eventIds.map((id) => `projector:${id}`).sort(),
    });
    const thirdRun = await backfillLegacyDocuments(db);
    expect(thirdRun).toBe(0);
  }, 60_000);
}, 180_000);
