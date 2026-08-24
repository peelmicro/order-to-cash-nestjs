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

/**
 * `billing.payment.register` names an `invoiceId`/`invoiceReference` that
 * resolves to no invoice — a contract violation, not a business refusal;
 * nothing is written, no fact is emitted (feature 22, R47-R49's identity
 * resolution step).
 */
export class InvoiceNotFoundError extends InvoiceApplicationError {
  readonly code = 'INVOICE_NOT_FOUND';

  constructor(readonly identity: string) {
    super(`payment.register: no invoice for "${identity}"`);
  }
}

/**
 * `billing.payment.register`'s belt-and-braces backstop (feature 22): the
 * SAME `paymentReference` was reused against two DIFFERENT invoices closely
 * enough in time that the in-transaction read-then-write straddled the
 * race — the ONLY case `payments.payment_reference`'s UNIQUE constraint,
 * not the invoice row's own lock, is what actually catches (the invoice
 * lock alone serialises two attempts on the SAME invoice; it cannot
 * serialise two DIFFERENT invoices' independent transactions). Nothing
 * from this call was left committed; the transaction that hit the
 * constraint rolled back in full.
 */
export class PaymentReferenceConflictError extends InvoiceApplicationError {
  readonly code = 'PAYMENT_REFERENCE_CONFLICT';

  constructor(readonly paymentReference: string) {
    super(`payment.register: paymentReference "${paymentReference}" was recorded by a concurrent request against a different invoice`);
  }
}
