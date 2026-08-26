// PR12 unit half.
import { describe, expect, it } from 'vitest';
import { impliedStatusOf, rankOf, UnknownEventTypeForRankError } from './order-status-rank';

const TABLE: readonly (readonly [string, string | null, number])[] = [
  ['order.placed.v1', 'placed', 1],
  ['stock.reserved.v1', 'stock_reserved', 2],
  ['credit.approved.v1', 'credit_approved', 3],
  ['order.confirmed.v1', 'confirmed', 4],
  ['order.despatched.v1', 'despatched', 5],
  ['invoice.issued.v1', 'invoiced', 6],
  ['payment.received.v1', 'paid', 7],
  ['order.completed.v1', 'completed', 98],
  ['order.cancelled.v1', 'cancelled', 99],
  ['stock.rejected.v1', null, 0],
  ['stock.released.v1', null, 0],
  ['credit.rejected.v1', null, 0],
  ['credit.released.v1', null, 0],
  ['order.saga_failed.v1', null, 0],
];

describe('order-status-rank — PR12 › maps each of the fourteen facts to the implied status and rank of PR12\'s table, with the five status-less facts implying none', () => {
  it.each(TABLE)('%s -> status %s, rank %d', (eventType, status, rank) => {
    expect(impliedStatusOf(eventType)).toBe(status);
    expect(rankOf(eventType)).toBe(rank);
  });

  it('covers exactly the fourteen entries above — no more, no fewer', () => {
    expect(TABLE).toHaveLength(14);
  });

  it('throws UnknownEventTypeForRankError for an eventType not in the table, rather than defaulting silently', () => {
    expect(() => impliedStatusOf('bogus.fact.v1')).toThrow(UnknownEventTypeForRankError);
    expect(() => rankOf('bogus.fact.v1')).toThrow(UnknownEventTypeForRankError);
  });
});
