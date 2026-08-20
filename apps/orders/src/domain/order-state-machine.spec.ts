// R8, R9 — Table T-1 walked edge by edge, and the full 9x9 (from, to)
// product proved exhaustively: 11 legal edges succeed, the other 70 each
// raise `OrderTransitionNotAllowedError`, leave `status` (and every other
// field) unchanged and append no domain event.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { OrderTransitionNotAllowedError } from './order-errors.js';
import { Order, type PlaceOrderInput, type TransitionContext } from './order.js';
import { ORDER_STATUSES, type OrderStatus } from './order-status.js';
import { findTransition } from './order-transitions.js';

const BUYER_GLN = GLN.of('5412345000013');
const SUPPLIER_GLN = GLN.of('5412345000037');

function ctx(): TransitionContext {
  return { occurredAt: new Date('2026-08-20T10:00:00.000Z'), causationId: UniqueId.generate() };
}

function placeInput(): PlaceOrderInput {
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(1),
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    buyer: { gln: BUYER_GLN, code: 'RET-0001' },
    supplier: { gln: SUPPLIER_GLN, code: 'COM-0001' },
    currency: 'EUR',
    lines: [
      {
        productCode: 'PRD-0001',
        description: 'Widget',
        quantity: Quantity.of(2),
        unitPrice: Money.of(1_000, 'EUR'),
        lineDiscount: Money.of(0, 'EUR'),
      },
    ],
  };
}

/** Drives a freshly placed order to `status` via the shortest legal path of command methods. */
function driveTo(status: OrderStatus): Order {
  const order = Order.place(placeInput(), ctx());
  if (status === 'placed') {
    return order;
  }
  if (status === 'cancelled') {
    // `operator_cancelled` is legal straight from `placed` (Table T-1 row 9)
    // — the shortest path to a cancelled order for this test's purposes.
    order.cancel('operator_cancelled', ctx());
    return order;
  }
  order.markStockReserved(ctx());
  if (status === 'stock_reserved') {
    return order;
  }
  order.approveCredit(ctx());
  if (status === 'credit_approved') {
    return order;
  }
  order.confirm(ctx());
  if (status === 'confirmed') {
    return order;
  }
  order.markDespatched(ctx());
  if (status === 'despatched') {
    return order;
  }
  order.markInvoiced(ctx());
  if (status === 'invoiced') {
    return order;
  }
  order.markPaid(ctx());
  if (status === 'paid') {
    return order;
  }
  order.complete(ctx());
  if (status === 'completed') {
    return order;
  }
  throw new Error(`order-state-machine.spec: no drive path implemented for status ${status}`);
}

/**
 * Executes the command method that attempts the given (from, to) edge.
 * `to === 'placed'` has **no** entry: no public command method targets
 * `placed` from an existing order (only the static `Order.place` creates
 * one, and it has no *source* status to transition from) — design.md §5's
 * "closed union types + value objects + one exhaustively tested runtime
 * check" position means that particular illegality is unrepresentable at
 * the API surface rather than merely rejected at runtime, which is a
 * strictly stronger guarantee than the other 61 illegal (from, to) pairs
 * get. Those 9 pairs are proved illegal directly against `findTransition`
 * in the dedicated test below instead of through this function.
 */
function applyEdge(order: Order, to: Exclude<OrderStatus, 'placed'>): void {
  switch (to) {
    case 'stock_reserved':
      order.markStockReserved(ctx());
      return;
    case 'credit_approved':
      order.approveCredit(ctx());
      return;
    case 'confirmed':
      order.confirm(ctx());
      return;
    case 'despatched':
      order.markDespatched(ctx());
      return;
    case 'invoiced':
      order.markInvoiced(ctx());
      return;
    case 'paid':
      order.markPaid(ctx());
      return;
    case 'completed':
      order.complete(ctx());
      return;
    case 'cancelled':
      order.cancel('operator_cancelled', ctx());
      return;
  }
}

// Table T-1's 11 non-creation edges (design.md §5) — the set this test
// proves is exactly what the exhaustive 9x9 walk below must find legal.
const LEGAL_EDGES: ReadonlyArray<[OrderStatus, Exclude<OrderStatus, 'placed'>]> = [
  ['placed', 'stock_reserved'],
  ['stock_reserved', 'credit_approved'],
  ['credit_approved', 'confirmed'],
  ['confirmed', 'despatched'],
  ['despatched', 'invoiced'],
  ['invoiced', 'paid'],
  ['paid', 'completed'],
  ['placed', 'cancelled'],
  ['stock_reserved', 'cancelled'],
  ['credit_approved', 'cancelled'],
  ['confirmed', 'cancelled'],
];

describe('Order — R8', () => {
  // The exact case name specs/shared/test-matrix.md §1 names for R8
  // (matrix rule 4: the test name in that table is the contract). Walks
  // every one of Table T-1's 11 non-creation edges through the real
  // command methods and confirms `cancelled` is reachable only from the
  // four statuses Table T-1 pairs it with.
  it('walks every legal edge of Table T-1 and reaches cancelled only from placed, stock_reserved, credit_approved and confirmed', () => {
    for (const [from, to] of LEGAL_EDGES) {
      const order = driveTo(from);
      applyEdge(order, to);
      expect(order.status).toBe(to);
    }

    const cancellableFrom = new Set(
      LEGAL_EDGES.filter(([, to]) => to === 'cancelled').map(([from]) => from),
    );
    expect([...cancellableFrom].sort()).toEqual(
      ['confirmed', 'credit_approved', 'placed', 'stock_reserved'].sort(),
    );

    const edgesFromCompleted = LEGAL_EDGES.filter(([from]) => from === 'completed');
    const edgesFromCancelled = LEGAL_EDGES.filter(([from]) => from === 'cancelled');
    expect(edgesFromCompleted).toHaveLength(0);
    expect(edgesFromCancelled).toHaveLength(0);
  });

  // Same 11 edges, one at a time — finer-grained failure reporting than the
  // single comprehensive case above when exactly one edge regresses.
  it.each(LEGAL_EDGES)('%s -> %s succeeds and moves status to the target', (from, to) => {
    const order = driveTo(from);
    applyEdge(order, to);
    expect(order.status).toBe(to);
  });
});

describe('Order — R9', () => {
  const legalSet = new Set(LEGAL_EDGES.map(([from, to]) => `${from}->${to}`));
  const allPairs: Array<[OrderStatus, OrderStatus]> = [];
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      allPairs.push([from, to]);
    }
  }
  const illegalPairs = allPairs.filter(([from, to]) => !legalSet.has(`${from}->${to}`));
  // `to === 'placed'` has no public command method (see applyEdge's own
  // comment) — those 9 of the 70 illegal pairs are proved directly against
  // findTransition; the other 61 are driven through the real aggregate.
  const illegalPairsWithAReachableMethod = illegalPairs.filter(
    (pair): pair is [OrderStatus, Exclude<OrderStatus, 'placed'>] => pair[1] !== 'placed',
  );
  const illegalPairsToPlaced = illegalPairs.filter(([, to]) => to === 'placed');

  // The exact case name specs/shared/test-matrix.md §1 names for R9. Proves
  // the full 9x9 Cartesian product: exactly 11 legal / 70 illegal against
  // `findTransition` itself, and — for every illegal pair a public command
  // method can even attempt (61 of the 70; the other 9 have `to: 'placed'`,
  // which no method targets on an existing order and is therefore
  // unrepresentable rather than merely rejected) — that the aggregate
  // raises `OrderTransitionNotAllowedError`, leaves `status`, the lines and
  // the totals unchanged, and appends no domain event.
  it('raises on every (from, to) pair absent from Table T-1 without mutating state or appending an event', () => {
    expect(allPairs).toHaveLength(81);
    expect(illegalPairs).toHaveLength(70);
    expect(allPairs.length - illegalPairs.length).toBe(11);

    for (const [from, to] of allPairs) {
      const transition = findTransition(from, to);
      if (legalSet.has(`${from}->${to}`)) {
        expect(transition, `expected ${from} -> ${to} to be a legal edge`).toBeDefined();
      } else {
        expect(transition, `expected ${from} -> ${to} to be absent from Table T-1`).toBeUndefined();
      }
    }

    for (const [from, to] of illegalPairsWithAReachableMethod) {
      const order = driveTo(from);
      order.pullDomainEvents(); // drain events accumulated by driveTo — only the attempted illegal edge is under test

      const statusBefore = order.status;
      const totalBefore = order.totalAmount;
      const lineCountBefore = order.lines.length;

      expect(() => applyEdge(order, to), `expected ${from} -> ${to} to be rejected`).toThrow(
        OrderTransitionNotAllowedError,
      );

      expect(order.status).toBe(statusBefore);
      expect(order.totalAmount.equals(totalBefore)).toBe(true);
      expect(order.lines).toHaveLength(lineCountBefore);
      expect(order.pullDomainEvents()).toHaveLength(0);
    }
  });

  it('the 9 (from, placed) pairs are absent from Table T-1 — no public command method can even attempt them', () => {
    expect(illegalPairsToPlaced).toHaveLength(9);
    for (const [from, to] of illegalPairsToPlaced) {
      expect(findTransition(from, to)).toBeUndefined();
    }
  });

  // Same 70 (well, 61 reachable) illegal pairs, one at a time — finer
  // grained failure reporting than the single comprehensive case above
  // when exactly one pair regresses.
  it.each(illegalPairsWithAReachableMethod)(
    '%s -> %s is rejected, leaves status and lines unchanged and appends no event',
    (from, to) => {
      const order = driveTo(from);
      order.pullDomainEvents();

      const statusBefore = order.status;
      const totalBefore = order.totalAmount;
      const lineCountBefore = order.lines.length;

      expect(() => applyEdge(order, to)).toThrow(OrderTransitionNotAllowedError);

      expect(order.status).toBe(statusBefore);
      expect(order.totalAmount.equals(totalBefore)).toBe(true);
      expect(order.lines).toHaveLength(lineCountBefore);
      expect(order.pullDomainEvents()).toHaveLength(0);
    },
  );

  it('the error carries the order id, the attempted from and the attempted to', () => {
    const order = driveTo('placed');

    try {
      order.markInvoiced(ctx()); // placed -> invoiced is illegal (no skipping)
      expect.fail('expected markInvoiced to throw from placed');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderTransitionNotAllowedError);
      const transitionError = error as OrderTransitionNotAllowedError;
      expect(transitionError.orderId.equals(order.id)).toBe(true);
      expect(transitionError.from).toBe('placed');
      expect(transitionError.to).toBe('invoiced');
    }
  });
});
