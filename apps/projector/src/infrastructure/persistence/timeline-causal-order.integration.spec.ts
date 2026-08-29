// Amendment A1 (PR10, PR31 — design.md §5.5). Real MongoDB (Testcontainers),
// the direct `MongoReadModelWriter` seam (the SAME technique the removed
// `timeline-entry-rank-tiebreak.integration.spec.ts` used), so this
// exercises the REAL, EVALUATED `causalTimelineOrder` pipeline expression
// (delta-to-pipeline.ts) against a real server — not merely the JS object
// shape `delta-to-pipeline.spec.ts`'s pure tests check.
//
// Every eventId below is chosen ADVERSARIALLY: sorted so a naive
// `eventId`-only fallback (or, for the R24 case, the rejected `statusRank`
// tiebreak) would produce the WRONG order, so a passing assertion is
// evidence the CAUSAL edge — not the fallback — decided the order.
import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectFact } from '../../domain/fact-projection';
import {
  creditApprovedEnvelope,
  creditReleasedEnvelope,
  orderCancelledEnvelope,
  orderCompletedEnvelope,
  orderPlacedEnvelope,
  paymentReceivedEnvelope,
  stockReleasedEnvelope,
  stockReservedEnvelope,
} from '../../test-support/envelope-fixtures';
import { startMongoTestFixture, type MongoTestFixture } from '../../test-support/mongo-test-fixture';
import { MongoReadModelWriter } from './mongo-read-model-writer';
import type { OrderTimelineDocument } from './order-timeline.document';

describe('timeline-causal-order — R28/R24/PR31 (A1) (Testcontainers, real MongoDB)', () => {
  let fixture: MongoTestFixture;
  let collection: Collection<OrderTimelineDocument>;
  let writer: MongoReadModelWriter;

  beforeAll(async () => {
    fixture = await startMongoTestFixture();
    collection = fixture.db().collection('order_timeline');
    writer = new MongoReadModelWriter(collection);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  it(
    'R28 — stock.released.v1 precedes the order.cancelled.v1 whose causationId names it, with adversarial eventIds chosen so the fallback alone would invert it',
    async () => {
      const orderId = randomUUID();
      const sharedOccurredAt = '2026-08-24T10:10:00.000Z';
      // Adversarial: cancelledEventId sorts BEFORE releasedEventId lexically.
      const releasedEventId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const cancelledEventId = '00000000-0000-4000-8000-000000000001';

      const released = stockReleasedEnvelope({ eventId: releasedEventId, correlationId: orderId, aggregateId: orderId, occurredAt: sharedOccurredAt });
      const cancelled = orderCancelledEnvelope({
        eventId: cancelledEventId,
        correlationId: orderId,
        aggregateId: orderId,
        causationId: releasedEventId,
        occurredAt: sharedOccurredAt,
      });

      // Published cancelled-second, released-first — the order the real
      // saga actually delivers them in — but the assertion below does not
      // depend on publish order: it is DOCUMENT order, recomputed fresh
      // by causalTimelineOrder on every apply (PR15).
      await writer.apply(projectFact(released), released.eventId, 'projector', async () => {});
      await writer.apply(projectFact(cancelled), cancelled.eventId, 'projector', async () => {});

      const document = await collection.findOne({ _id: orderId } as never);
      expect(document!.events.map((e) => e.eventType)).toEqual(['stock.released.v1', 'order.cancelled.v1']);
      expect(document!.events[0]!.occurredAt).toBe(document!.events[1]!.occurredAt);
    },
    60_000,
  );

  it(
    'R24 — the completion triple stores order.completed.v1 last, behind the credit.released.v1 its causationId names, behind the payment.received.v1 THAT causationId names, with adversarial eventIds — proving both PR10 and the Billing causation edge (amendment A1 open point 2) together',
    async () => {
      const orderId = randomUUID();
      const sharedOccurredAt = '2026-08-24T16:00:05.000Z';
      // Adversarial: plain eventId-ascending order would be
      // [completed, released, payment] — the EXACT inversion the rejected
      // statusRank fix produced (review_api_tests.md D4).
      const paymentEventId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
      const releasedEventId = '88888888-8888-4888-8888-888888888882';
      const completedEventId = '00000000-0000-4000-8000-000000000003';

      const payment = paymentReceivedEnvelope({
        eventId: paymentEventId,
        correlationId: orderId,
        aggregateId: orderId,
        causationId: 'command-payment-register-root', // outside the tie group — a command id, not a fact
        occurredAt: sharedOccurredAt,
      });
      const released = creditReleasedEnvelope({
        eventId: releasedEventId,
        correlationId: orderId,
        aggregateId: orderId,
        causationId: paymentEventId, // amendment A1's Billing edge, made real in the data
        occurredAt: sharedOccurredAt,
      });
      const completed = orderCompletedEnvelope({
        eventId: completedEventId,
        correlationId: orderId,
        aggregateId: orderId,
        causationId: releasedEventId,
        occurredAt: sharedOccurredAt,
      });

      // Delivered in an ARBITRARY order across the three fact topics —
      // completed first — to prove the result does not depend on arrival.
      await writer.apply(projectFact(completed), completed.eventId, 'projector', async () => {});
      await writer.apply(projectFact(payment), payment.eventId, 'projector', async () => {});
      await writer.apply(projectFact(released), released.eventId, 'projector', async () => {});

      const document = await collection.findOne({ _id: orderId } as never);
      expect(document!.events.map((e) => e.eventType)).toEqual([
        'payment.received.v1',
        'credit.released.v1',
        'order.completed.v1',
      ]);
      expect(new Set(document!.events.map((e) => e.occurredAt)).size).toBe(1); // genuinely one tie group
    },
    60_000,
  );

  it(
    'PR31 — a causationId naming a fact OUTSIDE the tie group, and one naming NO stored fact at all, both place by the eventId fallback and neither fails',
    async () => {
      const orderId = randomUUID();
      const tOne = '2026-08-25T09:00:00.000Z';
      const tTwo = '2026-08-25T09:05:00.000Z';

      const placed = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, occurredAt: tOne });
      await writer.apply(projectFact(placed), placed.eventId, 'projector', async () => {});

      // Adversarial: eventB sorts BEFORE eventA lexically.
      const eventIdA = 'ffffffff-ffff-4fff-8fff-fffffffffffa';
      const eventIdB = '00000000-0000-4000-8000-00000000000b';
      const reserved = stockReservedEnvelope({
        eventId: eventIdA,
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: tTwo,
        causationId: placed.eventId, // REAL fact, but in a DIFFERENT tie group (tOne) — no edge within tTwo's group
      });
      const approved = creditApprovedEnvelope({
        eventId: eventIdB,
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: tTwo,
        causationId: 'no-such-fact-was-ever-received', // matches NOTHING at all
      });

      await writer.apply(projectFact(reserved), reserved.eventId, 'projector', async () => {});
      await writer.apply(projectFact(approved), approved.eventId, 'projector', async () => {});

      const document = await collection.findOne({ _id: orderId } as never);
      // tOne's entry precedes BOTH tTwo entries (occurredAt is primary —
      // PR10 clause 1); within tTwo, NEITHER has a cause in its own group
      // (one points outside it, one points nowhere), so both fall back to
      // eventId ascending: eventIdB (0...) before eventIdA (f...).
      expect(document!.events.map((e) => e.eventType)).toEqual([
        'order.placed.v1',
        'credit.approved.v1', // eventIdB
        'stock.reserved.v1', // eventIdA
      ]);
    },
    60_000,
  );

  it(
'PR31 — an entry with NO stored causationId at all (a legacy shape, written directly) computes its OWN depth as 0 without throwing, and a later fact naming it as its cause is still placed correctly',
    async () => {
      const orderId = randomUUID();
      const sharedOccurredAt = '2026-08-25T11:00:00.000Z';
      const legacyEventId = '00000000-0000-4000-8000-00000000000c';
      const newEventId = 'ffffffff-ffff-4fff-8fff-fffffffffffd';

      // A raw, hand-inserted entry with NO `causationId` field at all —
      // exactly the shape every document written before A1 has (PR35).
      await collection.insertOne({
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
        events: [
          {
            eventId: legacyEventId,
            eventType: 'stock.reserved.v1',
            occurredAt: sharedOccurredAt,
            summary: 'legacy entry, no causationId',
          } as unknown as OrderTimelineDocument['events'][number],
        ],
        headerComplete: false,
        updatedAt: sharedOccurredAt,
        statusRank: 2,
        processedEventKeys: [`projector:${legacyEventId}`],
      } as OrderTimelineDocument);

      const approved = creditApprovedEnvelope({
        eventId: newEventId,
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: sharedOccurredAt,
        causationId: legacyEventId, // NAMES the legacy entry — but the legacy entry itself has no causationId, which must not confuse ITS OWN depth computation
      });

      await expect(writer.apply(projectFact(approved), approved.eventId, 'projector', async () => {})).resolves.toBe('processed');

      const document = await collection.findOne({ _id: orderId } as never);
      expect(document!.events).toHaveLength(2);
      // The new entry's causationId DOES name the legacy entry's eventId
      // and they share one occurredAt, so a real edge exists — the legacy
      // entry (no cause of its own, depth 0) precedes the new one (depth 1).
      expect(document!.events.map((e) => e.eventType)).toEqual(['stock.reserved.v1', 'credit.approved.v1']);
    },
    60_000,
  );

  it(
    'PR31 — a fabricated cycle terminates deterministically, with every entry present exactly once, no throw and no loop',
    async () => {
      const orderId = randomUUID();
      const sharedOccurredAt = '2026-08-25T13:00:00.000Z';
      // Adversarial-but-irrelevant here: BOTH entries end at the SAME
      // depth (see this file's header derivation, and design.md §5.5.1's
      // bounded-rounds guarantee), so the fallback — eventId ascending —
      // is what actually decides the order; chosen so eventIdLow < eventIdHigh.
      const eventIdLow = '00000000-0000-4000-8000-00000000000e';
      const eventIdHigh = 'ffffffff-ffff-4fff-8fff-fffffffffffe';

      const reserved = stockReservedEnvelope({
        eventId: eventIdLow,
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: sharedOccurredAt,
        causationId: eventIdHigh, // cites the OTHER entry, which in turn cites this one
      });
      const approved = creditApprovedEnvelope({
        eventId: eventIdHigh,
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: sharedOccurredAt,
        causationId: eventIdLow, // MUTUAL — a cycle, impossible in a well-formed history
      });

      await writer.apply(projectFact(reserved), reserved.eventId, 'projector', async () => {});
      await expect(
        writer.apply(projectFact(approved), approved.eventId, 'projector', async () => {}),
      ).resolves.toBe('processed'); // no throw

      const document = await collection.findOne({ _id: orderId } as never);
      expect(document!.events).toHaveLength(2); // every entry present exactly once
      expect(document!.events.map((e) => e.eventId)).toEqual([eventIdLow, eventIdHigh]); // deterministic — fallback decides once depths tie

      // Re-reading proves nothing further mutated it — deterministic on a
      // SECOND look, not merely on this one run.
      const again = await collection.findOne({ _id: orderId } as never);
      expect(again!.events).toEqual(document!.events);
    },
    60_000,
  );

  it(
    'PR31 — two siblings sharing ONE causationId (neither caused by the other) order by eventId ascending, identically after a later, unrelated apply re-triggers the sort',
    async () => {
      const orderId = randomUUID();
      const sharedOccurredAt = '2026-08-25T15:00:00.000Z';
      // Adversarial-but-decisive: BOTH cite the SAME outside-group cause,
      // so neither has an edge to the other — eventId ascending decides.
      const siblingLow = '00000000-0000-4000-8000-00000000000f';
      const siblingHigh = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
      const sharedCause = 'one-billing-transaction-root';

      const payment = paymentReceivedEnvelope({
        eventId: siblingHigh,
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: sharedOccurredAt,
        causationId: sharedCause,
      });
      const released = creditReleasedEnvelope({
        eventId: siblingLow,
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: sharedOccurredAt,
        causationId: sharedCause,
      });

      await writer.apply(projectFact(payment), payment.eventId, 'projector', async () => {});
      await writer.apply(projectFact(released), released.eventId, 'projector', async () => {});

      const afterSiblings = await collection.findOne({ _id: orderId } as never);
      expect(afterSiblings!.events.map((e) => e.eventId)).toEqual([siblingLow, siblingHigh]);

      // A later, unrelated fact at a DIFFERENT occurredAt forces the
      // WHOLE array through causalTimelineOrder again (PR15 — every apply
      // re-sorts in full) — the siblings' relative order must be
      // IDENTICAL, proving the fallback is stable across re-application,
      // not merely correct once.
      const later = orderCancelledEnvelope({
        correlationId: orderId,
        aggregateId: orderId,
        occurredAt: '2026-08-25T15:05:00.000Z',
        causationId: siblingLow,
      });
      await writer.apply(projectFact(later), later.eventId, 'projector', async () => {});

      const afterLater = await collection.findOne({ _id: orderId } as never);
      const siblingEventIds = afterLater!.events.filter((e) => e.eventId === siblingLow || e.eventId === siblingHigh).map((e) => e.eventId);
      expect(siblingEventIds).toEqual([siblingLow, siblingHigh]);
    },
    60_000,
  );
}, 180_000);
