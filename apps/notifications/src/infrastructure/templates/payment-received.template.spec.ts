import { describe, expect, it } from 'vitest';
import type { PaymentReceivedPayload } from '@otc/contracts';
import { makeEnvelope } from '../../test-support/envelope-fixtures';
import { buildPaymentReceivedMessage } from './payment-received.template';

const PAYLOAD: PaymentReceivedPayload = {
  orderReference: 'ORD-000001',
  invoiceReference: 'INV-000001',
  paymentReference: 'PAY-000001',
  currency: 'USD',
  amount: 3000,
  valueDate: '2026-08-24T13:00:00.000Z',
  source: 'robot',
};

// NS5 — payment.received.v1's template. PaymentReceivedPayload carries no
// retailerCode (contracts), so the recipient is synthesized from
// orderReference instead — see notification-format.ts's recipientFor doc.
describe('payment-received.template — NS5', () => {
  it('builds a subject carrying the correlation id, and a body with the payment reference and amount', () => {
    const envelope = makeEnvelope('payment.received.v1', PAYLOAD, { correlationId: 'corr-42' });

    const message = buildPaymentReceivedMessage(envelope);

    expect(message.subject).toContain('INV-000001');
    expect(message.subject).toContain('correlationId: corr-42');
    expect(message.to).toBe('ord-000001@retailer.order-to-cash.example');
    expect(message.text).toContain('PAY-000001');
    expect(message.text).toContain('30.00 USD');
    expect(message.html).toContain('<strong>PAY-000001</strong>');
  });

  // N9 — paymentReference is externally supplied on the remittance path
  // (feature 22); a malicious value must not inject markup into the HTML
  // body, but the plain text body has no markup to inject into.
  it('N9 — escapes an HTML-significant paymentReference in the HTML body, and leaves the plain text body verbatim', () => {
    const maliciousPaymentReference = `<img src=x onerror=alert(1)>&"'`;
    const envelope = makeEnvelope('payment.received.v1', { ...PAYLOAD, paymentReference: maliciousPaymentReference });

    const message = buildPaymentReceivedMessage(envelope);

    expect(message.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
    expect(message.text).toContain(maliciousPaymentReference);
  });
});
