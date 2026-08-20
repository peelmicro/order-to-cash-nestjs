// R10, OA4 — the closed reason set, immutability of the reason once set,
// the fact carrying it, and the reason <-> status pairing Table T-1 implies.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { CancellationReason } from './order-cancellation-reason.js';
import {
  CancellationReasonNotApplicableError,
  CancellationReasonRequiredError,
  InvalidCancellationReasonError,
} from './order-errors.js';
import { Order, type PlaceOrderInput, type TransitionContext } from './order.js';
import type { OrderStatus } from './order-status.js';

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

function driveTo(status: OrderStatus): Order {
  const order = Order.place(placeInput(), ctx());
  if (status === 'placed') return order;
  order.markStockReserved(ctx());
  if (status === 'stock_reserved') return order;
  order.approveCredit(ctx());
  if (status === 'credit_approved') return order;
  order.confirm(ctx());
  if (status === 'confirmed') return order;
  throw new Error(`order-cancellation.spec: driveTo does not support ${status}`);
}

describe('Order.cancel — R10', () => {
  // The exact case name specs/shared/test-matrix.md §1 names for R10.
  // Comprehensive: missing reason, out-of-set reason, immutability once
  // set, and the reason carried on order.cancelled.v1.
  it('requires a reason from the closed set, records it immutably and carries it on order.cancelled.v1', () => {
    expect(() => driveTo('placed').cancel(undefined as unknown as CancellationReason, ctx())).toThrow(
      CancellationReasonRequiredError,
    );
    expect(() =>
      driveTo('placed').cancel('buyer_remorse' as unknown as CancellationReason, ctx()),
    ).toThrow(InvalidCancellationReasonError);

    const order = driveTo('placed');
    order.cancel('stock_rejected', ctx());
    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('stock_rejected');
    expect(() => order.cancel('stock_rejected', ctx())).toThrow();
    expect(order.cancellationReason).toBe('stock_rejected');

    const events = order.pullDomainEvents();
    const cancelledEvent = events.find((e) => e.eventType === 'order.cancelled.v1');
    expect(cancelledEvent).toBeDefined();
    expect((cancelledEvent!.payload as { cancellationReason: string }).cancellationReason).toBe(
      'stock_rejected',
    );
  });

  it('raises CancellationReasonRequiredError when reason is undefined', () => {
    const order = driveTo('placed');
    expect(() => order.cancel(undefined as unknown as CancellationReason, ctx())).toThrow(
      CancellationReasonRequiredError,
    );
  });

  it('raises InvalidCancellationReasonError when reason is outside the closed set', () => {
    const order = driveTo('placed');
    expect(() => order.cancel('buyer_remorse' as unknown as CancellationReason, ctx())).toThrow(
      InvalidCancellationReasonError,
    );
  });

  it('records the reason on the order once cancelled, and it is thereafter immutable (cancelled is terminal — no second cancel can run)', () => {
    const order = driveTo('placed');
    order.cancel('operator_cancelled', ctx());

    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('operator_cancelled');
    expect(() => order.cancel('operator_cancelled', ctx())).toThrow();
    expect(order.cancellationReason).toBe('operator_cancelled');
  });

  it('carries the reason on the resulting order.cancelled.v1 fact', () => {
    const order = driveTo('placed');
    order.cancel('stock_rejected', ctx());

    const events = order.pullDomainEvents();
    const cancelledEvent = events.find((e) => e.eventType === 'order.cancelled.v1');
    expect(cancelledEvent).toBeDefined();
    expect((cancelledEvent!.payload as { cancellationReason: string }).cancellationReason).toBe(
      'stock_rejected',
    );
  });

  it('cancellationReason is undefined on a non-cancelled order', () => {
    const order = driveTo('placed');
    expect(order.cancellationReason).toBeUndefined();
  });
});

describe('Order.cancel — OA4', () => {
  // The exact case name specs/shared/test-matrix.md §1 / requirements.md §3
  // names for OA4. Comprehensive: both mispaired cases (stock_rejected from
  // stock_reserved, credit_rejected from placed) plus the positive pairing
  // cases, asserting nothing changes and no event is appended on rejection.
  it('refuses a cancellation reason that Table T-1 does not pair with the current status and changes nothing', () => {
    const fromStockReserved = driveTo('stock_reserved');
    const statusBefore1 = fromStockReserved.status;
    fromStockReserved.pullDomainEvents();
    expect(() => fromStockReserved.cancel('stock_rejected', ctx())).toThrow(
      CancellationReasonNotApplicableError,
    );
    expect(fromStockReserved.status).toBe(statusBefore1);
    expect(fromStockReserved.cancellationReason).toBeUndefined();
    expect(fromStockReserved.pullDomainEvents()).toHaveLength(0);

    const fromPlaced = driveTo('placed');
    const statusBefore2 = fromPlaced.status;
    fromPlaced.pullDomainEvents();
    expect(() => fromPlaced.cancel('credit_rejected', ctx())).toThrow(
      CancellationReasonNotApplicableError,
    );
    expect(fromPlaced.status).toBe(statusBefore2);
    expect(fromPlaced.cancellationReason).toBeUndefined();
    expect(fromPlaced.pullDomainEvents()).toHaveLength(0);

    const stockRejectedOk = driveTo('placed');
    stockRejectedOk.cancel('stock_rejected', ctx());
    expect(stockRejectedOk.status).toBe('cancelled');

    const creditRejectedOk = driveTo('stock_reserved');
    creditRejectedOk.cancel('credit_rejected', ctx());
    expect(creditRejectedOk.status).toBe('cancelled');

    for (const status of ['placed', 'stock_reserved', 'credit_approved', 'confirmed'] as const) {
      const order = driveTo(status);
      order.cancel('operator_cancelled', ctx());
      expect(order.status).toBe('cancelled');
    }
  });

  it('stock_rejected is legal from placed', () => {
    const order = driveTo('placed');
    order.cancel('stock_rejected', ctx());
    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('stock_rejected');
  });

  it('stock_rejected from stock_reserved is refused with CancellationReasonNotApplicableError and changes nothing', () => {
    const order = driveTo('stock_reserved');
    const statusBefore = order.status;

    expect(() => order.cancel('stock_rejected', ctx())).toThrow(CancellationReasonNotApplicableError);

    expect(order.status).toBe(statusBefore);
    expect(order.cancellationReason).toBeUndefined();
  });

  it('credit_rejected is legal from stock_reserved', () => {
    const order = driveTo('stock_reserved');
    order.cancel('credit_rejected', ctx());
    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('credit_rejected');
  });

  it('credit_rejected from placed is refused with CancellationReasonNotApplicableError and changes nothing', () => {
    const order = driveTo('placed');
    const statusBefore = order.status;

    expect(() => order.cancel('credit_rejected', ctx())).toThrow(CancellationReasonNotApplicableError);

    expect(order.status).toBe(statusBefore);
    expect(order.cancellationReason).toBeUndefined();
  });

  it.each<OrderStatus>(['placed', 'stock_reserved', 'credit_approved', 'confirmed'])(
    'operator_cancelled is legal from %s',
    (status) => {
      const order = driveTo(status);
      order.cancel('operator_cancelled', ctx());
      expect(order.status).toBe('cancelled');
      expect(order.cancellationReason).toBe('operator_cancelled');
    },
  );

  it('the error identifies the order, the status and the rejected reason', () => {
    const order = driveTo('stock_reserved');

    try {
      order.cancel('stock_rejected', ctx());
      expect.fail('expected cancel to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CancellationReasonNotApplicableError);
      const notApplicable = error as CancellationReasonNotApplicableError;
      expect(notApplicable.orderId.equals(order.id)).toBe(true);
      expect(notApplicable.status).toBe('stock_reserved');
      expect(notApplicable.reason).toBe('stock_rejected');
    }
  });

  it('appends no event when the cancellation reason is not applicable', () => {
    const order = driveTo('placed');
    order.pullDomainEvents();

    expect(() => order.cancel('credit_rejected', ctx())).toThrow(CancellationReasonNotApplicableError);

    expect(order.pullDomainEvents()).toHaveLength(0);
  });
});
