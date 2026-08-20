// Pure totals derivation over an order's lines — domain-model.md §3.2
// invariant O3, design.md §4.3. `Money` arithmetic only (`multiply`, `add`,
// `subtract`), so R1/R2 hold by construction: no `number` arithmetic on
// amounts exists in this feature.
import { Money } from '@otc/shared-kernel';
import { NegativeOrderTotalError } from './order-errors.js';
import type { OrderLine } from './order-line.js';

export interface OrderTotals {
  readonly initialAmount: Money;
  readonly initialDiscount: Money;
  readonly totalAmount: Money;
}

/**
 * `initialAmount   = Σ line.unitPrice.multiply(line.quantity)`
 * `initialDiscount = Σ line.lineDiscount + orderDiscount`  — `orderDiscount`
 * is a named `Money.zero(currency)` term (design.md §4.3 / spec open point
 * 2: no order-level discount field exists anywhere in this design, but the
 * term stays in the formula so a future addition has an obvious home).
 * `totalAmount     = initialAmount - initialDiscount`, raising
 * {@link NegativeOrderTotalError} if the result would be negative.
 */
export function computeOrderTotals(currency: string, lines: readonly OrderLine[]): OrderTotals {
  const orderDiscount = Money.zero(currency);

  const initialAmount = lines.reduce(
    (sum, line) => sum.add(line.unitPrice.multiply(line.quantity)),
    Money.zero(currency),
  );
  const initialDiscount = lines
    .reduce((sum, line) => sum.add(line.lineDiscount), Money.zero(currency))
    .add(orderDiscount);
  const totalAmount = initialAmount.subtract(initialDiscount);

  if (totalAmount.isNegative()) {
    throw new NegativeOrderTotalError(totalAmount);
  }

  return { initialAmount, initialDiscount, totalAmount };
}
