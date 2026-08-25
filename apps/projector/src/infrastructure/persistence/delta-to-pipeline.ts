// `ProjectionDelta` -> the `$set` stage of design.md §5.3 — a PURE function
// returning plain objects (an aggregation-pipeline update array), no driver
// call. Every array and rank operand is `$ifNull`-guarded (design.md §5.3's
// own note): `$setUnion`/`$concatArrays` error on a missing field, and a
// missing `$statusRank` compares as null, which BSON orders BELOW every
// number — an unguarded `$gt: [1, '$statusRank']` would be `true` and
// regress a document that has a status but no rank (exactly the shape
// legacy-document-backfill.ts exists to fix for pre-existing rows; this
// file's guards make the pipeline TOTAL over any document regardless).
import type { ProjectionDelta } from '../../domain/projection-delta';

/** The dedup key: `${consumer}:${eventId}` (PR23, R17 — the pair, never the eventId alone). */
export function dedupKeyOf(consumer: string, eventId: string): string {
  return `${consumer}:${eventId}`;
}

export function deltaToPipeline(delta: ProjectionDelta, dedupKey: string): Record<string, unknown>[] {
  const entryDoc = {
    eventId: delta.entry.eventId,
    eventType: delta.entry.eventType,
    occurredAt: delta.entry.occurredAt,
    summary: delta.entry.summary,
    ...(delta.entry.detail ? { detail: delta.entry.detail } : {}),
  };

  const setStage: Record<string, unknown> = {
    // PR15/PR23 — a set union's element order is unspecified; sorted so
    // replay determinism holds byte-for-byte.
    processedEventKeys: {
      $sortArray: {
        input: { $setUnion: [{ $ifNull: ['$processedEventKeys', []] }, [dedupKey]] },
        sortBy: 1,
      },
    },
    // PR10 — sorted IN THE DOCUMENT, not at read time.
    events: {
      $sortArray: {
        input: { $concatArrays: [{ $ifNull: ['$events', []] }, [entryDoc]] },
        sortBy: { occurredAt: 1, eventId: 1 },
      },
    },
    // PR12 — rank 0 for status-less facts leaves the stored rank untouched.
    statusRank: { $max: [{ $ifNull: ['$statusRank', 0] }, delta.statusRank] },
    // R52 — raised ONLY on a STRICTLY greater rank; both operands are
    // evaluated against the PRE-UPDATE document within this one $set stage,
    // so this agrees with statusRank's own $max above without ordering
    // games (design.md §5.3's own note).
    status: delta.impliedStatus
      ? { $cond: [{ $gt: [delta.statusRank, { $ifNull: ['$statusRank', 0] }] }, delta.impliedStatus, '$status'] }
      : '$status',
    // PR14 — never a wall clock; the greatest occurredAt applied so far.
    updatedAt: { $max: [{ $ifNull: ['$updatedAt', delta.entry.occurredAt] }, delta.entry.occurredAt] },
  };

  // PR11/PR13 — written only while absent, evaluated inside the atomic apply.
  if (delta.fillIfAbsent.references?.despatchReference !== undefined) {
    setStage['references.despatchReference'] = {
      $ifNull: ['$references.despatchReference', delta.fillIfAbsent.references.despatchReference],
    };
  }
  if (delta.fillIfAbsent.references?.invoiceReference !== undefined) {
    setStage['references.invoiceReference'] = {
      $ifNull: ['$references.invoiceReference', delta.fillIfAbsent.references.invoiceReference],
    };
  }
  if (delta.fillIfAbsent.references?.paymentReference !== undefined) {
    setStage['references.paymentReference'] = {
      $ifNull: ['$references.paymentReference', delta.fillIfAbsent.references.paymentReference],
    };
  }
  if (delta.fillIfAbsent.cancellationReason !== undefined) {
    setStage['cancellationReason'] = { $ifNull: ['$cancellationReason', delta.fillIfAbsent.cancellationReason] };
  }

  // PR9 — written UNCONDITIONALLY when present. No $ifNull protection:
  // order.placed.v1 occurs exactly once per order and the dedup filter
  // already stops its redelivery; conditionally writing it would hide a
  // genuine defect (two order.placed.v1 facts for one order id) behind a
  // silent no-op.
  if (delta.header) {
    setStage['orderReference'] = delta.header.orderReference;
    setStage['orderDate'] = delta.header.orderDate;
    setStage['retailer.code'] = delta.header.retailer.code;
    setStage['retailer.gln'] = delta.header.retailer.gln;
    setStage['company.code'] = delta.header.company.code;
    setStage['company.gln'] = delta.header.company.gln;
    setStage['currency'] = delta.header.currency;
    setStage['totals'] = delta.header.totals;
    setStage['items'] = delta.header.items;
    setStage['headerComplete'] = true;
  }

  return [{ $set: setStage }];
}
