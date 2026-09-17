// Backlog id 102 (`problem_detail_money_reads_as_minor_units`) — every
// `DomainError` message enumerated as reaching a Gateway problem
// document's `detail` (review `review_timeline_money_and_stock_names.md`
// D6, and this feature's own class enumeration) renders its amount(s)
// with the shared money-text formatter (id 100, `formatMoney`), never as
// a raw minor-units integer. Whole-string assertions only, the same
// discipline id 100's own tests use.
import { CreditLineReference, InvoiceReference, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { BuyerCredit, type CreditContext } from './buyer-credit.js';
import type { BuyerCreditSnapshot } from './buyer-credit-snapshot.js';
import { CreditLimitExceededError, CreditReleaseUnderflowError, InvalidBuyerCreditSnapshotError } from './credit-errors.js';
import { Invoice, type InvoiceContext, type IssueInvoiceInput } from './invoice.js';
import { InvoicePaymentAmountMismatchError, NegativeInvoiceTotalError } from './invoice-errors.js';

const ORDER = OrderNumber.fromSequence(1);
const CURRENCY = 'EUR';

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

describe('domain-error-money-text — CreditLimitExceededError', () => {
  it('renders both amounts scaled by the currency exponent', () => {
    const credit = BuyerCredit.reconstitute(creditSnapshot({ creditLimit: 500 }));

    let caught: unknown;
    try {
      credit.approveHold({ orderReference: ORDER, amount: Money.of(1_000, CURRENCY), correlationId: UniqueId.generate() }, creditCtx(), () => UniqueId.generate());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CreditLimitExceededError);
    expect((caught as Error).message).toBe('requested 10.00 EUR but only 5.00 EUR available (invariant B1)');
  });
});

describe('domain-error-money-text — CreditReleaseUnderflowError (BHD, a 3-exponent currency)', () => {
  it('renders the exposure amount scaled by the currency exponent', () => {
    const error = new CreditReleaseUnderflowError('ORD-000001', -500, 'BHD');

    expect(error.message).toBe('order ORD-000001: outstanding exposure is already negative (-0.500 BHD) — invariant B5 violated');
  });
});

describe('domain-error-money-text — BuyerCredit.reconstitute (InvalidBuyerCreditSnapshotError)', () => {
  it('renders committedExposure/creditLimit scaled by the currency exponent', () => {
    const badSnapshot = creditSnapshot({ creditLimit: 1_000, committedExposure: 1_001 });

    let caught: unknown;
    try {
      BuyerCredit.reconstitute(badSnapshot);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidBuyerCreditSnapshotError);
    expect((caught as Error).message).toBe(
      `credit line ${badSnapshot.id.value}: invalid snapshot: committedExposure (10.01 EUR) exceeds creditLimit (10.00 EUR) — violates B1`,
    );
  });
});

const OCCURRED_AT = new Date('2026-09-05T12:00:00.000Z');

function invoiceCtx(): InvoiceContext {
  return { occurredAt: OCCURRED_AT, causationId: UniqueId.generate() };
}

function issueInput(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    id: UniqueId.generate(),
    invoiceReference: InvoiceReference.fromSequence(1),
    invoiceDate: OCCURRED_AT,
    orderReference: ORDER,
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    currency: CURRENCY,
    lines: [{ productCode: 'SKU-1', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
    discount: Money.zero(CURRENCY),
    correlationId: UniqueId.generate(),
    ...overrides,
  };
}

describe('domain-error-money-text — Invoice.issue (NegativeInvoiceTotalError)', () => {
  it('renders both amounts scaled by the currency exponent', () => {
    let caught: unknown;
    try {
      Invoice.issue(issueInput({ discount: Money.of(5_000, CURRENCY) }), invoiceCtx());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NegativeInvoiceTotalError);
    expect((caught as Error).message).toBe('totalAmount would be negative: amount (20.00 EUR) − discount (50.00 EUR) < 0 (invariant B6)');
  });
});

describe('domain-error-money-text — Invoice.markPaid (InvoicePaymentAmountMismatchError)', () => {
  it('renders both amounts scaled by the currency exponent', () => {
    const invoice = Invoice.issue(issueInput(), invoiceCtx());

    let caught: unknown;
    try {
      invoice.markPaid(
        { paymentReference: 'PAY-000001', amount: invoice.totalAmount.add(Money.of(1, CURRENCY)), valueDate: OCCURRED_AT, source: 'operator', correlationId: UniqueId.generate() },
        invoiceCtx(),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvoicePaymentAmountMismatchError);
    expect((caught as Error).message).toBe("payment amount (20.01 EUR) does not match the invoice's totalAmount (20.00 EUR) (invariant B10)");
  });
});
