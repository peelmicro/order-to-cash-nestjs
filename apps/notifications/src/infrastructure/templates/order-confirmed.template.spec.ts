import { describe, expect, it } from 'vitest';
import type { OrderConfirmedPayload } from '@otc/contracts';
import { makeEnvelope } from '../../test-support/envelope-fixtures';
import { buildOrderConfirmedMessage } from './order-confirmed.template';

const PAYLOAD: OrderConfirmedPayload = {
  orderReference: 'ORD-000001',
  retailerCode: 'RETAILER01',
  companyCode: 'COMPANY01',
  currency: 'USD',
  totalAmount: 2500,
  confirmedAt: '2026-08-24T09:30:00.000Z',
};

// NS2 — order.confirmed.v1's template.
describe('order-confirmed.template — NS2', () => {
  it('builds a subject carrying the correlation id, and a body with the order reference and total', () => {
    const envelope = makeEnvelope('order.confirmed.v1', PAYLOAD, { correlationId: 'corr-42' });

    const message = buildOrderConfirmedMessage(envelope);

    expect(message.subject).toContain('ORD-000001');
    expect(message.subject).toContain('correlationId: corr-42');
    expect(message.to).toBe('retailer01@retailer.order-to-cash.example');
    expect(message.text).toContain('25.00 USD');
    expect(message.html).toContain('<strong>ORD-000001</strong>');
  });
});
