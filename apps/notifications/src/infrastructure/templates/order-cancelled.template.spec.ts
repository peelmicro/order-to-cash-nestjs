import { describe, expect, it } from 'vitest';
import type { OrderCancelledPayload } from '@otc/contracts';
import { makeEnvelope } from '../../test-support/envelope-fixtures';
import { buildOrderCancelledMessage } from './order-cancelled.template';

const PAYLOAD: OrderCancelledPayload = {
  orderReference: 'ORD-000001',
  retailerCode: 'RETAILER01',
  companyCode: 'COMPANY01',
  cancellationReason: 'credit_rejected',
  cancelledAt: '2026-08-24T15:00:00.000Z',
  compensationSteps: [
    { step: 'stock_released', eventType: 'stock.released.v1', occurredAt: '2026-08-24T14:59:00.000Z' },
  ],
};

// NS7 — order.cancelled.v1's template.
describe('order-cancelled.template — NS7', () => {
  it('builds a subject carrying the correlation id, and a body with the reason and compensation steps', () => {
    const envelope = makeEnvelope('order.cancelled.v1', PAYLOAD, { correlationId: 'corr-42' });

    const message = buildOrderCancelledMessage(envelope);

    expect(message.subject).toContain('ORD-000001');
    expect(message.subject).toContain('correlationId: corr-42');
    expect(message.to).toBe('retailer01@retailer.order-to-cash.example');
    expect(message.text).toContain('credit_rejected');
    expect(message.text).toContain('stock_released');
    expect(message.html).toContain('<strong>ORD-000001</strong>');
  });

  it('renders "none" when compensationSteps is empty (stock_rejected — nothing was ever acquired)', () => {
    const envelope = makeEnvelope('order.cancelled.v1', { ...PAYLOAD, cancellationReason: 'stock_rejected', compensationSteps: [] });

    const message = buildOrderCancelledMessage(envelope);

    expect(message.text).toContain('Compensation steps: none');
  });
});
