import { describe, expect, it } from 'vitest';
import type { OrderPlacedPayload } from '@otc/contracts';
import { makeEnvelope } from '../../test-support/envelope-fixtures';
import { buildOrderPlacedMessage } from './order-placed.template';

const PAYLOAD: OrderPlacedPayload = {
  orderReference: 'ORD-000001',
  retailerCode: 'RETAILER01',
  companyCode: 'COMPANY01',
  buyerGln: '1234567890128',
  supplierGln: '1234567890128',
  currency: 'USD',
  orderDate: '2026-08-24T09:00:00.000Z',
  lines: [{ productCode: 'P1', quantity: 1, unitPrice: 1000, lineDiscount: 0 }],
  initialAmount: 1000,
  initialDiscount: 0,
  totalAmount: 1000,
};

// NS1 — order.placed.v1's template: plain text + minimal HTML, correlation id in the subject line.
describe('order-placed.template — NS1', () => {
  it('builds a subject carrying the correlation id, and a body with the order reference and total', () => {
    const envelope = makeEnvelope('order.placed.v1', PAYLOAD, { correlationId: 'corr-42' });

    const message = buildOrderPlacedMessage(envelope);

    expect(message.subject).toContain('ORD-000001');
    expect(message.subject).toContain('correlationId: corr-42');
    expect(message.to).toBe('retailer01@retailer.order-to-cash.example');
    expect(message.text).toContain('10.00 USD');
    expect(message.text).not.toMatch(/<[a-z]+>/i);
    expect(message.html).toContain('<strong>ORD-000001</strong>');
    expect(message.html).toContain('10.00 USD');
  });
});
