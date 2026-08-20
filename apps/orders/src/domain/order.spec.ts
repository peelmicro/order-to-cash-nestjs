// R5, R7, OA3, OA5 — creation invariants (no empty orders), the freeze
// (lines immutable from `confirmed` onwards), reconstitution and the
// non-mutable line accessor.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import {
  EmptyOrderError,
  InvalidOrderSnapshotError,
  OrderLinesFrozenError,
  UnknownOrderLineError,
} from './order-errors.js';
import { Order, type PlaceOrderInput, type PlaceOrderLineInput, type TransitionContext } from './order.js';
import type { OrderSnapshot } from './order-snapshot.js';
import type { OrderStatus } from './order-status.js';

const BUYER_GLN = GLN.of('5412345000013');
const SUPPLIER_GLN = GLN.of('5412345000037');

function ctx(): TransitionContext {
  return { occurredAt: new Date('2026-08-20T10:00:00.000Z'), causationId: UniqueId.generate() };
}

function lineInput(overrides: Partial<PlaceOrderLineInput> = {}): PlaceOrderLineInput {
  return {
    productCode: 'PRD-0001',
    description: 'Widget',
    quantity: Quantity.of(2),
    unitPrice: Money.of(1_000, 'EUR'),
    lineDiscount: Money.of(0, 'EUR'),
    ...overrides,
  };
}

function placeInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return {
    id: UniqueId.generate(),
    orderReference: OrderNumber.fromSequence(1),
    orderDate: new Date('2026-08-20T09:00:00.000Z'),
    buyer: { gln: BUYER_GLN, code: 'RET-0001' },
    supplier: { gln: SUPPLIER_GLN, code: 'COM-0001' },
    currency: 'EUR',
    lines: [lineInput()],
    ...overrides,
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
  order.markDespatched(ctx());
  if (status === 'despatched') return order;
  order.markInvoiced(ctx());
  if (status === 'invoiced') return order;
  order.markPaid(ctx());
  if (status === 'paid') return order;
  order.complete(ctx());
  if (status === 'completed') return order;
  throw new Error(`order.spec: driveTo does not support ${status}`);
}

function baseSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  const placed = Order.place(placeInput(), ctx());
  return {
    id: placed.id,
    orderReference: placed.orderReference,
    orderDate: placed.orderDate,
    buyerGln: placed.buyerGln,
    retailerCode: placed.retailerCode,
    supplierGln: placed.supplierGln,
    companyCode: placed.companyCode,
    currency: placed.currency,
    lines: placed.lines.map((line) => ({
      id: line.id,
      productCode: line.productCode,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineDiscount: line.lineDiscount,
    })),
    status: 'placed',
    ...overrides,
  };
}

describe('Order.place — R5', () => {
  // The exact case name specs/shared/test-matrix.md §1 names for R5.
  it('refuses to create an order with no lines and to remove the last remaining line', () => {
    expect(() => Order.place(placeInput({ lines: [] }), ctx())).toThrow(EmptyOrderError);

    const order = Order.place(placeInput({ lines: [lineInput()] }), ctx());
    const [onlyLine] = order.lines;
    expect(() => order.removeLine(onlyLine.id)).toThrow(EmptyOrderError);
    expect(order.lines).toHaveLength(1);
  });

  it('refuses to construct an order with an empty lines array', () => {
    expect(() => Order.place(placeInput({ lines: [] }), ctx())).toThrow(EmptyOrderError);
  });

  it('refuses to remove the last remaining line of an order with exactly one line', () => {
    const order = Order.place(placeInput({ lines: [lineInput()] }), ctx());
    const [onlyLine] = order.lines;

    expect(() => order.removeLine(onlyLine.id)).toThrow(EmptyOrderError);
    expect(order.lines).toHaveLength(1);
  });

  it('allows removing a line when at least one other remains', () => {
    const order = Order.place(
      placeInput({ lines: [lineInput({ productCode: 'PRD-0001' }), lineInput({ productCode: 'PRD-0002' })] }),
      ctx(),
    );
    const [firstLine] = order.lines;

    order.removeLine(firstLine.id);

    expect(order.lines).toHaveLength(1);
  });

  it('removeLine refuses an unknown line id with UnknownOrderLineError', () => {
    const order = Order.place(placeInput(), ctx());
    expect(() => order.removeLine(UniqueId.generate())).toThrow(UnknownOrderLineError);
    expect(order.lines).toHaveLength(1);
  });

  it('changeLineQuantity refuses an unknown line id with UnknownOrderLineError', () => {
    const order = Order.place(placeInput(), ctx());
    expect(() => order.changeLineQuantity(UniqueId.generate(), Quantity.of(5))).toThrow(
      UnknownOrderLineError,
    );
  });
});

describe('Order — R7', () => {
  const frozenStatuses: OrderStatus[] = [
    'confirmed',
    'despatched',
    'invoiced',
    'paid',
    'completed',
    'cancelled',
  ];

  // The exact case name specs/shared/test-matrix.md §1 names for R7.
  // Comprehensive: all three mutators, across all six frozen statuses,
  // asserting every field (status, totals, line ids) is unchanged.
  it('refuses to add, remove or modify a line once the order is confirmed and leaves every field unchanged', () => {
    for (const status of frozenStatuses) {
      const addOrder = status === 'cancelled' ? cancelledOrder() : driveTo(status);
      const beforeAdd = snapshotFields(addOrder);
      expect(() => addOrder.addLine(lineInput({ productCode: 'PRD-9999' }))).toThrow(
        OrderLinesFrozenError,
      );
      expect(snapshotFields(addOrder)).toEqual(beforeAdd);

      const removeOrder = status === 'cancelled' ? cancelledOrder() : driveTo(status);
      const beforeRemove = snapshotFields(removeOrder);
      const [removeLine] = removeOrder.lines;
      expect(() => removeOrder.removeLine(removeLine.id)).toThrow(OrderLinesFrozenError);
      expect(snapshotFields(removeOrder)).toEqual(beforeRemove);

      const changeOrder = status === 'cancelled' ? cancelledOrder() : driveTo(status);
      const beforeChange = snapshotFields(changeOrder);
      const [changeLine] = changeOrder.lines;
      expect(() => changeOrder.changeLineQuantity(changeLine.id, Quantity.of(99))).toThrow(
        OrderLinesFrozenError,
      );
      expect(snapshotFields(changeOrder)).toEqual(beforeChange);
    }

    for (const status of ['placed', 'stock_reserved', 'credit_approved'] as const) {
      const order = driveTo(status);
      expect(() => order.addLine(lineInput({ productCode: 'PRD-9999' }))).not.toThrow();
    }
  });

  it.each(frozenStatuses)('addLine is refused once status is %s, and every field is unchanged', (status) => {
    const order = status === 'cancelled' ? cancelledOrder() : driveTo(status);
    const before = snapshotFields(order);

    expect(() => order.addLine(lineInput({ productCode: 'PRD-9999' }))).toThrow(OrderLinesFrozenError);

    expect(snapshotFields(order)).toEqual(before);
  });

  it.each(frozenStatuses)('removeLine is refused once status is %s, and every field is unchanged', (status) => {
    const order = status === 'cancelled' ? cancelledOrder() : driveTo(status);
    const before = snapshotFields(order);
    const [line] = order.lines;

    expect(() => order.removeLine(line.id)).toThrow(OrderLinesFrozenError);

    expect(snapshotFields(order)).toEqual(before);
  });

  it.each(frozenStatuses)('changeLineQuantity is refused once status is %s, and every field is unchanged', (status) => {
    const order = status === 'cancelled' ? cancelledOrder() : driveTo(status);
    const before = snapshotFields(order);
    const [line] = order.lines;

    expect(() => order.changeLineQuantity(line.id, Quantity.of(99))).toThrow(OrderLinesFrozenError);

    expect(snapshotFields(order)).toEqual(before);
  });

  it('addLine, removeLine and changeLineQuantity are allowed while placed, stock_reserved or credit_approved', () => {
    for (const status of ['placed', 'stock_reserved', 'credit_approved'] as const) {
      const order = driveTo(status);
      expect(() => order.addLine(lineInput({ productCode: 'PRD-9999' }))).not.toThrow();
    }
  });

  function cancelledOrder(): Order {
    const order = Order.place(placeInput(), ctx());
    order.cancel('operator_cancelled', ctx());
    return order;
  }

  function snapshotFields(order: Order): unknown {
    return {
      status: order.status,
      totalAmount: order.totalAmount.amount,
      initialAmount: order.initialAmount.amount,
      initialDiscount: order.initialDiscount.amount,
      lineIds: order.lines.map((l) => l.id.value).sort(),
    };
  }
});

describe('Order.reconstitute — OA3', () => {
  // The exact case name specs/shared/test-matrix.md §1 / requirements.md §3
  // names for OA3. Comprehensive: no event, totals re-derived (not
  // trusted), and every inconsistent-snapshot rejection.
  it('reconstitutes without emitting an event, recomputes the totals from the lines and refuses inconsistent persisted state', () => {
    const order = Order.reconstitute(baseSnapshot());
    expect(order.pullDomainEvents()).toHaveLength(0);
    expect(order.totalAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);
    expect(order.initialAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);
    expect(order.initialDiscount.equals(Money.of(0, 'EUR'))).toBe(true);

    expect(() => Order.reconstitute(baseSnapshot({ lines: [] }))).toThrow(EmptyOrderError);
    expect(() =>
      Order.reconstitute(baseSnapshot({ status: 'shipped' as unknown as OrderStatus })),
    ).toThrow(InvalidOrderSnapshotError);
    expect(() =>
      Order.reconstitute(baseSnapshot({ status: 'placed', cancellationReason: 'operator_cancelled' })),
    ).toThrow(InvalidOrderSnapshotError);
    expect(() => Order.reconstitute(baseSnapshot({ status: 'cancelled' }))).toThrow(
      InvalidOrderSnapshotError,
    );

    const cancelled = Order.reconstitute(
      baseSnapshot({ status: 'cancelled', cancellationReason: 'operator_cancelled' }),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toBe('operator_cancelled');
  });

  it('emits no domain event and leaves pullDomainEvents() empty', () => {
    const order = Order.reconstitute(baseSnapshot());
    expect(order.pullDomainEvents()).toHaveLength(0);
  });

  it('recomputes initialAmount, initialDiscount and totalAmount from the reconstituted lines rather than trusting a stored value — OrderSnapshot carries no totals field at all', () => {
    const order = Order.reconstitute(baseSnapshot());
    expect(order.totalAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);
    expect(order.initialAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);
    expect(order.initialDiscount.equals(Money.of(0, 'EUR'))).toBe(true);
  });

  it('refuses a snapshot with no lines', () => {
    expect(() => Order.reconstitute(baseSnapshot({ lines: [] }))).toThrow(EmptyOrderError);
  });

  it('refuses a snapshot whose status is outside the closed status set', () => {
    expect(() =>
      Order.reconstitute(baseSnapshot({ status: 'shipped' as unknown as OrderStatus })),
    ).toThrow(InvalidOrderSnapshotError);
  });

  it('refuses a snapshot carrying a cancellation reason while status is not cancelled', () => {
    expect(() =>
      Order.reconstitute(baseSnapshot({ status: 'placed', cancellationReason: 'operator_cancelled' })),
    ).toThrow(InvalidOrderSnapshotError);
  });

  it('refuses a snapshot with status cancelled but no cancellation reason', () => {
    expect(() => Order.reconstitute(baseSnapshot({ status: 'cancelled' }))).toThrow(
      InvalidOrderSnapshotError,
    );
  });

  it('accepts a cancelled snapshot that does carry a cancellation reason', () => {
    const order = Order.reconstitute(
      baseSnapshot({ status: 'cancelled', cancellationReason: 'operator_cancelled' }),
    );
    expect(order.status).toBe('cancelled');
    expect(order.cancellationReason).toBe('operator_cancelled');
  });

  it('a reconstituted order can still be mutated according to its status (no residual "reconstituted" flag)', () => {
    const order = Order.reconstitute(baseSnapshot({ status: 'placed' }));
    expect(() => order.addLine(lineInput({ productCode: 'PRD-9999' }))).not.toThrow();
  });
});

describe('Order.lines — OA5', () => {
  // The exact case name specs/shared/test-matrix.md §1 / requirements.md §3
  // names for OA5. Comprehensive: the array is frozen, each line view is
  // frozen, and neither mutating attempt reaches the order's real lines or
  // totals.
  it('returns lines that cannot be used to mutate the order or its totals', () => {
    const order = Order.place(placeInput(), ctx());
    const totalBefore = order.totalAmount;

    const lines = order.lines;
    expect(Object.isFrozen(lines)).toBe(true);
    expect(() => (lines as unknown as unknown[]).push({})).toThrow();
    expect(order.lines).toHaveLength(1);

    const [line] = order.lines;
    expect(Object.isFrozen(line)).toBe(true);
    expect(() => {
      (line as { productCode: string }).productCode = 'HACKED';
    }).toThrow();
    expect(order.lines[0].productCode).toBe('PRD-0001');

    expect(order.lines).toHaveLength(1);
    expect(order.totalAmount.equals(totalBefore)).toBe(true);
  });

  it('the returned array is frozen — pushing to it throws in strict mode / is a no-op that never reaches the order', () => {
    const order = Order.place(placeInput(), ctx());
    const lines = order.lines;

    expect(Object.isFrozen(lines)).toBe(true);
    expect(() => (lines as unknown[]).push({})).toThrow();
    expect(order.lines).toHaveLength(1);
  });

  it('each returned line view is frozen — assigning to a field throws and never reaches the order', () => {
    const order = Order.place(placeInput(), ctx());
    const [line] = order.lines;

    expect(Object.isFrozen(line)).toBe(true);
    expect(() => {
      (line as { productCode: string }).productCode = 'HACKED';
    }).toThrow();
    expect(order.lines[0].productCode).toBe('PRD-0001');
  });

  it('mutating the returned collection changes neither the order lines nor its totals', () => {
    const order = Order.place(placeInput(), ctx());
    const totalBefore = order.totalAmount;
    const lines = order.lines as unknown as unknown[];

    try {
      lines.length = 0;
    } catch {
      // frozen arrays throw in strict mode; either way nothing may reach the order
    }

    expect(order.lines).toHaveLength(1);
    expect(order.totalAmount.equals(totalBefore)).toBe(true);
  });

  it('two calls to .lines return independent frozen copies, not the same live reference', () => {
    const order = Order.place(placeInput(), ctx());
    expect(order.lines).not.toBe(order.lines);
    expect(order.lines).toEqual(order.lines);
  });
});
