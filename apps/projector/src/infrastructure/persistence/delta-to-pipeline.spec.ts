import { describe, expect, it } from 'vitest';
import { projectFact } from '../../domain/fact-projection';
import {
  creditApprovedEnvelope,
  orderCancelledEnvelope,
  orderDespatchedEnvelope,
  orderPlacedEnvelope,
  stockRejectedEnvelope,
} from '../../test-support/envelope-fixtures';
import { dedupKeyOf, deltaToPipeline } from './delta-to-pipeline';

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
    expect($set.events).toMatchObject({
      $sortArray: { sortBy: { occurredAt: 1, eventId: 1 } },
    });
  });
});
