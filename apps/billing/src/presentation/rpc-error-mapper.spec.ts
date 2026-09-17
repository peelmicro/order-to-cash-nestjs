// Pure unit — every mapped error class -> its RpcError code; unknown ->
// INTERNAL_ERROR; a business rejection is never an RpcError (design.md
// §4.4).
import { describe, expect, it } from 'vitest';
import type { ValidationError } from 'class-validator';
import { CreditLineReference, InvoiceReference, Quantity, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import {
  CreditLimitExceededError,
  CreditRefusalMismatchError,
  CreditReleaseUnderflowError,
  FactAggregateMismatchError,
  InvalidBuyerCreditSnapshotError,
  NoActiveHoldError,
} from '../domain/credit-errors';
import { BuyerCredit, type CreditContext } from '../domain/buyer-credit';
import type { BuyerCreditSnapshot } from '../domain/buyer-credit-snapshot';
import { CreditCurrencyMismatchError, CreditLineNotFoundError } from '../application/credit-application-errors';
import {
  EmptyInvoiceLinesError,
  InvoiceAlreadyPaidError,
  InvoiceLineCurrencyMismatchError,
  InvoicePaymentAmountMismatchError,
  InvoicePaymentCurrencyMismatchError,
  NegativeInvoiceTotalError,
} from '../domain/invoice-errors';
import { Invoice, type InvoiceContext, type IssueInvoiceInput } from '../domain/invoice';
import {
  InvoiceCurrencyMismatchError,
  InvoiceNotFoundError,
  NoActiveCreditHoldError,
  PaymentReferenceConflictError,
} from '../application/invoice-application-errors';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

describe('rpc-error-mapper — validation', () => {
  it('validationRpcError flattens class-validator violations into VALIDATION_FAILED', () => {
    const violations = [{ property: 'orderReference', constraints: { matches: 'orderReference must match /^ORD-\\d{6}$/' } }] as unknown as ValidationError[];

    const error = validationRpcError(violations);

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('orderReference must match');
  });
});

describe('rpc-error-mapper — toRpcError, every mapped class', () => {
  it('CreditLineNotFoundError -> NOT_FOUND naming the pair (BC3)', () => {
    const error = toRpcError(new CreditLineNotFoundError('AldiDe', 'ALBIONFOODS'));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toEqual({ retailerCode: 'AldiDe', companyCode: 'ALBIONFOODS' });
  });

  it('CreditCurrencyMismatchError -> VALIDATION_FAILED naming expected/received (BC4)', () => {
    const error = toRpcError(new CreditCurrencyMismatchError('EUR', 'GBP'));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ expected: 'EUR', received: 'GBP' });
  });

  it('CreditReleaseUnderflowError -> PRECONDITION_FAILED naming the code', () => {
    const error = toRpcError(new CreditReleaseUnderflowError('ORD-000001', -100, 'EUR'));
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toEqual({ code: 'CREDIT_RELEASE_UNDERFLOW' });
  });

  it('NoActiveHoldError -> PRECONDITION_FAILED naming the code', () => {
    const error = toRpcError(new NoActiveHoldError('ORD-000001'));
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toEqual({ code: 'NO_ACTIVE_HOLD' });
  });

  // `billing_invoicing` design.md §4.3 — the four added cases.
  it('NoActiveCreditHoldError -> PRECONDITION_FAILED naming NO_ACTIVE_HOLD and the orderReference (BI5)', () => {
    const error = toRpcError(new NoActiveCreditHoldError('ORD-000001'));
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.details).toEqual({ code: 'NO_ACTIVE_HOLD', orderReference: 'ORD-000001' });
  });

  it('InvoiceCurrencyMismatchError -> VALIDATION_FAILED naming expected/received (BI4)', () => {
    const error = toRpcError(new InvoiceCurrencyMismatchError('EUR', 'GBP'));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ expected: 'EUR', received: 'GBP' });
  });

  it('NegativeInvoiceTotalError, EmptyInvoiceLinesError and InvoiceLineCurrencyMismatchError -> VALIDATION_FAILED naming the code', () => {
    expect(toRpcError(new NegativeInvoiceTotalError(1_000, 2_000, 'EUR'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { code: 'NEGATIVE_INVOICE_TOTAL' } });
    expect(toRpcError(new EmptyInvoiceLinesError('ORD-000001'))).toMatchObject({ code: 'VALIDATION_FAILED', details: { code: 'EMPTY_INVOICE_LINES' } });
    expect(toRpcError(new InvoiceLineCurrencyMismatchError('EUR', 'GBP'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'INVOICE_LINE_CURRENCY_MISMATCH' },
    });
  });

  it('InvoiceAlreadyPaidError and InvoicePayment*MismatchError -> PRECONDITION_FAILED naming the code', () => {
    expect(toRpcError(new InvoiceAlreadyPaidError('INV-000001'))).toMatchObject({ code: 'PRECONDITION_FAILED', details: { code: 'INVOICE_ALREADY_PAID' } });
    expect(toRpcError(new InvoicePaymentAmountMismatchError(1_000, 900, 'EUR'))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      details: { code: 'INVOICE_PAYMENT_AMOUNT_MISMATCH' },
    });
    expect(toRpcError(new InvoicePaymentCurrencyMismatchError('EUR', 'GBP'))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      details: { code: 'INVOICE_PAYMENT_CURRENCY_MISMATCH' },
    });
  });

  // feature 22 — the two error classes `billing.payment.register` adds.
  it('InvoiceNotFoundError -> NOT_FOUND naming the code and the identity', () => {
    const error = toRpcError(new InvoiceNotFoundError('INV-999999'));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toEqual({ code: 'INVOICE_NOT_FOUND', identity: 'INV-999999' });
  });

  it('PaymentReferenceConflictError -> CONFLICT naming the code and the paymentReference', () => {
    const error = toRpcError(new PaymentReferenceConflictError('PAY-000001'));
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toEqual({ code: 'PAYMENT_REFERENCE_CONFLICT', paymentReference: 'PAY-000001' });
  });

  it('any other DomainError -> DOMAIN_ERROR naming the code', () => {
    expect(toRpcError(new CreditLimitExceededError(1_000, 500, 'EUR')).code).toBe('DOMAIN_ERROR');
    expect(toRpcError(new CreditRefusalMismatchError('over_limit')).code).toBe('DOMAIN_ERROR');
    expect(toRpcError(new InvalidBuyerCreditSnapshotError('bad')).code).toBe('DOMAIN_ERROR');
    expect(toRpcError(new FactAggregateMismatchError(UniqueId.generate(), UniqueId.generate())).code).toBe('DOMAIN_ERROR');
  });

  it('anything else -> INTERNAL_ERROR', () => {
    expect(toRpcError(new Error('boom')).code).toBe('INTERNAL_ERROR');
    expect(toRpcError('a string is not even an Error').code).toBe('INTERNAL_ERROR');
  });
});

describe('rpc-error-mapper — a business rejection is never an RpcError', () => {
  it('has no bespoke case for a rejected CreditHoldReplyPayload shape — it is not an Error, so it falls through to INTERNAL_ERROR rather than being mistaken for one of the mapped refusals', () => {
    // `credit.controller.ts` only calls `toRpcError` in its catch block,
    // and `CreditHoldHandler.hold` never throws for a business rejection
    // (`refuseHold` resolves normally, the reply carries `outcome:
    // 'rejected'`) — so a value shaped like that reply reaching this
    // mapper at all would be a bug elsewhere, and this mapper has no
    // special-cased vocabulary that would silently "recognise" it.
    const rejectedReplyShape = { outcome: 'rejected', reason: 'over_limit' };

    const error = toRpcError(rejectedReplyShape);

    expect(error.code).toBe('INTERNAL_ERROR');
  });
});

// Backlog id 102, fix round 1 (review `review_timeline_money_and_stock_names.md`,
// defect E1). `domain-error-money-text.spec.ts` proves each fixed site's
// own `.message` is rendered with `formatMoney`; it never calls
// `toRpcError`. The reviewer's own arm (Q4) showed that gap is real:
// reverting this mapper's `InvoicePaymentAmountMismatchError` case to
// rebuild a raw-minor-units message left `billing`'s suite fully green,
// because nothing drove a REAL domain error through the REAL mapper and
// asserted the whole wire `message`. These 5 cases — one per fixed
// Billing site that `toRpcError` maps to a wire message (id 102's own
// enumeration table) — close that.
describe('rpc-error-mapper — money text reaches the wire message (id 102 fix round 1)', () => {
  const CURRENCY = 'EUR';
  const ORDER = OrderNumber.fromSequence(1);

  function creditCtx(): CreditContext {
    return { occurredAt: new Date('2026-08-21T10:00:00.000Z'), causationId: UniqueId.generate() };
  }

  function creditSnapshot(overrides: Partial<BuyerCreditSnapshot> = {}): BuyerCreditSnapshot {
    return {
      id: UniqueId.generate(),
      code: CreditLineReference.fromSequence(1),
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      creditLimit: 500_000,
      currency: CURRENCY,
      committedExposure: 0,
      orderEntries: [],
      ...overrides,
    };
  }

  it('CreditLimitExceededError reaches the wire message scaled by the currency exponent', () => {
    const credit = BuyerCredit.reconstitute(creditSnapshot({ creditLimit: 500 }));

    let caught: unknown;
    try {
      credit.approveHold({ orderReference: ORDER, amount: Money.of(1_000, CURRENCY), correlationId: UniqueId.generate() }, creditCtx(), () => UniqueId.generate());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CreditLimitExceededError);
    const reply = toRpcError(caught);
    expect(reply.message).toBe('requested 10.00 EUR but only 5.00 EUR available (invariant B1)');
  });

  it('CreditReleaseUnderflowError (BHD, a 3-exponent currency) reaches the wire message scaled by the currency exponent', () => {
    const error = new CreditReleaseUnderflowError('ORD-000001', -500, 'BHD');

    const reply = toRpcError(error);

    expect(reply.message).toBe('order ORD-000001: outstanding exposure is already negative (-0.500 BHD) — invariant B5 violated');
  });

  it('InvalidBuyerCreditSnapshotError (BuyerCredit.reconstitute) reaches the wire message scaled by the currency exponent', () => {
    const badSnapshot = creditSnapshot({ creditLimit: 1_000, committedExposure: 1_001 });

    let caught: unknown;
    try {
      BuyerCredit.reconstitute(badSnapshot);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidBuyerCreditSnapshotError);
    const reply = toRpcError(caught);
    expect(reply.message).toBe(`credit line ${badSnapshot.id.value}: invalid snapshot: committedExposure (10.01 EUR) exceeds creditLimit (10.00 EUR) — violates B1`);
  });

  it('NegativeInvoiceTotalError (Invoice.issue) reaches the wire message scaled by the currency exponent', () => {
    const occurredAt = new Date('2026-09-05T12:00:00.000Z');
    const ctx: InvoiceContext = { occurredAt, causationId: UniqueId.generate() };
    const input: IssueInvoiceInput = {
      id: UniqueId.generate(),
      invoiceReference: InvoiceReference.fromSequence(1),
      invoiceDate: occurredAt,
      orderReference: ORDER,
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      currency: CURRENCY,
      lines: [{ productCode: 'SKU-1', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
      discount: Money.of(5_000, CURRENCY),
      correlationId: UniqueId.generate(),
    };

    let caught: unknown;
    try {
      Invoice.issue(input, ctx);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NegativeInvoiceTotalError);
    const reply = toRpcError(caught);
    expect(reply.message).toBe('totalAmount would be negative: amount (20.00 EUR) − discount (50.00 EUR) < 0 (invariant B6)');
  });

  it("InvoicePaymentAmountMismatchError (Invoice.markPaid) reaches the wire message scaled by the currency exponent — the review's own traced route", () => {
    const occurredAt = new Date('2026-09-05T12:00:00.000Z');
    const ctx: InvoiceContext = { occurredAt, causationId: UniqueId.generate() };
    const input: IssueInvoiceInput = {
      id: UniqueId.generate(),
      invoiceReference: InvoiceReference.fromSequence(1),
      invoiceDate: occurredAt,
      orderReference: ORDER,
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      currency: CURRENCY,
      lines: [{ productCode: 'SKU-1', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
      discount: Money.zero(CURRENCY),
      correlationId: UniqueId.generate(),
    };
    const invoice = Invoice.issue(input, ctx);

    let caught: unknown;
    try {
      invoice.markPaid(
        { paymentReference: 'PAY-000001', amount: invoice.totalAmount.add(Money.of(1, CURRENCY)), valueDate: occurredAt, source: 'operator', correlationId: UniqueId.generate() },
        ctx,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvoicePaymentAmountMismatchError);
    const reply = toRpcError(caught);
    expect(reply.message).toBe("payment amount (20.01 EUR) does not match the invoice's totalAmount (20.00 EUR) (invariant B10)");
  });
});
