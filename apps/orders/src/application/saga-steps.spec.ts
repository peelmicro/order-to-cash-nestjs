// The full step table (design.md §4.1): every fact x every one of the 9
// statuses. Pure domain-level tests — real `Order` instances built via
// `driveTo`, no store, no broker, no framework (SO2 row included).
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { CompensationStep, Envelope } from '@otc/contracts';
import { describe, expect, it } from 'vitest';
import { Order, type PlaceOrderInput, type PlaceOrderLineInput } from '../domain/order.js';
import { OrderTransitionNotAllowedError } from '../domain/order-errors.js';
import { ORDER_STATUSES, type OrderStatus } from '../domain/order-status.js';
import { mapReason, SAGA_STEPS, stepFor, stepsFrom, transitionContextFrom, type SagaStep } from './saga-steps.js';

const BUYER_GLN = GLN.of('5412345000013');
const SUPPLIER_GLN = GLN.of('5412345000037');

function placeInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  const line: PlaceOrderLineInput = {
    productCode: 'PRD-0001',
    description: 'Widget',
    quantity: Quantity.of(2),
    unitPrice: Money.of(1_000, 'EUR'),
    lineDiscount: Money.of(0, 'EUR'),
  };
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(1),
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    buyer: { gln: BUYER_GLN, code: 'RET-0001' },
    supplier: { gln: SUPPLIER_GLN, code: 'COM-0001' },
    currency: 'EUR',
    lines: [line],
    ...overrides,
  };
}

function ctx() {
  return { occurredAt: new Date('2026-08-20T10:00:00.000Z'), causationId: UniqueId.generate() };
}

/** Drives a freshly-placed order to `status` via the SAME legal edges the real saga uses — the fixture for "an order currently in status X". */
function driveTo(status: OrderStatus): Order {
  const order = Order.place(placeInput(), ctx());
  if (status === 'placed') return order;
  order.markStockReserved(ctx());
  if (status === 'stock_reserved') return order;
  order.approveCredit(ctx());
  if (status === 'credit_approved') return order;
  order.confirm(ctx());
  if (status === 'confirmed') return order;
  order.markDespatched(ctx());
  if (status === 'despatched') return order;
  order.markInvoiced(ctx());
  if (status === 'invoiced') return order;
  order.markPaid(ctx());
  if (status === 'paid') return order;
  order.complete(ctx());
  if (status === 'completed') return order;
  if (status === 'cancelled') {
    const cancelling = Order.place(placeInput(), ctx());
    cancelling.cancel('stock_rejected', ctx());
    return cancelling;
  }
  throw new Error(`saga-steps.spec: driveTo does not support ${status}`);
}

function fact(overrides: Partial<Envelope> = {}): Envelope {
  return {
    eventId: UniqueId.generate().value,
    eventType: 'test.fact.v1',
    aggregateId: UniqueId.generate().value,
    correlationId: UniqueId.generate().value,
    causationId: UniqueId.generate().value,
    occurredAt: '2026-08-20T10:00:00.000Z',
    payload: {},
    ...overrides,
  };
}

/** Applies `step` to `order` exactly the way `SagaFactHandler` would, given a matching precondition — used only inside the "at its own precondition" branch of each fact's test. */
function apply(step: SagaStep, order: Order, envelope: Envelope): void {
  if (step.kind === 'advance') {
    step.apply(order, transitionContextFrom(envelope), envelope);
  } else if (step.kind === 'cancel') {
    order.cancel(step.reason(envelope), transitionContextFrom(envelope), step.compensationSteps(envelope));
  } else {
    throw new Error('saga-steps.spec: apply() called on a skip step');
  }
}

const NON_SKIP_FACT_TYPES = Object.entries(SAGA_STEPS)
  .filter(([, step]) => step.kind !== 'skip')
  .map(([eventType]) => eventType);

describe('SAGA_STEPS — the step table, every fact x every status (design.md §4.1)', () => {
  describe.each(NON_SKIP_FACT_TYPES)('%s', (eventType) => {
    const step = stepFor(eventType);
    if (!step || step.kind === 'skip') {
      throw new Error('unreachable');
    }

    it.each(ORDER_STATUSES)('status %s', (status) => {
      const order = driveTo(status);
      const envelope = fact({
        eventType,
        correlationId: order.id.value,
        payload: eventType === 'stock.released.v1' ? { reason: 'credit_rejected' } : {},
      });

      if (status === step.precondition) {
        // The one status this fact legally advances/cancels from.
        expect(() => apply(step, order, envelope)).not.toThrow();
        return;
      }

      // Every OTHER status: R25's precondition-mismatch case. `order.placed.v1`
      // and `credit.rejected.v1`'s `apply` are documented no-ops (R19, R27) so
      // they can never throw regardless of status; every other fact drives a
      // real aggregate transition, which the domain's own state machine
      // (order-transitions.ts) refuses from the wrong status — defense in
      // depth, and proof the step table's `precondition` values are exactly
      // the domain's legal-edge sources. A `cancel`-kind step can be refused
      // for either of two domain reasons: no edge to `cancelled` exists at
      // all (`OrderTransitionNotAllowedError`), or an edge exists but this
      // reason is not the one Table T-1 pairs with it (OA4,
      // `CancellationReasonNotApplicableError`) — both are the aggregate
      // correctly refusing the wrong-precondition mutation.
      if (eventType === 'order.placed.v1' || eventType === 'credit.rejected.v1') {
        const statusBefore = order.status;
        expect(() => apply(step, order, envelope)).not.toThrow();
        expect(order.status).toBe(statusBefore);
      } else if (step.kind === 'cancel') {
        expect(() => apply(step, order, envelope)).toThrow();
      } else {
        expect(() => apply(step, order, envelope)).toThrow(OrderTransitionNotAllowedError);
      }
    });
  });
});

describe('order.placed.v1 — R19: status unchanged, stock.reserve owed', () => {
  it('owes stock.reserve and leaves status/aggregate state untouched', () => {
    const step = stepFor('order.placed.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect(step.precondition).toBe('placed');
    expect(step.commandAfter).toBe('stock.reserve');

    const order = driveTo('placed');
    apply(step, order, fact({ eventType: 'order.placed.v1', correlationId: order.id.value }));
    expect(order.status).toBe('placed');
  });
});

describe('stock.reserved.v1 — advances to stock_reserved, owes credit.hold', () => {
  it('transitions placed -> stock_reserved and owes credit.hold', () => {
    const step = stepFor('stock.reserved.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect(step.commandAfter).toBe('credit.hold');

    const order = driveTo('placed');
    apply(step, order, fact({ eventType: 'stock.reserved.v1', correlationId: order.id.value }));
    expect(order.status).toBe('stock_reserved');
  });
});

describe('stock.rejected.v1 — R26: compensation path A, cancels with [] and owes nothing', () => {
  it('cancels from placed with reason stock_rejected and an empty compensationSteps array', () => {
    const step = stepFor('stock.rejected.v1');
    if (!step || step.kind !== 'cancel') throw new Error('unreachable');
    expect(step.precondition).toBe('placed');
    expect('commandAfter' in step).toBe(false);

    const envelope = fact({ eventType: 'stock.rejected.v1' });
    expect(step.reason(envelope)).toBe('stock_rejected');
    expect(step.compensationSteps(envelope)).toEqual([]);

    const order = driveTo('placed');
    apply(step, order, { ...envelope, correlationId: order.id.value });
    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('stock_rejected');
  });
});

describe('credit.approved.v1 — R21: performs both edges, exactly one order.confirmed.v1', () => {
  it('applies approveCredit then confirm on one load/save, owes despatch.create', () => {
    const step = stepFor('credit.approved.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect(step.precondition).toBe('stock_reserved');
    expect(step.commandAfter).toBe('despatch.create');

    const order = driveTo('stock_reserved');
    apply(step, order, fact({ eventType: 'credit.approved.v1', correlationId: order.id.value }));

    expect(order.status).toBe('confirmed');
    const events = order.pullDomainEvents();
    const confirmedEvents = events.filter((event) => event.eventType === 'order.confirmed.v1');
    expect(confirmedEvents).toHaveLength(1);
  });
});

describe('credit.rejected.v1 — R27: status unchanged, owes stock.release', () => {
  it('leaves stock_reserved unchanged and owes stock.release', () => {
    const step = stepFor('credit.rejected.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect(step.precondition).toBe('stock_reserved');
    expect(step.commandAfter).toBe('stock.release');

    const order = driveTo('stock_reserved');
    apply(step, order, fact({ eventType: 'credit.rejected.v1', correlationId: order.id.value }));
    expect(order.status).toBe('stock_reserved');
  });
});

describe('stock.released.v1 — R28, SO7: compensation path B, one stock_released step from the observed fact', () => {
  it('cancels stock_reserved with reason credit_rejected and one compensation step built from the fact', () => {
    const step = stepFor('stock.released.v1');
    if (!step || step.kind !== 'cancel') throw new Error('unreachable');
    expect(step.precondition).toBe('stock_reserved');

    const envelope = fact({
      eventType: 'stock.released.v1',
      eventId: 'e5f6a1b2-0000-4000-8000-000000000001',
      payload: { reason: 'credit_rejected' },
    });

    expect(step.reason(envelope)).toBe('credit_rejected');
    const steps: readonly CompensationStep[] = step.compensationSteps(envelope);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      step: 'stock_released',
      eventId: envelope.eventId,
      eventType: 'stock.released.v1',
      occurredAt: envelope.occurredAt,
    });

    const order = driveTo('stock_reserved');
    apply(step, order, { ...envelope, correlationId: order.id.value });
    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('credit_rejected');
  });

  it('maps order_cancelled to operator_cancelled (SO7 — the operator-initiated release path)', () => {
    expect(mapReason('order_cancelled')).toBe('operator_cancelled');
    expect(mapReason('credit_rejected')).toBe('credit_rejected');
  });

  it('throws on an unmapped reason — the closed set has exactly two members', () => {
    // @ts-expect-error — deliberately an invalid reason to exercise the exhaustiveness guard.
    expect(() => mapReason('something_else')).toThrow();
  });

  it('stepsFrom builds exactly one stock_released compensation step carrying the observed fact identity', () => {
    const envelope = fact({ eventType: 'stock.released.v1', payload: { reason: 'order_cancelled' } });
    const steps = stepsFrom(envelope);
    expect(steps).toEqual([
      expect.objectContaining({
        step: 'stock_released',
        eventId: envelope.eventId,
        eventType: 'stock.released.v1',
        occurredAt: envelope.occurredAt,
      }),
    ]);
  });
});

describe('order.despatched.v1 — advances to despatched, owes invoice.issue', () => {
  it('transitions confirmed -> despatched and owes invoice.issue', () => {
    const step = stepFor('order.despatched.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect(step.commandAfter).toBe('invoice.issue');

    const order = driveTo('confirmed');
    apply(step, order, fact({ eventType: 'order.despatched.v1', correlationId: order.id.value }));
    expect(order.status).toBe('despatched');
  });
});

describe('invoice.issued.v1 — R23: advances to invoiced, owes nothing (waits for the outside world)', () => {
  it('transitions despatched -> invoiced with no commandAfter', () => {
    const step = stepFor('invoice.issued.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect('commandAfter' in step).toBe(false);

    const order = driveTo('despatched');
    apply(step, order, fact({ eventType: 'invoice.issued.v1', correlationId: order.id.value }));
    expect(order.status).toBe('invoiced');
  });
});

describe('payment.received.v1 — advances to paid, owes nothing', () => {
  it('transitions invoiced -> paid', () => {
    const step = stepFor('payment.received.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect('commandAfter' in step).toBe(false);

    const order = driveTo('invoiced');
    apply(step, order, fact({ eventType: 'payment.received.v1', correlationId: order.id.value }));
    expect(order.status).toBe('paid');
  });
});

describe('credit.released.v1 — R24: closes the saga, emits order.completed.v1', () => {
  it('transitions paid -> completed and emits exactly one order.completed.v1', () => {
    const step = stepFor('credit.released.v1');
    if (!step || step.kind !== 'advance') throw new Error('unreachable');
    expect('commandAfter' in step).toBe(false);

    const order = driveTo('paid');
    apply(step, order, fact({ eventType: 'credit.released.v1', correlationId: order.id.value }));
    expect(order.status).toBe('completed');
    const completedEvents = order.pullDomainEvents().filter((event) => event.eventType === 'order.completed.v1');
    expect(completedEvents).toHaveLength(1);
  });
});

describe('SO2 — the three self-produced facts map to skip', () => {
  it.each(['order.confirmed.v1', 'order.completed.v1', 'order.cancelled.v1'])(
    'maps %s to a skip step — the caller performs no I/O, no transaction, no dedup record for it',
    (eventType) => {
      expect(stepFor(eventType)).toEqual({ kind: 'skip' });
    },
  );

  it('has no entry for an event type this service never sees', () => {
    expect(stepFor('unknown.fact.v1')).toBeUndefined();
  });
});

describe('the table is exhaustive — 13 fact types, matching saga.md', () => {
  it('declares exactly the ten consumed facts plus the three self-produced skip facts', () => {
    expect(Object.keys(SAGA_STEPS).sort()).toEqual(
      [
        'order.placed.v1',
        'stock.reserved.v1',
        'stock.rejected.v1',
        'credit.approved.v1',
        'credit.rejected.v1',
        'stock.released.v1',
        'order.despatched.v1',
        'invoice.issued.v1',
        'payment.received.v1',
        'credit.released.v1',
        'order.confirmed.v1',
        'order.completed.v1',
        'order.cancelled.v1',
      ].sort(),
    );
  });
});
