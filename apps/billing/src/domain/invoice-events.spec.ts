// Pure unit — BI13.
import { InvoiceReference, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { Invoice, type InvoiceContext, type IssueInvoiceInput } from './invoice.js';

const CURRENCY = 'EUR';

function ctx(): InvoiceContext {
  return { occurredAt: new Date('2026-08-21T10:00:00.000Z'), causationId: UniqueId.generate() };
}

function issueInput(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    id: UniqueId.generate(),
    invoiceReference: InvoiceReference.fromSequence(1),
    invoiceDate: new Date('2026-08-21T10:00:00.000Z'),
    orderReference: OrderNumber.fromSequence(1),
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    currency: CURRENCY,
    lines: [{ productCode: 'PRD-0001', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
    discount: Money.zero(CURRENCY),
    correlationId: UniqueId.generate(),
    ...overrides,
  };
}

describe('invoice-events.spec — BI13', () => {
  it('stamps invoice.issued.v1 with the invoice as aggregateId, the order as correlationId and the request as causationId', () => {
    const invoiceCtx = ctx();
    const correlationId = UniqueId.generate(); // the order id
    const input = issueInput({ correlationId });

    const invoice = Invoice.issue(input, invoiceCtx);
    const [event] = invoice.pullDomainEvents();

    expect(event).toBeDefined();
    expect(event!.eventType).toBe('invoice.issued.v1');
    expect(event!.aggregateId.equals(invoice.id)).toBe(true);
    expect(event!.correlationId.equals(correlationId)).toBe(true);
    expect(event!.causationId.equals(invoiceCtx.causationId)).toBe(true);
    expect(event!.occurredAt).toEqual(invoiceCtx.occurredAt);
    // occurredAt = the invoice's own invoiceDate, read from the clock port
    // once and shared (BI13, design §5.4).
    expect(event!.occurredAt).toEqual(invoice.invoiceDate);
  });

  it('one builder, one call site: invoice.issued.v1 is produced only by Invoice.issue', () => {
    const invoice = Invoice.issue(issueInput(), ctx());
    const events = invoice.pullDomainEvents();

    expect(events).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'invoice.issued.v1')).toHaveLength(1);
  });
});
