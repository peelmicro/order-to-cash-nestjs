import { describe, expect, it } from 'vitest';
import type { OrderDespatchedPayload } from '@otc/contracts';
import { makeEnvelope } from '../../test-support/envelope-fixtures';
import { buildOrderDespatchedMessage } from './order-despatched.template';

const PAYLOAD: OrderDespatchedPayload = {
  orderReference: 'ORD-000001',
  despatchReference: 'DES-000001',
  despatchDate: '2026-08-24T11:00:00.000Z',
  companyCode: 'COMPANY01',
  retailerCode: 'RETAILER01',
  lines: [{ productCode: 'P1', units: 3 }],
};

// NS3 — order.despatched.v1's template.
describe('order-despatched.template — NS3', () => {
  it('builds a subject carrying the correlation id, and a body with the despatch reference and lines', () => {
    const envelope = makeEnvelope('order.despatched.v1', PAYLOAD, { correlationId: 'corr-42' });

    const message = buildOrderDespatchedMessage(envelope);

    expect(message.subject).toContain('DES-000001');
    expect(message.subject).toContain('correlationId: corr-42');
    expect(message.to).toBe('retailer01@retailer.order-to-cash.example');
    expect(message.text).toContain('P1 x3');
    expect(message.html).toContain('DES-000001');
  });
});
