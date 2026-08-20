// Table T-1 (`domain-model.md` §3.3) expressed as data, verbatim — the 12
// rows including the creation row. design.md §5: "a table and not a switch
// cascade" so the legality set is diffable against the shared spec by eye
// and exhaustively testable as a single data structure, rather than
// scattered across eight methods.
import type { OrderStatus } from './order-status.js';

/** The literal `eventType` of one of the four facts Orders itself emits (design.md §6). */
export type OrdersFactType =
  | 'order.placed.v1'
  | 'order.confirmed.v1'
  | 'order.completed.v1'
  | 'order.cancelled.v1';

export interface OrderTransition {
  /** `null` = creation — Table T-1 row 1, the only edge with no source status. */
  readonly from: OrderStatus | null;
  readonly to: OrderStatus;
  /** The T-1 "Trigger" cell, verbatim — for docs and error messages. */
  readonly trigger: string;
  /** The T-1 "Fact emitted by Orders" cell — `null` when the edge emits nothing (OA2). */
  readonly emits: OrdersFactType | null;
}

export const ORDER_TRANSITIONS: readonly OrderTransition[] = [
  {
    from: null,
    to: 'placed',
    trigger: 'Order accepted (availability check passed, order persisted)',
    emits: 'order.placed.v1',
  },
  {
    from: 'placed',
    to: 'stock_reserved',
    trigger: 'stock.reserved.v1 observed by the orchestrator',
    emits: null,
  },
  {
    from: 'stock_reserved',
    to: 'credit_approved',
    trigger: 'credit.approved.v1 observed by the orchestrator',
    emits: null,
  },
  {
    from: 'credit_approved',
    to: 'confirmed',
    trigger: 'Orchestrator confirms the order (the ORDRSP moment)',
    emits: 'order.confirmed.v1',
  },
  {
    from: 'confirmed',
    to: 'despatched',
    trigger: 'order.despatched.v1 observed by the orchestrator',
    emits: null,
  },
  {
    from: 'despatched',
    to: 'invoiced',
    trigger: 'invoice.issued.v1 observed by the orchestrator',
    emits: null,
  },
  {
    from: 'invoiced',
    to: 'paid',
    trigger: 'payment.received.v1 observed by the orchestrator',
    emits: null,
  },
  {
    from: 'paid',
    to: 'completed',
    trigger: 'credit.released.v1 observed by the orchestrator — the saga closes',
    emits: 'order.completed.v1',
  },
  {
    from: 'placed',
    to: 'cancelled',
    trigger:
      'stock.rejected.v1 (reason stock_rejected) or operator cancellation (reason operator_cancelled)',
    emits: 'order.cancelled.v1',
  },
  {
    from: 'stock_reserved',
    to: 'cancelled',
    trigger:
      'stock.released.v1 completing the credit-rejection compensation (reason credit_rejected) or operator cancellation',
    emits: 'order.cancelled.v1',
  },
  {
    from: 'credit_approved',
    to: 'cancelled',
    trigger: 'Operator cancellation (reason operator_cancelled)',
    emits: 'order.cancelled.v1',
  },
  {
    from: 'confirmed',
    to: 'cancelled',
    trigger: 'Operator cancellation (reason operator_cancelled)',
    emits: 'order.cancelled.v1',
  },
];

// Built once at module load — `Map<from, Map<to, OrderTransition>>`, keyed
// on the string `from` (using the sentinel below for the creation row so a
// single Map type covers both).
const CREATION_SENTINEL = '\0creation\0';

function fromKey(from: OrderStatus | null): string {
  return from ?? CREATION_SENTINEL;
}

const TRANSITIONS_BY_FROM: ReadonlyMap<string, ReadonlyMap<OrderStatus, OrderTransition>> = (() => {
  const byFrom = new Map<string, Map<OrderStatus, OrderTransition>>();
  for (const transition of ORDER_TRANSITIONS) {
    const key = fromKey(transition.from);
    const byTo = byFrom.get(key) ?? new Map<OrderStatus, OrderTransition>();
    byTo.set(transition.to, transition);
    byFrom.set(key, byTo);
  }
  return byFrom;
})();

/**
 * Looks up the T-1 row for `(from, to)` among the 11 non-creation edges, or
 * `undefined` if that pair is not a legal edge — the lookup `Order.transitionTo`
 * funnels every command method through (design.md §5). `from` is always a
 * real status here: creation (Table T-1 row 1, `from: null`) is not a
 * transition of an existing aggregate and is looked up separately by
 * `Order.place` via {@link CREATION_TRANSITION}.
 */
export function findTransition(from: OrderStatus, to: OrderStatus): OrderTransition | undefined {
  return TRANSITIONS_BY_FROM.get(fromKey(from))?.get(to);
}

/** Table T-1 row 1 — `(none) → placed` — looked up once by `Order.place`. */
export const CREATION_TRANSITION: OrderTransition = (() => {
  const transition = TRANSITIONS_BY_FROM.get(CREATION_SENTINEL)?.get('placed');
  if (!transition) {
    throw new Error('order-transitions: Table T-1 is missing its creation row (none) -> placed');
  }
  return transition;
})();
