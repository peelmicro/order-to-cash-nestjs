// Pure unit — no framework, no DB, no clock. R45/R46 (matrix names,
// verbatim) plus this feature's local cases BI10, BI11, BI14.
import { InvoiceReference, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { Invoice, type InvoiceContext, type IssueInvoiceInput } from './invoice.js';
import type { InvoiceSnapshot } from './invoice-snapshot.js';
import {
  EmptyInvoiceLinesError,
  InvalidInvoiceSnapshotError,
  InvoiceAlreadyPaidError,
  InvoiceLineCurrencyMismatchError,
  InvoicePaymentAmountMismatchError,
  InvoicePaymentCurrencyMismatchError,
  NegativeInvoiceTotalError,
} from './invoice-errors.js';

const CURRENCY = 'EUR';
const ORDER = OrderNumber.fromSequence(1);
const OCCURRED_AT = new Date('2026-08-21T10:00:00.000Z');

function ctx(overrides: Partial<InvoiceContext> = {}): InvoiceContext {
  return { occurredAt: OCCURRED_AT, causationId: UniqueId.generate(), ...overrides };
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
    lines: [{ productCode: 'PRD-0001', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
    discount: Money.zero(CURRENCY),
    correlationId: UniqueId.generate(),
    ...overrides,
  };
}

function issuedInvoice(overrides: Partial<IssueInvoiceInput> = {}): Invoice {
  return Invoice.issue(issueInput(overrides), ctx());
}

describe('invoice.spec — R45', () => {
  it('creates exactly one issued invoice mirroring the despatched lines with a non-negative total and returns the existing reference emitting no second fact on a repeat', () => {
    const input = issueInput({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) },
        { productCode: 'PRD-0002', units: Quantity.of(3), unitPrice: Money.of(500, CURRENCY) },
      ],
    });

    const invoice = Invoice.issue(input, ctx());

    // Mirrors the despatched lines exactly — same productCode, units, unitPrice.
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]).toMatchObject({ productCode: 'PRD-0001', unitPrice: Money.of(1_000, CURRENCY) });
    expect(invoice.lines[0]!.units.equals(Quantity.of(2))).toBe(true);
    expect(invoice.lines[1]).toMatchObject({ productCode: 'PRD-0002', unitPrice: Money.of(500, CURRENCY) });

    // amount = Σ(unitPrice × units), non-negative total, status issued.
    expect(invoice.amount).toEqual(Money.of(3_500, CURRENCY));
    expect(invoice.totalAmount).toEqual(Money.of(3_500, CURRENCY));
    expect(invoice.totalAmount.isNegative()).toBe(false);
    expect(invoice.status).toBe('issued');
    expect(invoice.paidAt).toBeNull();

    // Exactly one invoice.issued.v1, this call is the ONLY call site.
    const events = invoice.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('invoice.issued.v1');

    // "returns the existing reference emitting no second fact on a
    // repeat" — the aggregate half: `issue` is the only construction
    // site and there is no second call on this same instance, so a
    // second fact is structurally impossible here. The idempotent-repeat
    // BEHAVIOUR (the application handler returning `created: false`
    // without calling `issue` a second time) is proven at the integration
    // level (`BI9`, `invoice-issue.integration.spec.ts`) — this unit test
    // proves the aggregate half that repeat relies on: pulling events a
    // second time on the SAME instance yields none.
    expect(invoice.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses an empty line list', () => {
    expect(() => Invoice.issue(issueInput({ lines: [] }), ctx())).toThrow(EmptyInvoiceLinesError);
  });
});

describe('invoice.spec — R46', () => {
  it('allows only the transition from issued to paid, sets paidAt exactly then, and raises on every other transition changing and emitting nothing', () => {
    const invoice = issuedInvoice();
    invoice.pullDomainEvents(); // drain the issue fact — isolate markPaid's own emission below.
    expect(invoice.status).toBe('issued');
    expect(invoice.paidAt).toBeNull();

    const paidCtx = ctx({ occurredAt: new Date('2026-08-22T09:00:00.000Z') });
    invoice.markPaid(
      { paymentReference: 'PAY-000001', amount: invoice.totalAmount, valueDate: new Date('2026-08-21T00:00:00.000Z'), source: 'robot', correlationId: UniqueId.generate() },
      paidCtx,
    );

    // paidAt is set EXACTLY when status becomes paid (B9) — the instant
    // the transition executes (ctx.occurredAt), one indivisible step.
    expect(invoice.status).toBe('paid');
    expect(invoice.paidAt).toEqual(paidCtx.occurredAt);

    const events = invoice.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('payment.received.v1');

    // Every OTHER transition raises, changes nothing, emits nothing —
    // there is no other mutator on the aggregate (B8): a second markPaid
    // is the only reachable "other transition" a caller can attempt.
    const beforeSecondAttempt = invoice.toSnapshot();
    expect(() =>
      invoice.markPaid(
        { paymentReference: 'PAY-000002', amount: invoice.totalAmount, valueDate: new Date(), source: 'operator', correlationId: UniqueId.generate() },
        ctx(),
      ),
    ).toThrow(InvoiceAlreadyPaidError);
    expect(invoice.toSnapshot()).toEqual(beforeSecondAttempt);
    expect(invoice.pullDomainEvents()).toHaveLength(0);
  });
});

describe('invoice.spec — BI10: carries paidAt and the paid status as one indivisible value and refuses to reconstitute a row where the two disagree', () => {
  function baseSnapshot(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
    return {
      id: UniqueId.generate(),
      invoiceReference: InvoiceReference.fromSequence(1),
      invoiceDate: OCCURRED_AT,
      orderReference: ORDER,
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
      currency: CURRENCY,
      lines: [{ id: UniqueId.generate(), productCode: 'PRD-0001', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
      amount: Money.of(2_000, CURRENCY),
      discount: Money.zero(CURRENCY),
      totalAmount: Money.of(2_000, CURRENCY),
      status: 'issued',
      paidAt: null,
      ...overrides,
    };
  }

  it('refuses a row whose status is paid but paidAt is null', () => {
    expect(() => Invoice.reconstitute(baseSnapshot({ status: 'paid', paidAt: null }))).toThrow(InvalidInvoiceSnapshotError);
  });

  it('refuses a row whose status is issued but paidAt is set', () => {
    expect(() => Invoice.reconstitute(baseSnapshot({ status: 'issued', paidAt: new Date('2026-08-22T00:00:00.000Z') }))).toThrow(
      InvalidInvoiceSnapshotError,
    );
  });

  it('reconstitutes a genuinely paid row (status and paidAt agree) with paidAt carried through exactly', () => {
    const paidAt = new Date('2026-08-22T09:00:00.000Z');
    const invoice = Invoice.reconstitute(baseSnapshot({ status: 'paid', paidAt }));

    expect(invoice.status).toBe('paid');
    expect(invoice.paidAt).toEqual(paidAt);
  });

  it('reconstitutes a genuinely issued row (status issued, paidAt null) with paidAt null', () => {
    const invoice = Invoice.reconstitute(baseSnapshot());

    expect(invoice.status).toBe('issued');
    expect(invoice.paidAt).toBeNull();
  });
});

describe('invoice.spec — BI11: derives amount and totalAmount from the lines and refuses an empty line list, a non-positive unit count, a foreign currency and a negative total', () => {
  it('derives amount as Σ(unitPrice × units) and totalAmount as amount − discount', () => {
    const invoice = issuedInvoice({
      lines: [
        { productCode: 'PRD-0001', units: Quantity.of(3), unitPrice: Money.of(1_000, CURRENCY) },
        { productCode: 'PRD-0002', units: Quantity.of(2), unitPrice: Money.of(250, CURRENCY) },
      ],
      discount: Money.of(500, CURRENCY),
    });

    expect(invoice.amount).toEqual(Money.of(3_500, CURRENCY));
    expect(invoice.totalAmount).toEqual(Money.of(3_000, CURRENCY));
  });

  it('refuses an empty line list', () => {
    expect(() => Invoice.issue(issueInput({ lines: [] }), ctx())).toThrow(EmptyInvoiceLinesError);
  });

  it('refuses a non-positive unit count at construction — Quantity.of already refuses zero and negatives', () => {
    expect(() => Quantity.of(0)).toThrow();
    expect(() => Quantity.of(-1)).toThrow();
  });

  it('refuses a line whose currency differs from the invoice currency', () => {
    expect(() =>
      Invoice.issue(
        issueInput({ lines: [{ productCode: 'PRD-0001', units: Quantity.of(1), unitPrice: Money.of(1_000, 'GBP') }] }),
        ctx(),
      ),
    ).toThrow(InvoiceLineCurrencyMismatchError);
  });

  it('refuses a negative total (discount exceeds amount)', () => {
    expect(() => Invoice.issue(issueInput({ discount: Money.of(2_001, CURRENCY) }), ctx())).toThrow(NegativeInvoiceTotalError);
  });

  it('exposes no setter for amount, discount or totalAmount — B6, structural', () => {
    const invoice = issuedInvoice();
    expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(invoice), 'amount')?.set).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(invoice), 'discount')?.set).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(invoice), 'totalAmount')?.set).toBeUndefined();
  });
});

describe('invoice.spec — BI14: moves issued to paid setting paidAt in the same step and appending one payment.received.v1, and refuses a second payment, a mismatched amount and a mismatched currency', () => {
  it('moves issued to paid, setting paidAt in the same step and appending exactly one payment.received.v1', () => {
    const invoice = issuedInvoice();
    invoice.pullDomainEvents();
    const paidCtx = ctx({ occurredAt: new Date('2026-08-25T12:00:00.000Z') });

    invoice.markPaid(
      { paymentReference: 'PAY-000010', amount: invoice.totalAmount, valueDate: new Date('2026-08-24T00:00:00.000Z'), source: 'test', correlationId: UniqueId.generate() },
      paidCtx,
    );

    expect(invoice.status).toBe('paid');
    expect(invoice.paidAt).toEqual(paidCtx.occurredAt);
    const events = invoice.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('payment.received.v1');
  });

  it('refuses a second payment on an already-paid invoice, changing nothing and appending no event', () => {
    const invoice = issuedInvoice();
    invoice.markPaid(
      { paymentReference: 'PAY-000011', amount: invoice.totalAmount, valueDate: new Date(), source: 'robot', correlationId: UniqueId.generate() },
      ctx(),
    );
    invoice.pullDomainEvents();
    const before = invoice.toSnapshot();

    expect(() =>
      invoice.markPaid(
        { paymentReference: 'PAY-000012', amount: invoice.totalAmount, valueDate: new Date(), source: 'robot', correlationId: UniqueId.generate() },
        ctx(),
      ),
    ).toThrow(InvoiceAlreadyPaidError);
    expect(invoice.toSnapshot()).toEqual(before);
    expect(invoice.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses a mismatched amount, changing nothing and appending no event', () => {
    const invoice = issuedInvoice();
    invoice.pullDomainEvents();
    const before = invoice.toSnapshot();

    expect(() =>
      invoice.markPaid(
        { paymentReference: 'PAY-000013', amount: invoice.totalAmount.add(Money.of(1, CURRENCY)), valueDate: new Date(), source: 'robot', correlationId: UniqueId.generate() },
        ctx(),
      ),
    ).toThrow(InvoicePaymentAmountMismatchError);
    expect(invoice.toSnapshot()).toEqual(before);
    expect(invoice.pullDomainEvents()).toHaveLength(0);
  });

  it('refuses a mismatched currency, changing nothing and appending no event', () => {
    const invoice = issuedInvoice();
    invoice.pullDomainEvents();
    const before = invoice.toSnapshot();

    expect(() =>
      invoice.markPaid(
        { paymentReference: 'PAY-000014', amount: Money.of(invoice.totalAmount.amount, 'GBP'), valueDate: new Date(), source: 'robot', correlationId: UniqueId.generate() },
        ctx(),
      ),
    ).toThrow(InvoicePaymentCurrencyMismatchError);
    expect(invoice.toSnapshot()).toEqual(before);
    expect(invoice.pullDomainEvents()).toHaveLength(0);
  });
});
