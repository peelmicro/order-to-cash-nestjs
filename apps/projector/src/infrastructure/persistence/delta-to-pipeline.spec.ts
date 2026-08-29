import { describe, expect, it } from 'vitest';
import { projectFact } from '../../domain/fact-projection';
import {
  creditApprovedEnvelope,
  orderCancelledEnvelope,
  orderDespatchedEnvelope,
  orderPlacedEnvelope,
  stockRejectedEnvelope,
} from '../../test-support/envelope-fixtures';
import { dedupKeyOf, deltaToPipeline, TIMELINE_ORDER_VERSION } from './delta-to-pipeline';

describe('delta-to-pipeline — the emitted $set stage tree', () => {
  it('a status-implying fact ($max on statusRank, $cond raising status)', () => {
    const delta = projectFact(creditApprovedEnvelope());
    const [stage] = deltaToPipeline(delta, dedupKeyOf('projector', delta.entry.eventId));
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect($set.statusRank).toEqual({ $max: [{ $ifNull: ['$statusRank', 0] }, 3] });
    expect($set.status).toEqual({
      $cond: [{ $gt: [3, { $ifNull: ['$statusRank', 0] }] }, 'credit_approved', '$status'],
    });
  });

  it('a status-less fact (rank 0) leaves status literally unchanged', () => {
    const delta = projectFact(stockRejectedEnvelope());
    const [stage] = deltaToPipeline(delta, dedupKeyOf('projector', delta.entry.eventId));
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect(delta.statusRank).toBe(0);
    expect($set.status).toBe('$status');
    expect($set.statusRank).toEqual({ $max: [{ $ifNull: ['$statusRank', 0] }, 0] });
  });

  it('order.placed.v1 writes the header fields unconditionally, and headerComplete: true', () => {
    const delta = projectFact(orderPlacedEnvelope());
    const [stage] = deltaToPipeline(delta, dedupKeyOf('projector', delta.entry.eventId));
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect($set.orderReference).toBe('ORD-000001');
    expect($set.headerComplete).toBe(true);
    expect($set.currency).toBe('USD');
    expect($set.totals).toEqual({ initialAmount: 2000, initialDiscount: 0, totalAmount: 2000 });
    // Unconditional — no $ifNull wrapper on a header field.
    expect(typeof $set.orderReference).toBe('string');
  });

  it('a reference-carrying fact applies $ifNull ONLY to that reference', () => {
    const delta = projectFact(orderDespatchedEnvelope());
    const [stage] = deltaToPipeline(delta, dedupKeyOf('projector', delta.entry.eventId));
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect($set['references.despatchReference']).toEqual({
      $ifNull: ['$references.despatchReference', 'DES-000001'],
    });
    expect($set).not.toHaveProperty('references.invoiceReference');
    expect($set).not.toHaveProperty('references.paymentReference');
    expect($set).not.toHaveProperty('orderReference');
  });

  it('PR13 — order.cancelled.v1 applies $ifNull ONLY to cancellationReason, written only while it is null', () => {
    const delta = projectFact(orderCancelledEnvelope());
    const [stage] = deltaToPipeline(delta, dedupKeyOf('projector', delta.entry.eventId));
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect($set.cancellationReason).toEqual({
      $ifNull: ['$cancellationReason', 'credit_rejected'],
    });
    // Rank 99 (terminal) still raises status unconditionally on first apply
    // (design.md's own "completed/cancelled both terminal and distinct"
    // note) — cancellationReason's guard is independent of that.
    expect($set.status).toEqual({
      $cond: [{ $gt: [99, { $ifNull: ['$statusRank', 0] }] }, 'cancelled', '$status'],
    });
  });

  it('processedEventKeys and events are always $sortArray-wrapped and $ifNull-guarded on their input', () => {
    const delta = projectFact(orderPlacedEnvelope());
    const dedupKey = dedupKeyOf('projector', delta.entry.eventId);
    const [stage] = deltaToPipeline(delta, dedupKey);
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect($set.processedEventKeys).toEqual({
      $sortArray: {
        input: { $setUnion: [{ $ifNull: ['$processedEventKeys', []] }, [dedupKey]] },
        sortBy: 1,
      },
    });
  });

  it('PR10 (A1) — the appended entry carries its OWN causationId verbatim, and the events pipeline is the causal-timeline-order $let/$sortArray expression', () => {
    const delta = projectFact(orderCancelledEnvelope({ causationId: 'cause-of-cancellation' }));
    const [stage] = deltaToPipeline(delta, dedupKeyOf('projector', delta.entry.eventId));
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect(delta.entry.causationId).toBe('cause-of-cancellation');
    interface StageShape {
      $set: {
        events: {
          $let: {
            vars: { appended: { $concatArrays: [unknown, { causationId: string }[]] } };
          };
        };
      };
    }
    const entryDoc = (stage as unknown as StageShape).$set.events.$let.vars.appended.$concatArrays[1][0]!;
    // PR30 — the causal edge, not an eventType-derived key.
    expect(entryDoc.causationId).toBe('cause-of-cancellation');
    expect(entryDoc).not.toHaveProperty('statusRank');

    // PR10 — the sort is expressed as one $let binding the post-append
    // array, whose `in` is a $sortArray keyed on
    // (occurredAt, __depth, eventId) computed by the causal-depth
    // $reduce fixpoint (design.md §5.5.3) and then stripped of __depth —
    // never a plain $sortArray over a stored eventType-derived field.
    expect($set.events).toHaveProperty('$let');
    const inner = JSON.stringify($set.events);
    expect(inner).toContain('__depth');
    expect(inner).toContain('$reduce');
    expect(inner).toContain('$range');
    // "statusRank" DOES appear once, as the literal key name the field-drop
    // filter strips (design.md §5.5.4's migration table, "cleanup of a
    // retired key ... in the SAME update") — never as a sort key.
    expect($set.events).not.toMatchObject({ $sortArray: { sortBy: { statusRank: expect.anything() } } });
  });

  it('PR32 (A1) — every apply stamps the current timelineOrderVersion, unconditionally', () => {
    const delta = projectFact(orderPlacedEnvelope());
    const [stage] = deltaToPipeline(delta, dedupKeyOf('projector', delta.entry.eventId));
    const $set = (stage as { $set: Record<string, unknown> }).$set;

    expect($set.timelineOrderVersion).toBe(TIMELINE_ORDER_VERSION);
  });
});
