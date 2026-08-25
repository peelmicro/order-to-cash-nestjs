// PR17 › publishes order.updated and timeline.appended on per-order NATS
// subjects that a wildcard subscriber and a single-order subscriber both
// receive. PR18 › publishes exactly one signal pair for a first delivery
// and none at all for a suppressed redelivery. Subscribes BEFORE producing
// — terminal evidence (design.md §10 rule 1), never a sleep.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Collection } from 'mongodb';
import { JSONCodec, type NatsConnection } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectFact } from '../../domain/fact-projection';
import { orderPlacedEnvelope } from '../../test-support/envelope-fixtures';
import { startMongoTestFixture, type MongoTestFixture } from '../../test-support/mongo-test-fixture';
import { startNatsTestFixture, type NatsTestFixture } from '../../test-support/nats-test-fixture';
import { MongoReadModelWriter } from '../persistence/mongo-read-model-writer';
import type { OrderTimelineDocument } from '../persistence/order-timeline.document';
import { NatsUpdateSignalPublisher, orderUpdatedSubject, timelineAppendedSubject } from './nats-update-signal.publisher';

const OPENAPI_SPEC_PATH = path.resolve(__dirname, '../../../../../specs/shared/openapi.yaml');

function requiredFieldsOf(specText: string, schemaName: string): string[] {
  const match = specText.match(new RegExp(`\\n {4}${schemaName}:\\n([\\s\\S]*?)\\n {4}\\S`));
  if (!match) {
    throw new Error(`update-signal.integration.spec: could not locate ${schemaName} in openapi.yaml`);
  }
  const requiredLine = match[1]!.match(/required: \[([^\]]*)\]/);
  if (!requiredLine) {
    throw new Error(`update-signal.integration.spec: ${schemaName} has no required: [...] line`);
  }
  return requiredLine[1]!.split(',').map((f) => f.trim());
}

async function collectOne<T>(connection: NatsConnection, subject: string): Promise<T> {
  const codec = JSONCodec<T>();
  const sub = connection.subscribe(subject, { max: 1 });
  for await (const msg of sub) {
    return codec.decode(msg.data);
  }
  throw new Error(`collectOne: subscription on ${subject} closed with no message`);
}

describe('update-signal — PR17/PR18 (Testcontainers, real NATS + real MongoDB)', () => {
  let mongo: MongoTestFixture;
  let nats: NatsTestFixture;
  let connection: NatsConnection;

  beforeAll(async () => {
    mongo = await startMongoTestFixture();
    nats = await startNatsTestFixture();
    connection = await nats.connect();
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await nats?.teardown();
    await mongo?.teardown();
  }, 60_000);

  it(
    'publishes order.updated and timeline.appended on readmodel.order.updated.<orderId>/readmodel.timeline.appended.<orderId>, ' +
      'received by BOTH a wildcard subscriber and a single-order subscriber',
    async () => {
      const db = mongo.db();
      const collection: Collection<OrderTimelineDocument> = db.collection('order_timeline');
      const writer = new MongoReadModelWriter(collection);
      const publisher = new NatsUpdateSignalPublisher(connection);
      const orderId = randomUUID();
      const envelope = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });

      // Subscribe BEFORE producing — terminal evidence, no sleep.
      const wildcardOrderUpdate = collectOne<{ orderId: string }>(connection, 'readmodel.order.updated.*');
      const wildcardTimelineAppended = collectOne<{ orderId: string }>(connection, 'readmodel.timeline.appended.*');
      const singleOrderUpdate = collectOne<{ orderId: string }>(connection, orderUpdatedSubject(orderId));
      const singleTimelineAppended = collectOne<{ orderId: string }>(connection, timelineAppendedSubject(orderId));

      const delta = projectFact(envelope);
      await writer.apply(delta, envelope.eventId, 'projector', (document) => publisher.publish(document));

      const [wcUpdate, wcTimeline, soUpdate, soTimeline] = await Promise.all([
        wildcardOrderUpdate,
        wildcardTimelineAppended,
        singleOrderUpdate,
        singleTimelineAppended,
      ]);

      expect(wcUpdate.orderId).toBe(orderId);
      expect(wcTimeline.orderId).toBe(orderId);
      expect(soUpdate.orderId).toBe(orderId);
      expect(soTimeline.orderId).toBe(orderId);
    },
    30_000,
  );

  it(
    'publishes EXACTLY ONE signal pair for a first delivery, and NONE AT ALL for a suppressed redelivery',
    async () => {
      const db = mongo.db();
      const collection: Collection<OrderTimelineDocument> = db.collection('order_timeline');
      const writer = new MongoReadModelWriter(collection);
      const orderId = randomUUID();
      const envelope = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });
      const delta = projectFact(envelope);

      let publishCount = 0;
      const countingPublisher = { publish: async () => { publishCount += 1; } };

      const first = await writer.apply(delta, envelope.eventId, 'projector', countingPublisher.publish);
      expect(first).toBe('processed');
      expect(publishCount).toBe(1);

      // A REAL redelivery: the exact same eventId, applied again.
      const second = await writer.apply(delta, envelope.eventId, 'projector', countingPublisher.publish);
      expect(second).toBe('duplicate');
      // Terminal evidence: the outcome itself proves the callback was
      // structurally skipped (idempotent-consumer.ts's own contract) —
      // still asserted directly here, not merely inferred.
      expect(publishCount).toBe(1);
    },
    30_000,
  );

  it('F4 — both payload shapes carry every field openapi.yaml declares required, read as TEXT', async () => {
    const specText = readFileSync(OPENAPI_SPEC_PATH, 'utf8');
    const orderStreamUpdateRequired = requiredFieldsOf(specText, 'OrderStreamUpdate');
    const timelineStreamEntryRequired = requiredFieldsOf(specText, 'TimelineStreamEntry');

    expect(orderStreamUpdateRequired).toEqual(['eventId', 'orderId', 'status', 'occurredAt']);
    expect(timelineStreamEntryRequired).toEqual(['eventId', 'orderId', 'eventType', 'occurredAt', 'summary']);

    const db = mongo.db();
    const collection: Collection<OrderTimelineDocument> = db.collection('order_timeline');
    const writer = new MongoReadModelWriter(collection);
    const orderId = randomUUID();
    const envelope = orderPlacedEnvelope({ correlationId: orderId, aggregateId: orderId, eventId: randomUUID() });

    const orderUpdatePromise = collectOne<Record<string, unknown>>(connection, orderUpdatedSubject(orderId));
    const timelineAppendedPromise = collectOne<Record<string, unknown>>(connection, timelineAppendedSubject(orderId));

    const publisher = new NatsUpdateSignalPublisher(connection);
    await writer.apply(projectFact(envelope), envelope.eventId, 'projector', (document) => publisher.publish(document));

    const [orderUpdate, timelineAppended] = await Promise.all([orderUpdatePromise, timelineAppendedPromise]);

    for (const field of orderStreamUpdateRequired) {
      expect(orderUpdate, `OrderStreamUpdate missing required field "${field}"`).toHaveProperty(field);
    }
    for (const field of timelineStreamEntryRequired) {
      expect(timelineAppended, `TimelineStreamEntry missing required field "${field}"`).toHaveProperty(field);
    }
  }, 30_000);
}, 180_000);
