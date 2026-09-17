// Backlog id 102 (`problem_detail_money_reads_as_minor_units`) — the
// Orders-side twin of `apps/billing/src/domain/domain-error-money-text.spec.ts`.
// `NegativeOrderTotalError` reaches a human via `rpc-error-mapper.ts` ->
// the Gateway's problem+json `detail`; it used to render
// `Money.toString()` (raw minor units, `money.ts`'s own `toString`), now
// the shared money-text formatter (id 100). Whole-string assertions only.
import { Money, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { OrderLine } from './order-line.js';
import { NegativeOrderTotalError } from './order-errors.js';
import { computeOrderTotals } from './order-totals.js';
import type { PlaceOrderLineInput } from './order.js';

function makeOrderLine(overrides: Partial<PlaceOrderLineInput> = {}): OrderLine {
  const base: PlaceOrderLineInput = {
    productCode: 'PRD-0001',
    description: 'Widget',
    quantity: Quantity.of(1),
    unitPrice: Money.of(500, 'EUR'),
    lineDiscount: Money.of(0, 'EUR'),
    ...overrides,
  };
  return OrderLine.create({
    id: UniqueId.generate(),
    productCode: base.productCode,
    description: base.description,
    quantity: base.quantity,
    unitPrice: base.unitPrice,
    lineDiscount: base.lineDiscount,
  });
}

describe('domain-error-money-text — NegativeOrderTotalError', () => {
  it('renders the negative total scaled by the currency exponent, never Money.toString()\'s raw minor units', () => {
    const lines = [makeOrderLine({ unitPrice: Money.of(500, 'EUR'), quantity: Quantity.of(1), lineDiscount: Money.of(600, 'EUR') })];

    let caught: unknown;
    try {
      computeOrderTotals('EUR', lines);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NegativeOrderTotalError);
    expect((caught as Error).message).toBe('total amount would be negative: -1.00 EUR');
    expect((caught as Error).message).not.toContain('-100 EUR');
  });

  it('renders a 0-exponent currency (JPY) with no decimal point', () => {
    const lines = [makeOrderLine({ unitPrice: Money.of(5_000, 'JPY'), quantity: Quantity.of(1), lineDiscount: Money.of(6_000, 'JPY') })];

    let caught: unknown;
    try {
      computeOrderTotals('JPY', lines);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NegativeOrderTotalError);
    expect((caught as Error).message).toBe('total amount would be negative: -1 000 JPY');
  });
});
