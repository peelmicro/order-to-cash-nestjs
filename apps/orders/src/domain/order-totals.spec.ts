// R6, OA1 — totals derivation, the validate-then-commit mutators and the
// aggregate-boundary currency check. `computeOrderTotals` is exercised
// directly for the pure-function shape of R6; the mutation and
// currency-mismatch cases exercise `Order` itself, because "recomputed on
// every line mutation" and "refused at the aggregate boundary" (OA1's own
// wording) are both statements about the aggregate, not about the bare
// totals function.
import { GLN, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { OrderLine } from './order-line.js';
import { NegativeOrderTotalError, OrderLineCurrencyMismatchError } from './order-errors.js';
import { Order, type PlaceOrderInput, type PlaceOrderLineInput, type TransitionContext } from './order.js';
import { computeOrderTotals } from './order-totals.js';

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

function makeOrderLine(overrides: Partial<PlaceOrderLineInput> = {}): OrderLine {
  const input = lineInput(overrides);
  return OrderLine.create({
    id: UniqueId.generate(),
    productCode: input.productCode,
    description: input.description,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    lineDiscount: input.lineDiscount,
  });
}

describe('computeOrderTotals / Order — R6', () => {
  // The exact case name specs/shared/test-matrix.md §1 names for R6.
  // Comprehensive: derivation from the bare function, recomputation across
  // every mutator on the real aggregate, and the negative-total refusal at
  // both levels.
  it('recomputes initialAmount, initialDiscount and totalAmount after each mutation and rejects a negative total', () => {
    const initialLines = [
      makeOrderLine({ unitPrice: Money.of(1_000, 'EUR'), quantity: Quantity.of(2), lineDiscount: Money.of(100, 'EUR') }),
      makeOrderLine({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(3), lineDiscount: Money.of(50, 'EUR') }),
    ];
    const totals = computeOrderTotals('EUR', initialLines);
    expect(totals.initialAmount.equals(Money.of(3_500, 'EUR'))).toBe(true);
    expect(totals.initialDiscount.equals(Money.of(150, 'EUR'))).toBe(true);
    expect(totals.totalAmount.equals(Money.of(3_350, 'EUR'))).toBe(true);

    expect(() =>
      computeOrderTotals('EUR', [
        makeOrderLine({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(1), lineDiscount: Money.of(600, 'EUR') }),
      ]),
    ).toThrow(NegativeOrderTotalError);

    const order = Order.place(
      placeInput({ lines: [lineInput({ unitPrice: Money.of(1_000, 'EUR'), quantity: Quantity.of(1) })] }),
      ctx(),
    );
    expect(order.totalAmount.equals(Money.of(1_000, 'EUR'))).toBe(true);

    order.addLine(lineInput({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(2), lineDiscount: Money.of(0, 'EUR') }));
    expect(order.totalAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);
    expect(order.initialAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);

    const secondLineId = order.lines[1].id;
    order.changeLineQuantity(secondLineId, Quantity.of(4));
    expect(order.totalAmount.equals(Money.of(3_000, 'EUR'))).toBe(true);

    order.removeLine(secondLineId);
    expect(order.totalAmount.equals(Money.of(1_000, 'EUR'))).toBe(true);
    expect(order.lines).toHaveLength(1);

    const beforeRejectedMutation = { total: order.totalAmount, lineCount: order.lines.length };
    expect(() =>
      order.addLine(lineInput({ unitPrice: Money.of(0, 'EUR'), quantity: Quantity.of(1), lineDiscount: Money.of(1_500, 'EUR') })),
    ).toThrow(NegativeOrderTotalError);
    expect(order.totalAmount.equals(beforeRejectedMutation.total)).toBe(true);
    expect(order.lines).toHaveLength(beforeRejectedMutation.lineCount);
  });

  it('sums unitPrice * quantity across lines for initialAmount', () => {
    const lines = [
      makeOrderLine({ unitPrice: Money.of(1_000, 'EUR'), quantity: Quantity.of(2) }),
      makeOrderLine({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(3) }),
    ];

    const totals = computeOrderTotals('EUR', lines);

    expect(totals.initialAmount.equals(Money.of(3_500, 'EUR'))).toBe(true);
  });

  it('sums lineDiscount across lines for initialDiscount, with the order-level discount term at zero', () => {
    const lines = [
      makeOrderLine({ lineDiscount: Money.of(100, 'EUR') }),
      makeOrderLine({ lineDiscount: Money.of(50, 'EUR') }),
    ];

    const totals = computeOrderTotals('EUR', lines);

    expect(totals.initialDiscount.equals(Money.of(150, 'EUR'))).toBe(true);
  });

  it('totalAmount is initialAmount minus initialDiscount', () => {
    const lines = [makeOrderLine({ unitPrice: Money.of(1_000, 'EUR'), quantity: Quantity.of(1), lineDiscount: Money.of(200, 'EUR') })];

    const totals = computeOrderTotals('EUR', lines);

    expect(totals.totalAmount.equals(Money.of(800, 'EUR'))).toBe(true);
  });

  it('rejects a negative total with NegativeOrderTotalError, computed from a discount larger than the amount', () => {
    const lines = [makeOrderLine({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(1), lineDiscount: Money.of(600, 'EUR') })];

    expect(() => computeOrderTotals('EUR', lines)).toThrow(NegativeOrderTotalError);
  });

  it('recomputes totals on the aggregate after addLine, removeLine and changeLineQuantity, each leaving the totals internally consistent', () => {
    const order = Order.place(
      placeInput({ lines: [lineInput({ unitPrice: Money.of(1_000, 'EUR'), quantity: Quantity.of(1) })] }),
      ctx(),
    );
    expect(order.totalAmount.equals(Money.of(1_000, 'EUR'))).toBe(true);

    order.addLine(lineInput({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(2), lineDiscount: Money.of(0, 'EUR') }));
    expect(order.totalAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);
    expect(order.initialAmount.equals(Money.of(2_000, 'EUR'))).toBe(true);

    const secondLineId = order.lines[1].id;
    order.changeLineQuantity(secondLineId, Quantity.of(4));
    expect(order.totalAmount.equals(Money.of(3_000, 'EUR'))).toBe(true);

    order.removeLine(secondLineId);
    expect(order.totalAmount.equals(Money.of(1_000, 'EUR'))).toBe(true);
    expect(order.lines).toHaveLength(1);
  });

  it('rejects a mutation that would drive the total negative on the aggregate and leaves the order unchanged', () => {
    const order = Order.place(
      placeInput({ lines: [lineInput({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(1), lineDiscount: Money.of(0, 'EUR') })] }),
      ctx(),
    );
    const before = { total: order.totalAmount, lineCount: order.lines.length };

    expect(() =>
      order.addLine(lineInput({ unitPrice: Money.of(0, 'EUR'), quantity: Quantity.of(1), lineDiscount: Money.of(600, 'EUR') })),
    ).toThrow(NegativeOrderTotalError);

    expect(order.totalAmount.equals(before.total)).toBe(true);
    expect(order.lines).toHaveLength(before.lineCount);
  });
});

describe('Order — OA1', () => {
  // The exact case name specs/shared/test-matrix.md §1 / requirements.md §3
  // names for OA1. Comprehensive: both offending fields, at both call
  // sites (`place` and `addLine`), asserting the aggregate's own error
  // (never the kernel's `CurrencyMismatchError`) and no partial mutation.
  it('refuses a line whose price or discount currency differs from the order currency, with an order-level error and no partial mutation', () => {
    expect(() =>
      Order.place(
        placeInput({ currency: 'EUR', lines: [lineInput({ unitPrice: Money.of(1_000, 'GBP') })] }),
        ctx(),
      ),
    ).toThrow(OrderLineCurrencyMismatchError);

    expect(() =>
      Order.place(
        placeInput({ currency: 'EUR', lines: [lineInput({ lineDiscount: Money.of(10, 'GBP') })] }),
        ctx(),
      ),
    ).toThrow(OrderLineCurrencyMismatchError);

    try {
      Order.place(placeInput({ currency: 'EUR', lines: [lineInput({ unitPrice: Money.of(1_000, 'GBP') })] }), ctx());
      expect.fail('expected Order.place to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderLineCurrencyMismatchError);
      const currencyError = error as OrderLineCurrencyMismatchError;
      expect(currencyError.expected).toBe('EUR');
      expect(currencyError.actual).toBe('GBP');
      expect(currencyError.orderId).toBeDefined();
    }

    const order = Order.place(placeInput(), ctx());
    const before = { total: order.totalAmount, lineCount: order.lines.length };
    expect(() => order.addLine(lineInput({ unitPrice: Money.of(1_000, 'GBP') }))).toThrow(
      OrderLineCurrencyMismatchError,
    );
    expect(order.totalAmount.equals(before.total)).toBe(true);
    expect(order.lines).toHaveLength(before.lineCount);
  });

  it('rejects at Order.place when a line unitPrice currency differs from the order currency', () => {
    expect(() =>
      Order.place(
        placeInput({ currency: 'EUR', lines: [lineInput({ unitPrice: Money.of(1_000, 'GBP') })] }),
        ctx(),
      ),
    ).toThrow(OrderLineCurrencyMismatchError);
  });

  it('rejects at Order.place when a line lineDiscount currency differs from the order currency', () => {
    expect(() =>
      Order.place(
        placeInput({ currency: 'EUR', lines: [lineInput({ lineDiscount: Money.of(10, 'GBP') })] }),
        ctx(),
      ),
    ).toThrow(OrderLineCurrencyMismatchError);
  });

  it('raises OrderLineCurrencyMismatchError, never the kernel CurrencyMismatchError, and identifies the order and both currency codes', () => {
    try {
      Order.place(placeInput({ currency: 'EUR', lines: [lineInput({ unitPrice: Money.of(1_000, 'GBP') })] }), ctx());
      expect.fail('expected Order.place to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderLineCurrencyMismatchError);
      const currencyError = error as OrderLineCurrencyMismatchError;
      expect(currencyError.expected).toBe('EUR');
      expect(currencyError.actual).toBe('GBP');
      expect(currencyError.orderId).toBeDefined();
    }
  });

  it('rejects addLine with a mismatched currency and leaves the order unchanged (no partial mutation)', () => {
    const order = Order.place(placeInput(), ctx());
    const before = { total: order.totalAmount, lineCount: order.lines.length };

    expect(() => order.addLine(lineInput({ unitPrice: Money.of(1_000, 'GBP') }))).toThrow(
      OrderLineCurrencyMismatchError,
    );

    expect(order.totalAmount.equals(before.total)).toBe(true);
    expect(order.lines).toHaveLength(before.lineCount);
  });
});
