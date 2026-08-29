// Amendment A1 (PR32, PR35, design.md §5.5.4) — the version-stamped
// migration. Called from main.ts alongside `backfillLegacyDocuments` and
// the (now-retired) `backfillTimelineEntryRanks`, BEFORE any Kafka
// consumption starts: a TERMINAL order (`completed`/`cancelled`) never
// receives another fact, so its stored `events` order is FROZEN and only
// a migration can bring it up to the current rule.
//
// Selects on `{ timelineOrderVersion: { $ne: TIMELINE_ORDER_VERSION } }` —
// a VALUE comparison, never field presence. This is the exact defect the
// rejected first attempt shipped: its filter
// (`{ 'events.statusRank': { $exists: false } }`) matched on whether the
// field existed, so once every entry carried it, a LATER correction to the
// rank table would silently skip every document already rewritten, on a
// green suite, logging "0 document(s) backfilled". A version comparison
// cannot make that mistake: incrementing `TIMELINE_ORDER_VERSION` alone is
// sufficient to make every already-migrated document be re-sorted again.
//
// The re-sort uses `causalTimelineOrder` — the SAME expression the live
// `$set` stage uses (`delta-to-pipeline.ts`) — applied to the document's
// OWN stored `events`, with no append. PR35: this NEVER invents a
// `causationId` for an entry that has none; an edgeless entry simply falls
// back to `(occurredAt, eventId)`, exactly as it would on a live apply.
import type { Db, WithId } from 'mongodb';
import { causalTimelineOrder, TIMELINE_ORDER_VERSION } from './delta-to-pipeline';
import { ORDER_TIMELINE_COLLECTION } from './read-model-indexes';
import type { OrderTimelineDocument } from './order-timeline.document';

export interface TimelineOrderMigrationResult {
  /** Documents whose `events` order was version-mismatched and have now been re-sorted and re-stamped. */
  readonly migrated: number;
  /**
   * PR35 — of the documents just migrated, how many still contain at
   * least one entry with NO stored `causationId` (every document written
   * before A1, and every document `apps/seed` wrote before PR34). Those
   * orders' tie groups have no causal edges, so the migration's re-sort
   * falls back to `(occurredAt, eventId)` for them — reported here so an
   * operator learns they are ordered by the fallback rather than believing
   * the ordering was genuinely repaired.
   */
  readonly stillEdgeless: number;
}

interface EdgelessProjection {
  readonly _id: string;
  readonly events?: readonly { readonly causationId?: string }[];
}

export async function migrateTimelineOrder(db: Db): Promise<TimelineOrderMigrationResult> {
  const collection = db.collection<OrderTimelineDocument>(ORDER_TIMELINE_COLLECTION);
  const versionMismatch = { timelineOrderVersion: { $ne: TIMELINE_ORDER_VERSION } } as never;

  // PR35's count is a property of the STORED data (which entries carry a
  // causationId at all), not of the re-sort — read BEFORE migrating so the
  // report names exactly the documents this run touched, not the whole
  // collection's live state after the write.
  const candidates: WithId<EdgelessProjection>[] = (await collection
    .find(versionMismatch, { projection: { 'events.causationId': 1 } })
    .toArray()) as unknown as WithId<EdgelessProjection>[];

  if (candidates.length === 0) {
    return { migrated: 0, stillEdgeless: 0 };
  }

  const stillEdgeless = candidates.filter((doc) =>
    (doc.events ?? []).some((entry) => entry.causationId === undefined),
  ).length;

  const result = await collection.updateMany(versionMismatch, [
    {
      $set: {
        events: {
          $let: {
            vars: { appended: { $ifNull: ['$events', []] } },
            in: causalTimelineOrder('$$appended'),
          },
        },
        timelineOrderVersion: TIMELINE_ORDER_VERSION,
      },
    },
  ] as never);

  return { migrated: result.modifiedCount, stillEdgeless };
}
