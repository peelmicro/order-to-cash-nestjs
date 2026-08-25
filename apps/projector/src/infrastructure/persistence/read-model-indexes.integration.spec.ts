// PR22 › creates the orderReference uniqueness index partially so two
// placeholders with a null reference both insert, and refuses to start
// against a non-partial index of the same name.
import type { Db } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMongoTestFixture, type MongoTestFixture } from '../../test-support/mongo-test-fixture';
import { ensureReadModelIndexes, ORDER_TIMELINE_COLLECTION } from './read-model-indexes';
import type { OrderTimelineDocument } from './order-timeline.document';

function placeholderSkeleton(orderId: string): OrderTimelineDocument {
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
    updatedAt: '2026-08-24T00:00:00.000Z',
    statusRank: 0,
    processedEventKeys: [],
  };
}

describe('read-model-indexes — PR22', () => {
  let fixture: MongoTestFixture;
  let db: Db;

  beforeAll(async () => {
    fixture = await startMongoTestFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  beforeEach(() => {
    db = fixture.db();
  });

  it('creates the orderReference uniqueness index PARTIALLY so two placeholders with a null reference both insert', async () => {
    await ensureReadModelIndexes(db);
    const collection = db.collection<OrderTimelineDocument>(ORDER_TIMELINE_COLLECTION);

    await collection.insertOne(placeholderSkeleton('order-a'));
    // The second placeholder, ALSO carrying orderReference: null — this is
    // exactly what a plain (non-partial) unique index would reject with
    // E11000, and what proves this case genuinely bites.
    await expect(collection.insertOne(placeholderSkeleton('order-b'))).resolves.toBeTruthy();

    const count = await collection.countDocuments({ orderReference: null });
    expect(count).toBe(2);
  });

  it('bites: a NON-partial index of the same name rejects the second null-orderReference placeholder', async () => {
    const collection = db.collection<OrderTimelineDocument>(ORDER_TIMELINE_COLLECTION);
    await collection.createIndex({ orderReference: 1 }, { unique: true, name: 'uq_order_reference' });

    await collection.insertOne(placeholderSkeleton('order-a'));
    await expect(collection.insertOne(placeholderSkeleton('order-b'))).rejects.toThrow(/E11000|duplicate key/i);
  });

  it('refuses to start (fails loudly, naming the offending index) against a non-partial index of the same name', async () => {
    const collection = db.collection<OrderTimelineDocument>(ORDER_TIMELINE_COLLECTION);
    await collection.createIndex({ orderReference: 1 }, { unique: true, name: 'uq_order_reference' });

    await expect(ensureReadModelIndexes(db)).rejects.toThrow(/uq_order_reference/);
  });

  it('is idempotent — running it twice against a fresh database succeeds both times', async () => {
    await ensureReadModelIndexes(db);
    await expect(ensureReadModelIndexes(db)).resolves.toBeUndefined();
  });

  it('creates the status/updatedAt index for feature 25\'s list query', async () => {
    await ensureReadModelIndexes(db);
    const indexes = await db.collection<OrderTimelineDocument>(ORDER_TIMELINE_COLLECTION).listIndexes().toArray();
    expect(indexes.some((ix) => ix.name === 'ix_status_updatedAt')).toBe(true);
  });
}, 180_000);
