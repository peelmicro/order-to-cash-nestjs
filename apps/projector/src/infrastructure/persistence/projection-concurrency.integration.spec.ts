// PR7 — genuinely concurrent deliveries against the REAL writer over REAL
// MongoDB (Testcontainers), driven with `Promise.all`, never sequential
// calls and never a mocked driver. Also the N10 half (feature 21,
// tasks.md's binding rule 3): "no duplicate entry" is proven by observing
// the ATTEMPT (a post-apply counter, and the returned outcomes), not only
// by inspecting the document's final contents.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectFact } from '../../domain/fact-projection';
import { orderPlacedEnvelope, stockReservedEnvelope } from '../../test-support/envelope-fixtures';
import { startMongoTestFixture, type MongoTestFixture } from '../../test-support/mongo-test-fixture';
import type { OrderTimelineDocument } from './order-timeline.document';
import { MongoReadModelWriter } from './mongo-read-model-writer';

describe('projection-concurrency — PR7 (Testcontainers, real MongoDB)', () => {
  let fixture: MongoTestFixture;

  beforeAll(async () => {
    fixture = await startMongoTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  it(
    'two concurrent deliveries of ONE eventId apply exactly once and report the loser duplicate',
    async () => {
      const collection = fixture.db().collection<OrderTimelineDocument>('order_timeline');
      const writer = new MongoReadModelWriter(collection);
      const orderId = randomUUID();
      const envelope = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });
      const delta = projectFact(envelope);

      let afterAppliedCalls = 0;
      const afterApplied = async () => {
        afterAppliedCalls += 1;
      };

      const [first, second] = await Promise.all([
        writer.apply(delta, envelope.eventId, 'projector', afterApplied),
        writer.apply(delta, envelope.eventId, 'projector', afterApplied),
      ]);

      // Exactly one 'processed', exactly one 'duplicate' — never both
      // 'processed' (which would mean the fact applied twice).
      const outcomes = [first, second].sort();
      expect(outcomes).toEqual(['duplicate', 'processed']);
      // The ATTEMPT, not just the residue (N10): the post-apply callback
      // ran exactly once, proving the loser's write genuinely matched
      // nothing rather than merely leaving the document looking right.
      expect(afterAppliedCalls).toBe(1);

      const document = await collection.findOne({ _id: orderId } as never);
      expect(document!.events).toHaveLength(1);
      expect(document!.processedEventKeys).toHaveLength(1);
    },
    60_000,
  );

  it(
    'two concurrent deliveries of DIFFERENT eventIds for an ABSENT order end with one document holding both entries, no duplicate-key error escaping',
    async () => {
      const collection = fixture.db().collection<OrderTimelineDocument>('order_timeline');
      const writer = new MongoReadModelWriter(collection);
      const orderId = randomUUID();
      const first = orderPlacedEnvelope({
        correlationId: orderId,
        aggregateId: orderId,
        eventId: randomUUID(),
        occurredAt: '2026-08-24T09:00:00.000Z',
      });
      const second = stockReservedEnvelope({
        correlationId: orderId,
        aggregateId: orderId,
        eventId: randomUUID(),
        occurredAt: '2026-08-24T09:05:00.000Z',
      });

      let calls = 0;
      const afterApplied = async () => {
        calls += 1;
      };

      // Both start against an ABSENT order — the classic Mongo upsert race
      // PR7 names explicitly: at most one insert wins, the other retries
      // its Phase 1 upsert exactly once (mongo-read-model-writer.ts) and
      // NEVER surfaces the E11000 to this caller.
      const outcomes = await Promise.all([
        writer.apply(projectFact(first), first.eventId, 'projector', afterApplied),
        writer.apply(projectFact(second), second.eventId, 'projector', afterApplied),
      ]);

      expect(outcomes).toEqual(['processed', 'processed']);
      expect(calls).toBe(2);

      const document = await collection.findOne({ _id: orderId } as never);
      expect(document).not.toBeNull();
      expect(document!.events).toHaveLength(2);
      expect(document!.events.map((e) => e.eventType).sort()).toEqual(['order.placed.v1', 'stock.reserved.v1']);
      expect(document!.processedEventKeys).toHaveLength(2);
    },
    60_000,
  );
}, 180_000);
