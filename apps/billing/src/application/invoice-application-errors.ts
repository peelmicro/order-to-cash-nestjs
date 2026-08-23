// Application-layer errors of `InvoiceIssueHandler` (design.md §5.3) —
// contract violations `Invoice.issue` has no domain vocabulary for, mirrors
// `credit-application-errors.ts`'s shape.
export abstract class InvoiceApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * `invoice.issue` names an order that holds no active credit hold on the
 * named credit line (`BI5`). Billing owns no order status and may not read
 * the Orders write model, so the active hold is its only proxy for
 * "despatched"; its absence means the two write models disagree.
 */
export class NoActiveCreditHoldError extends InvoiceApplicationError {
  readonly code = 'NO_ACTIVE_HOLD';

  constructor(readonly orderReference: string) {
    super(`invoice.issue: order ${orderReference} holds no active credit hold`);
  }
}

/** `invoice.issue` names a `currency` other than the resolved credit line's (`BI4`, a consequence of M2/B3). */
export class InvoiceCurrencyMismatchError extends InvoiceApplicationError {
  readonly code = 'INVOICE_CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`invoice.issue: requested currency "${received}" does not match the credit line's currency "${expected}"`);
  }
}
