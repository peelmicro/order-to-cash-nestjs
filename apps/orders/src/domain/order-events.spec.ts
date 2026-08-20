// OA2 — exactly one fact on the four Table T-1 edges that name one, none on
// the five internal edges. Plus envelope-field assertions (correlationId =
// order id, causationId, occurredAt) that support R11/R12 without
// duplicating their own integration-level rows.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { Order, type PlaceOrderInput, type TransitionContext } from './order.js';

const BUYER_GLN = GLN.of('5412345000013');
const SUPPLIER_GLN = GLN.of('5412345000037');

function ctx(causationId: UniqueId = UniqueId.generate(), occurredAt = new Date('2026-08-20T10:00:00.000Z')): TransitionContext {
  return { occurredAt, causationId };
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

describe('Order — OA2', () => {
  // The exact case name specs/shared/test-matrix.md §1 / requirements.md §3
  // names for OA2. Comprehensive: walks all nine non-creation edges plus
  // creation itself, asserting exactly one fact on the four edges Table T-1
  // names one for and none on the other five.
  it('emits exactly one fact on the four Table T-1 edges that name one and no fact at all on the five internal edges', () => {
    const order = Order.place(placeInput(), ctx());
    expect(order.pullDomainEvents().map((e) => e.eventType)).toEqual(['order.placed.v1']);

    order.markStockReserved(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);

    order.approveCredit(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);

    order.confirm(ctx());
    expect(order.pullDomainEvents().map((e) => e.eventType)).toEqual(['order.confirmed.v1']);

    order.markDespatched(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);

    order.markInvoiced(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);

    order.markPaid(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);

    order.complete(ctx());
    expect(order.pullDomainEvents().map((e) => e.eventType)).toEqual(['order.completed.v1']);

    const cancelledOrder = Order.place(placeInput(), ctx());
    cancelledOrder.pullDomainEvents();
    cancelledOrder.cancel('operator_cancelled', ctx());
    expect(cancelledOrder.pullDomainEvents().map((e) => e.eventType)).toEqual(['order.cancelled.v1']);
  });

  it('order.placed.v1 — Order.place appends exactly one event', () => {
    const order = Order.place(placeInput(), ctx());
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('order.placed.v1');
  });

  it('placed -> stock_reserved (internal edge) appends no event', () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    order.markStockReserved(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);
  });

  it('stock_reserved -> credit_approved (internal edge) appends no event', () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.pullDomainEvents();
    order.approveCredit(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);
  });

  it('credit_approved -> confirmed appends exactly one order.confirmed.v1', () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.pullDomainEvents();
    order.confirm(ctx());
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('order.confirmed.v1');
  });

  it('confirmed -> despatched (internal edge) appends no event', () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.confirm(ctx());
    order.pullDomainEvents();
    order.markDespatched(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);
  });

  it('despatched -> invoiced (internal edge) appends no event', () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.confirm(ctx());
    order.markDespatched(ctx());
    order.pullDomainEvents();
    order.markInvoiced(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);
  });

  it('invoiced -> paid (internal edge) appends no event', () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.confirm(ctx());
    order.markDespatched(ctx());
    order.markInvoiced(ctx());
    order.pullDomainEvents();
    order.markPaid(ctx());
    expect(order.pullDomainEvents()).toHaveLength(0);
  });

  it('paid -> completed appends exactly one order.completed.v1', () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.confirm(ctx());
    order.markDespatched(ctx());
    order.markInvoiced(ctx());
    order.markPaid(ctx());
    order.pullDomainEvents();
    order.complete(ctx());
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('order.completed.v1');
  });

  it('any cancelling edge appends exactly one order.cancelled.v1', () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    order.cancel('operator_cancelled', ctx());
    const events = order.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('order.cancelled.v1');
  });
});

describe('Order — fact envelope: correlationId = order id, causationId and occurredAt from the TransitionContext', () => {
  it('order.placed.v1 has every envelope field present, aggregateId = correlationId = order.id, and eventType matching <aggregate>.<fact>.v<n>', () => {
    const causationId = UniqueId.generate();
    const occurredAt = new Date('2026-08-20T11:22:33.000Z');
    const order = Order.place(placeInput(), ctx(causationId, occurredAt));

    const [event] = order.pullDomainEvents();

    expect(event.eventId).toBeDefined();
    expect(event.eventType).toMatch(/^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*\.v[1-9][0-9]*$/);
    expect(event.eventType).toBe('order.placed.v1');
    expect(event.aggregateId.equals(order.id)).toBe(true);
    expect(event.correlationId.equals(order.id)).toBe(true);
    expect(event.causationId.equals(causationId)).toBe(true);
    expect(event.occurredAt).toEqual(occurredAt);
    expect(event.payload).toBeDefined();
  });

  it('order.confirmed.v1 correlationId is the order id, not the causing fact\'s aggregate', () => {
    const order = Order.place(placeInput(), ctx());
    order.markStockReserved(ctx());
    order.approveCredit(ctx());
    order.pullDomainEvents();

    const causationId = UniqueId.generate();
    const occurredAt = new Date('2026-08-20T12:00:00.000Z');
    order.confirm(ctx(causationId, occurredAt));

    const [event] = order.pullDomainEvents();
    expect(event.correlationId.equals(order.id)).toBe(true);
    expect(event.aggregateId.equals(order.id)).toBe(true);
    expect(event.causationId.equals(causationId)).toBe(true);
    expect(event.occurredAt).toEqual(occurredAt);
  });

  it('order.cancelled.v1 carries the compensationSteps supplied by the caller, empty by default', () => {
    const order = Order.place(placeInput(), ctx());
    order.pullDomainEvents();
    order.cancel('operator_cancelled', ctx());

    const [event] = order.pullDomainEvents();
    expect((event.payload as { compensationSteps: unknown[] }).compensationSteps).toEqual([]);
  });
});
