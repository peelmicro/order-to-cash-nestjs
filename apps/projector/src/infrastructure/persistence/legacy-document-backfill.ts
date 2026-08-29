// PR29, design.md §11 — the one-shot boot backfill. Called from main.ts
// BEFORE `startAllMicroservices()` (§8.1), so no fact is ever consumed
// against a document `apps/seed` wrote that has not yet been backfilled.
//
// Every document `apps/seed` has ever written has `headerComplete: true`,
// nine-or-so timeline entries, but NO `statusRank` and an EMPTY
// `processedEventKeys`. Left as-is:
//   - `$setUnion`/`$concatArrays` on a missing field ERROR (delta-to-pipeline.ts's
//     `$ifNull` guards fix this half, independently of this file);
//   - a missing `statusRank` compares as null, which BSON orders BELOW
//     every number, so `order.placed.v1` (rank 1) would satisfy
//     `$gt: [1, null]` and REGRESS a seeded `completed` order to `placed`
//     — a live R52 violation caused entirely by pre-existing rows;
//   - an EMPTY `processedEventKeys` means the dedup filter suppresses
//     NOTHING, so a replay would append every seeded fact a SECOND time —
//     a live R51 violation, also caused entirely by pre-existing rows.
//
// This backfill derives `statusRank` from the document's OWN `status` and
// `processedEventKeys` from the document's OWN `events[].eventId` — the
// same "the eventId is already in the timeline, use it" observation from
// design.md §9.2, applied where it genuinely belongs: reconstructing a
// ledger for documents this service never wrote itself, not as the
// steady-state dedup mechanism (which stays `processedEventKeys` as its own
// field — §9.2 explains why the two are not merged).
//
// Filtered on `{ statusRank: { $exists: false } }` — idempotent by
// construction: a no-op on its own second run, and a no-op on every
// document THIS projector wrote (which always carries `statusRank` from its
// very first apply).
import type { Db } from 'mongodb';
import { ORDER_TIMELINE_COLLECTION } from './read-model-indexes';

// SonarQube typescript:S7739 ("Do not add `then` to an object") is
// suppressed for this whole file in sonar-project.properties
// (sonar.issue.ignore.multicriteria) — `then:` below is MongoDB's own
// required $switch branch syntax, not a thenable; see that file's comment
// for the full reasoning.
const STATUS_RANK_SWITCH = {
  $switch: {
    branches: [
      { case: { $eq: ['$status', 'placed'] }, then: 1 },
      { case: { $eq: ['$status', 'stock_reserved'] }, then: 2 },
      { case: { $eq: ['$status', 'credit_approved'] }, then: 3 },
      { case: { $eq: ['$status', 'confirmed'] }, then: 4 },
      { case: { $eq: ['$status', 'despatched'] }, then: 5 },
      { case: { $eq: ['$status', 'invoiced'] }, then: 6 },
      { case: { $eq: ['$status', 'paid'] }, then: 7 },
      { case: { $eq: ['$status', 'completed'] }, then: 98 },
      { case: { $eq: ['$status', 'cancelled'] }, then: 99 },
    ],
    default: 0,
  },
};

export async function backfillLegacyDocuments(db: Db): Promise<number> {
  const collection = db.collection(ORDER_TIMELINE_COLLECTION);

  const result = await collection.updateMany({ statusRank: { $exists: false } }, [
    {
      $set: {
        statusRank: STATUS_RANK_SWITCH,
        processedEventKeys: {
          $sortArray: {
            input: {
              $map: {
                input: { $ifNull: ['$events', []] },
                as: 'e',
                in: { $concat: ['projector:', '$$e.eventId'] },
              },
            },
            sortBy: 1,
          },
        },
      },
    },
  ]);

  return result.modifiedCount;
}
