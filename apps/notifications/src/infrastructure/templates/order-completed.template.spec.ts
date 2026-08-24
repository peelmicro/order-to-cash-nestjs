import { describe, expect, it } from 'vitest';
import type { OrderCompletedPayload } from '@otc/contracts';
import { makeEnvelope } from '../../test-support/envelope-fixtures';
import { buildOrderCompletedMessage } from './order-completed.template';

const PAYLOAD: OrderCompletedPayload = {
  orderReference: 'ORD-000001',
  retailerCode: 'RETAILER01',
  companyCode: 'COMPANY01',
  currency: 'USD',
  totalAmount: 3000,
  completedAt: '2026-08-24T14:00:00.000Z',
};

// NS6 — order.completed.v1's template.
describe('order-completed.template — NS6', () => {
  it('builds a subject carrying the correlation id, and a body with the order reference and total', () => {
    const envelope = makeEnvelope('order.completed.v1', PAYLOAD, { correlationId: 'corr-42' });

    const message = buildOrderCompletedMessage(envelope);

    expect(message.subject).toContain('ORD-000001');
    expect(message.subject).toContain('correlationId: corr-42');
    expect(message.to).toBe('retailer01@retailer.order-to-cash.example');
    expect(message.text).toContain('30.00 USD');
    expect(message.html).toContain('<strong>ORD-000001</strong>');
  });
});
