// The domain errors of the `Invoice` aggregate and its `InvoiceLine` child
// entity — design.md §3.5. Every class extends `DomainError`
// (`@otc/shared-kernel`), carries a stable `code` and the fields a caller
// (and a test) needs, the same shape `apps/billing/src/domain/credit-errors.ts`
// established. Codes are the vocabulary `rpc-error-mapper.ts` (§4.3)
// translates into the AsyncAPI `RpcError.code` vocabulary.
import { DomainError, type UniqueId } from '@otc/shared-kernel';

/** B6 — `Invoice.issue` called with an empty line list. */
export class EmptyInvoiceLinesError extends DomainError {
  readonly code = 'EMPTY_INVOICE_LINES';

  constructor(readonly orderReference: string) {
    super(`order ${orderReference}: cannot issue an invoice with zero lines (invariant B6)`);
  }
}

/** B6 — a line's `unitPrice` currency differs from the invoice's own currency. The domain-layer twin of `application/invoice-application-errors.ts`'s `InvoiceCurrencyMismatchError`, raised on a LINE, not on the credit line. */
export class InvoiceLineCurrencyMismatchError extends DomainError {
  readonly code = 'INVOICE_LINE_CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`invoice line currency "${received}" does not match the invoice's currency "${expected}" (invariant B6)`);
  }
}

/** B6 — `amount − discount` would be negative. */
export class NegativeInvoiceTotalError extends DomainError {
  readonly code = 'NEGATIVE_INVOICE_TOTAL';

  constructor(
    readonly amount: number,
    readonly discount: number,
  ) {
    super(`totalAmount would be negative: amount (${amount}) − discount (${discount}) < 0 (invariant B6)`);
  }
}

/** `Invoice.reconstitute` given a snapshot whose `status`/`paidAt` disagree (B9), whose stored totals do not reconcile with its lines (B6), or whose currency is not shared by every line. */
export class InvalidInvoiceSnapshotError extends DomainError {
  readonly code = 'INVALID_INVOICE_SNAPSHOT';

  constructor(
    readonly reason: string,
    readonly invoiceId?: UniqueId,
  ) {
    super(`${invoiceId ? `invoice ${invoiceId.value}: ` : ''}invalid snapshot: ${reason}`);
  }
}

/** B8 — `markPaid` called on an invoice already `paid`; there is no other mutator, so this is the ONLY way B8 can be violated. */
export class InvoiceAlreadyPaidError extends DomainError {
  readonly code = 'INVOICE_ALREADY_PAID';

  constructor(readonly invoiceReference: string) {
    super(`invoice ${invoiceReference} is already paid (invariant B8)`);
  }
}

/** B10 — `markPaid` called with an amount other than the invoice's `totalAmount`. */
export class InvoicePaymentAmountMismatchError extends DomainError {
  readonly code = 'INVOICE_PAYMENT_AMOUNT_MISMATCH';

  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`payment amount (${received}) does not match the invoice's totalAmount (${expected}) (invariant B10)`);
  }
}

/** B10 — `markPaid` called with a currency other than the invoice's own. */
export class InvoicePaymentCurrencyMismatchError extends DomainError {
  readonly code = 'INVOICE_PAYMENT_CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`payment currency "${received}" does not match the invoice's currency "${expected}" (invariant B10)`);
  }
}
