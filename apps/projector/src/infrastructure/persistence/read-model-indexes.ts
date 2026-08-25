// PR22 — creates the read model's indexes idempotently at boot, called from
// main.ts BEFORE any Kafka consumption starts (design.md §8.1). The
// `orderReference` uniqueness index is PARTIAL: a placeholder (PR8) carries
// `orderReference: null`, and MongoDB indexes and compares nulls equal, so
// a plain unique index would reject the SECOND placeholder with a
// duplicate-key error. Restricting the index to documents where
// `orderReference` is genuinely a string leaves every complete document
// covered and every placeholder outside the index entirely.
//
// Creating the SAME index name with different options fails LOUDLY with
// `IndexOptionsConflict` (MongoDB error code 85) rather than silently
// running against the wrong index — which is exactly PR22's second clause:
// this function does not swallow that error, it re-throws it wrapped with
// the offending index's name so an operator sees immediately which index
// needs dropping (`apps/seed`'s pre-partial `uq_order_reference`, if the
// database predates this feature).
import type { Db } from 'mongodb';
import type { MongoServerError } from 'mongodb';

export const ORDER_TIMELINE_COLLECTION = 'order_timeline';

const MONGO_INDEX_OPTIONS_CONFLICT = 85;

export async function ensureReadModelIndexes(db: Db): Promise<void> {
  const collection = db.collection(ORDER_TIMELINE_COLLECTION);

  try {
    await collection.createIndex(
      { orderReference: 1 },
      {
        unique: true,
        name: 'uq_order_reference',
        partialFilterExpression: { orderReference: { $type: 'string' } },
      },
    );
  } catch (error) {
    const mongoError = error as MongoServerError;
    if (mongoError?.code === MONGO_INDEX_OPTIONS_CONFLICT) {
      throw new Error(
        'ensureReadModelIndexes: index "uq_order_reference" already exists with different options ' +
          '(IndexOptionsConflict) — this database predates the partial-index fix (projector_read_model PR22) ' +
          'and must have its non-partial uq_order_reference dropped by hand ' +
          "(db.order_timeline.dropIndex('uq_order_reference')) before the projector can start safely.",
        { cause: error },
      );
    }
    throw error;
  }

  // Feature 25's list query (`GET /orders`) — not required by this
  // feature's own acceptance, added here because only the writer knows the
  // placeholder's shape (requirements.md §4).
  await collection.createIndex({ status: 1, updatedAt: -1 }, { name: 'ix_status_updatedAt' });
}
