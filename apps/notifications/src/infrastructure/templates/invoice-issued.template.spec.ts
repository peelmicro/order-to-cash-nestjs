import { describe, expect, it } from 'vitest';
import type { InvoiceIssuedPayload } from '@otc/contracts';
import { makeEnvelope } from '../../test-support/envelope-fixtures';
import { buildInvoiceIssuedMessage } from './invoice-issued.template';

const PAYLOAD: InvoiceIssuedPayload = {
  orderReference: 'ORD-000001',
  invoiceReference: 'INV-000001',
  invoiceDate: '2026-08-24T12:00:00.000Z',
  retailerCode: 'RETAILER01',
  companyCode: 'COMPANY01',
  currency: 'USD',
  lines: [{ productCode: 'P1', units: 3, unitPrice: 1000 }],
  amount: 3000,
  discount: 0,
  totalAmount: 3000,
};

// NS4 — invoice.issued.v1's template.
describe('invoice-issued.template — NS4', () => {
  it('builds a subject carrying the correlation id, and a body with the invoice reference and total', () => {
    const envelope = makeEnvelope('invoice.issued.v1', PAYLOAD, { correlationId: 'corr-42' });

    const message = buildInvoiceIssuedMessage(envelope);

    expect(message.subject).toContain('INV-000001');
    expect(message.subject).toContain('correlationId: corr-42');
    expect(message.to).toBe('retailer01@retailer.order-to-cash.example');
    expect(message.text).toContain('30.00 USD');
    expect(message.html).toContain('<strong>INV-000001</strong>');
  });
});
