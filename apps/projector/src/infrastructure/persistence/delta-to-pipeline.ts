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

// Amendment A1 (PR32, design.md §5.5.4) — bumped whenever PR10's timeline-
// order rule changes; the migration (timeline-order-migration.ts) selects
// documents to re-sort by comparing this against each document's OWN
// stored stamp — NEVER by field presence, which is precisely the defect
// the rejected first attempt shipped (a filter keyed on
// `events.statusRank` existing, which silently skipped every document it
// had already rewritten once the rank table was corrected).
//
// Version 1 names the pre-A1 scheme (occurredAt/eventId only, then the
// rejected statusRank tiebreak this amendment retires). Version 2 is
// PR10 as amended by A1 — the causal-edge rule below.
export const TIMELINE_ORDER_VERSION = 2;

/**
 * Amendment A1 (PR10, design.md §5.5) — the causal timeline order,
 * expressed as ONE aggregation-pipeline sub-expression, computed and
 * evaluated entirely inside the pipeline (no read, no TypeScript sort —
 * PR6). Given a Mongo expression naming the post-append entry array
 * (`appendedExpr` — a `$$variable` reference, evaluated exactly once by
 * the caller's `$let`), produces the SAME array sorted by
 * `(occurredAt asc, causal depth asc, eventId asc)`, with the transient
 * depth key computed and discarded within this expression alone — never
 * stored (PR15 byte-identity, design.md §5.5.3).
 *
 * Depth is a fixpoint evaluated over `|appended|` relaxation rounds
 * (design.md §5.5.1) — sufficient for any acyclic causal forest over
 * `|appended|` nodes, and what makes evaluation terminate unconditionally
 * even over a fabricated cycle (PR31): every entry is mapped, never
 * filtered, so the round count bounds the computation without ever
 * throwing, looping unboundedly, or losing an entry.
 *
 * A cause is looked up ONLY among entries sharing the SAME `occurredAt` as
 * the entry itself (a tie group, PR10 clause 2) — an entry whose
 * `causationId` names a fact in a different tie group, a fact never
 * received, or a command id rather than a fact simply finds no cause and
 * gets depth 0, placed by the `eventId` fallback alone (PR31). Ties are
 * NEVER inferred from `eventType`, from an implied status, or from any
 * other derived property — an edge exists only where one entry's
 * `causationId` is literally another entry's `eventId` (PR10's own final
 * sentence).
 */
export function causalTimelineOrder(appendedExpr: unknown): Record<string, unknown> {
  const depthZeroed = {
    $map: {
      input: appendedExpr,
      as: 'e',
      in: { $mergeObjects: ['$$e', { __depth: 0 }] },
    },
  };

  // ONE relaxation round: every entry's depth is recomputed SIMULTANEOUSLY
  // from the array as it stood at the START of the round ('$$value') —
  // never from partial results within the same round — so the order the
  // $map visits entries in cannot itself bias the outcome (PR15).
  const oneRelaxationRound = {
    $map: {
      input: '$$value',
      as: 'e',
      in: {
        $let: {
          vars: {
            cause: {
              $arrayElemAt: [
                {
                  $filter: {
                    input: '$$value',
                    as: 'c',
                    cond: {
                      $and: [
                        { $eq: ['$$c.eventId', '$$e.causationId'] },
                        { $eq: ['$$c.occurredAt', '$$e.occurredAt'] },
                        { $ne: ['$$c.eventId', '$$e.eventId'] }, // no self-loop
                      ],
                    },
                  },
                },
                0,
              ],
            },
          },
          // `$arrayElemAt` on an EMPTY $filter result yields MISSING, not
          // BSON null — `$eq: ['$$cause', null]` does NOT catch a missing
          // variable (found live: it silently fell through to the
          // "found a cause" branch, whose `$add` against a missing
          // `$$cause.__depth` then evaluates to null, corrupting the
          // fixpoint for every entry with NO cause). `$ifNull` catches
          // BOTH missing and null uniformly, so this is the one arm that
          // matters — no separate "no cause" branch needed at all.
          in: {
            $mergeObjects: [
              '$$e',
              { __depth: { $ifNull: [{ $add: ['$$cause.__depth', 1] }, 0] } },
            ],
          },
        },
      },
    },
  };

  const depthFixpoint = {
    $reduce: {
      input: { $range: [0, { $size: appendedExpr as never }] },
      initialValue: depthZeroed,
      in: oneRelaxationRound,
    },
  };

  const sortedWithDepth = {
    $sortArray: {
      input: depthFixpoint,
      sortBy: { occurredAt: 1, __depth: 1, eventId: 1 },
    },
  };

  // Drop `__depth` — and the RETIRED entry-level `statusRank` key the
  // rejected first attempt wrote (design.md §5.5.4's migration table:
  // "cleanup of a retired key ... in the SAME update") — generically, by
  // key over $objectToArray, rather than re-listing every entry field by
  // hand. Correct whether `detail` is present or not, correct whether the
  // entry ever carried `statusRank` or not (a live apply's own entries
  // never do, so this is a no-op on that path), and stays correct if the
  // entry shape ever grows a field (design.md §5.5.3's "a $map projecting
  // the entry's own fields"). Reused VERBATIM by the boot migration
  // (timeline-order-migration.ts, design.md §5.5.4 — "the SAME rule
  // expression as the live pipeline").
  return {
    $map: {
      input: sortedWithDepth,
      as: 'e',
      in: {
        $arrayToObject: {
          $filter: {
            input: { $objectToArray: '$$e' },
            as: 'kv',
            cond: { $not: [{ $in: ['$$kv.k', ['__depth', 'statusRank']] }] },
          },
        },
      },
    },
  };
}

export function deltaToPipeline(delta: ProjectionDelta, dedupKey: string): Record<string, unknown>[] {
  const entryDoc = {
    eventId: delta.entry.eventId,
    eventType: delta.entry.eventType,
    occurredAt: delta.entry.occurredAt,
    summary: delta.entry.summary,
    // Amendment A1 (PR30) — the recorded causal edge, stored verbatim.
    // `causalTimelineOrder` above is the ONLY consumer of this field
    // inside the pipeline; PUBLIC on the wire (PR33, gate ruling —
    // requirements.md open point 4/6): unlike the retired entry-level
    // `statusRank`, this is NOT excluded by the Gateway's
    // `EXCLUDE_INTERNAL_FIELDS` — `eventId` is already public, and
    // `causationId` is a first-class envelope field (R11), not a
    // projector-derived artefact.
    causationId: delta.entry.causationId,
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
    // PR10 (A1) — sorted IN THE DOCUMENT, not at read time, by the causal
    // timeline order above. The WHOLE array is recomputed on every apply
    // (never just the insertion point) — PR15: a fact that arrives BEFORE
    // the fact that caused it (no cross-topic ordering guarantee across
    // the three fact topics) produces the identical final array as the
    // reverse arrival, because depth is a property of the tie GROUP, not
    // of the entry, and can only be known once every member has arrived.
    events: {
      $let: {
        vars: { appended: { $concatArrays: [{ $ifNull: ['$events', []] }, [entryDoc]] } },
        in: causalTimelineOrder('$$appended'),
      },
    },
    // Amendment A1 (PR32) — stamped on EVERY apply, so a document this
    // projector writes is always at the CURRENT version the moment it is
    // written; the boot migration (timeline-order-migration.ts) is what
    // brings an ALREADY-STORED document up to date, selected by comparing
    // this value — never by field presence.
    timelineOrderVersion: TIMELINE_ORDER_VERSION,

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
