// PR15 › replaying the same facts in a shuffled order with duplicates
// reproduces a byte-identical document, including a sorted
// processedEventKeys array. Exactly design.md §10.2's four-step protocol —
// NOT "run it twice and compare": step 3's shuffle is what makes this a
// DETERMINISM test, and the duplication is what makes it also an R51 test.
// feature_list.json's acceptance bullet 2. Whole-document `toEqual`, never
// weakened to a partial comparison.
import { randomUUID } from 'node:crypto';
import type { Envelope } from '@otc/contracts';
import type { Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BILLING_FACTS_TOPIC,
  FULFILLMENT_FACTS_TOPIC,
  ORDERS_FACTS_TOPIC,
} from './infrastructure/messaging/kafka.config';
import {
  createTopic,
  publishFact,
  startKafkaTestFixture,
  type KafkaTestFixture,
} from './test-support/kafka-test-fixture';
import { startAuthenticatedMongoTestFixture, type StandaloneMongoTestFixture } from './test-support/mongo-test-fixture';
import { bootProjectorTestApp } from './test-support/projector-app-test-harness';
import {
  creditApprovedEnvelope,
  creditReleasedEnvelope,
  invoiceIssuedEnvelope,
  orderCancelledEnvelope,
  orderCompletedEnvelope,
  orderConfirmedEnvelope,
  orderDespatchedEnvelope,
  orderPlacedEnvelope,
  paymentReceivedEnvelope,
  stockReleasedEnvelope,
  stockReservedEnvelope,
} from './test-support/envelope-fixtures';
import { projectFact } from './domain/fact-projection';
import { MongoReadModelWriter } from './infrastructure/persistence/mongo-read-model-writer';
import type { OrderTimelineDocument } from './infrastructure/persistence/order-timeline.document';

const TOPIC_FOR: Readonly<Record<string, string>> = {
  'order.placed.v1': ORDERS_FACTS_TOPIC,
  'stock.reserved.v1': FULFILLMENT_FACTS_TOPIC,
  'credit.approved.v1': BILLING_FACTS_TOPIC,
  'order.confirmed.v1': ORDERS_FACTS_TOPIC,
  'order.despatched.v1': FULFILLMENT_FACTS_TOPIC,
  'invoice.issued.v1': BILLING_FACTS_TOPIC,
  'payment.received.v1': BILLING_FACTS_TOPIC,
  'credit.released.v1': BILLING_FACTS_TOPIC,
  'order.completed.v1': ORDERS_FACTS_TOPIC,
};

/** A tiny seeded PRNG (mulberry32) — deterministic across runs, no external dependency. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000, intervalMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`replay-determinism: condition not met within ${timeoutMs}ms`);
}

describe('replay-determinism — PR15 (Testcontainers, real Kafka + real MongoDB)', () => {
  let mongo: StandaloneMongoTestFixture;
  let kafka: KafkaTestFixture;

  beforeAll(async () => {
    mongo = await startAuthenticatedMongoTestFixture();
    kafka = await startKafkaTestFixture();
    await createTopic(kafka.brokers, ORDERS_FACTS_TOPIC);
    await createTopic(kafka.brokers, FULFILLMENT_FACTS_TOPIC);
    await createTopic(kafka.brokers, BILLING_FACTS_TOPIC);
  }, 180_000);

  afterAll(async () => {
    await kafka?.teardown();
    await mongo?.teardown();
  }, 60_000);

  it(
    'replaying the same nine facts, shuffled and duplicated, reproduces a BYTE-IDENTICAL document',
    async () => {
      const orderId = randomUUID();
      const eventIdOf = (eventType: string): string => `${orderId}-${eventType}`;

      const facts: Envelope[] = [
        orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('order.placed.v1'), occurredAt: '2026-08-24T09:00:00.000Z' }),
        stockReservedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('stock.reserved.v1'), occurredAt: '2026-08-24T10:00:00.000Z' }),
        creditApprovedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('credit.approved.v1'), occurredAt: '2026-08-24T11:00:00.000Z' }),
        orderConfirmedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('order.confirmed.v1'), occurredAt: '2026-08-24T12:00:00.000Z' }),
        orderDespatchedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('order.despatched.v1'), occurredAt: '2026-08-24T13:00:00.000Z' }),
        invoiceIssuedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('invoice.issued.v1'), occurredAt: '2026-08-24T14:00:00.000Z' }),
        paymentReceivedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('payment.received.v1'), occurredAt: '2026-08-24T15:00:00.000Z' }),
        creditReleasedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('credit.released.v1'), occurredAt: '2026-08-24T16:00:00.000Z' }),
        orderCompletedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: eventIdOf('order.completed.v1'), occurredAt: '2026-08-24T17:00:00.000Z' }),
      ];

      // ── Step 1: produce the full fact set in canonical order, consume, snapshot ──
      const dbName = mongo.db().databaseName;
      const harness1 = await bootProjectorTestApp(mongo, kafka, `replay-determinism-1-${randomUUID().slice(0, 8)}`, dbName);
      for (const fact of facts) {
        await publishFact(kafka.brokers, TOPIC_FOR[fact.eventType]!, orderId, fact);
      }
      const collection = harness1.db.collection('order_timeline');
      await waitFor(async () => (await collection.findOne({ _id: orderId } as never))?.status === 'completed');
      const first = await collection.findOne({ _id: orderId } as never);
      await harness1.close();

      // ── Step 2: drop the collection ── via the FIXTURE's own long-lived
      // client, not the just-closed app's client (app.close() tears down
      // its own MongoConnectionCloser, which closes the app's MongoClient —
      // the fixture's client stays open independently).
      await mongo.client.db(dbName).collection('order_timeline').drop();

      // ── Step 3: produce the SAME set, shuffled by a seeded PRNG, each ──
      // duplicated a deterministic number of times (0/1/2 extra), consume,
      // snapshot again.
      const rng = seededRandom(42);
      const shuffled = shuffle(facts, rng);
      const withDuplicates: Envelope[] = [];
      shuffled.forEach((fact, index) => {
        const extraCopies = index % 3; // 0, 1, 2, 0, 1, 2, ...
        for (let copy = 0; copy <= extraCopies; copy++) {
          withDuplicates.push(fact);
        }
      });

      const harness2 = await bootProjectorTestApp(mongo, kafka, `replay-determinism-2-${randomUUID().slice(0, 8)}`, dbName);
      for (const fact of withDuplicates) {
        await publishFact(kafka.brokers, TOPIC_FOR[fact.eventType]!, orderId, fact);
      }
      const collection2 = harness2.db.collection('order_timeline');
      await waitFor(async () => (await collection2.findOne({ _id: orderId } as never))?.status === 'completed');
      // Settle window — the duplicated deliveries must be observed as
      // suppressed, not merely "not yet arrived".
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const second = await collection2.findOne({ _id: orderId } as never);
      await harness2.close();

      // ── Step 4: whole-document equality ──
      expect(second).toEqual(first);
      expect(second!.processedEventKeys).toEqual([...second!.processedEventKeys].sort());
      expect(second!.events).toHaveLength(9);
    },
    120_000,
  );

  it(
    'PR15 (A1) — a fact delivered BEFORE the fact that caused it produces the IDENTICAL final array as the reverse arrival, because the whole array is re-sorted on every apply, not merely inserted at a computed point',
    async () => {
      const db = mongo.db();
      const collection: Collection<OrderTimelineDocument> = db.collection('order_timeline');
      // Deliberately eventId-adversarial (`RELEASED` sorts LAST
      // lexically), so an eventId-only fallback would ALSO get this
      // wrong if depth were not recomputed — same discipline as the
      // R28/R24 causal-order guards.
      const releasedEventId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const cancelledEventId = '00000000-0000-4000-8000-000000000001';
      const sharedOccurredAt = '2026-08-24T18:00:00.000Z';

      // Order A — canonical arrival: the CAUSE (stock.released.v1) first,
      // the EFFECT (order.cancelled.v1) second.
      const orderIdA = randomUUID();
      const writer = new MongoReadModelWriter(collection);
      await writer.apply(
        projectFact(stockReleasedEnvelope({ eventId: releasedEventId, correlationId: orderIdA, aggregateId: orderIdA, occurredAt: sharedOccurredAt })),
        releasedEventId,
        'projector',
        async () => {},
      );
      await writer.apply(
        projectFact(
          orderCancelledEnvelope({ eventId: cancelledEventId, correlationId: orderIdA, aggregateId: orderIdA, causationId: releasedEventId, occurredAt: sharedOccurredAt }),
        ),
        cancelledEventId,
        'projector',
        async () => {},
      );
      const docA = await collection.findOne({ _id: orderIdA } as never);

      // Order B — the SAME two facts (identical eventId/occurredAt/
      // causationId), but the EFFECT arrives FIRST and the CAUSE SECOND —
      // exactly the shape no cross-topic ordering guarantee rules out
      // (stock.released.v1 and order.cancelled.v1 are on different fact
      // topics, design.md §5.5.2), and the exact case a "just insert the
      // new entry at the right index" optimisation would get wrong: at
      // insertion time the cancellation's own cause has not arrived yet,
      // so its depth would be fixed at 0 and never revised.
      const orderIdB = randomUUID();
      await writer.apply(
        projectFact(
          orderCancelledEnvelope({ eventId: cancelledEventId, correlationId: orderIdB, aggregateId: orderIdB, causationId: releasedEventId, occurredAt: sharedOccurredAt }),
        ),
        cancelledEventId,
        'projector',
        async () => {},
      );
      await writer.apply(
        projectFact(stockReleasedEnvelope({ eventId: releasedEventId, correlationId: orderIdB, aggregateId: orderIdB, occurredAt: sharedOccurredAt })),
        releasedEventId,
        'projector',
        async () => {},
      );
      const docB = await collection.findOne({ _id: orderIdB } as never);

      // Both orders used the SAME eventId/occurredAt/causationId/summary
      // for their two facts, so the ENTRY ARRAYS are directly comparable
      // (only _id/orderId/updatedAt differ at the document level).
      expect(docA!.events.map((e) => e.eventType)).toEqual(['stock.released.v1', 'order.cancelled.v1']);
      expect(docB!.events).toEqual(docA!.events);
    },
    60_000,
  );
}, 180_000);
