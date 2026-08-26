// PR12's table, verbatim (requirements.md §2.2, design.md §3/§5.3). ZERO
// framework/driver imports — this is domain code (PR28), enforced by the
// ESLint domain-purity rule.
//
// Ranks 1-7 are the order state machine's own LINEAR progression
// (domain-model.md §3), so on that segment "precedes" is a total order,
// decidable by comparison alone. `completed` (98) and `cancelled` (99) are
// both terminal and mutually unreachable — ranked highest and distinct so
// the projection stays TOTAL even in the face of a genuinely impossible
// delivery. The four status-less facts (compensation/credit mechanics)
// contribute NO status and rank 0: their outcome reaches the document as
// `order.cancelled.v1`, exactly as domain-model.md §7.3 says it reaches
// Notifications.
export type OrderStatus =
  | 'placed'
  | 'stock_reserved'
  | 'credit_approved'
  | 'confirmed'
  | 'despatched'
  | 'invoiced'
  | 'paid'
  | 'completed'
  | 'cancelled';

interface RankEntry {
  readonly status: OrderStatus | null;
  readonly rank: number;
}

/**
 * The full thirteen-row table. No default arm — every `eventType` this
 * service is asked to project must appear here explicitly, or
 * `impliedStatusOf`/`rankOf` throw rather than guess.
 */
const RANK_TABLE: Readonly<Record<string, RankEntry>> = {
  'order.placed.v1': { status: 'placed', rank: 1 },
  'stock.reserved.v1': { status: 'stock_reserved', rank: 2 },
  'credit.approved.v1': { status: 'credit_approved', rank: 3 },
  'order.confirmed.v1': { status: 'confirmed', rank: 4 },
  'order.despatched.v1': { status: 'despatched', rank: 5 },
  'invoice.issued.v1': { status: 'invoiced', rank: 6 },
  'payment.received.v1': { status: 'paid', rank: 7 },
  'order.completed.v1': { status: 'completed', rank: 98 },
  'order.cancelled.v1': { status: 'cancelled', rank: 99 },
  'stock.rejected.v1': { status: null, rank: 0 },
  'stock.released.v1': { status: null, rank: 0 },
  'credit.rejected.v1': { status: null, rank: 0 },
  'credit.released.v1': { status: null, rank: 0 },
  // The 14th fact (R29's dead-letter clause / OR3, feature 27) — purely
  // diagnostic, proves nothing about status, same shape as the other
  // status-less facts above.
  'order.saga_failed.v1': { status: null, rank: 0 },
};

export class UnknownEventTypeForRankError extends Error {
  constructor(eventType: string) {
    super(`order-status-rank: no PR12 rank entry for eventType "${eventType}"`);
    this.name = new.target.name;
  }
}

function entryFor(eventType: string): RankEntry {
  const entry = RANK_TABLE[eventType];
  if (!entry) {
    throw new UnknownEventTypeForRankError(eventType);
  }
  return entry;
}

/** The status a fact PROVES has been reached, or `null` for a fact that proves nothing about the order's status. */
export function impliedStatusOf(eventType: string): OrderStatus | null {
  return entryFor(eventType).status;
}

/** The fact's status rank — 0 for every status-less fact. */
export function rankOf(eventType: string): number {
  return entryFor(eventType).rank;
}

/** The thirteen `eventType` keys this table covers — used by fact-projection.spec.ts's PR2 structural cross-check. */
export function rankedEventTypes(): readonly string[] {
  return Object.keys(RANK_TABLE);
}
