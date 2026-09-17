import { describe, expect, it } from 'vitest';
import { escapeHtml, formatMoney, recipientFor, subjectWithCorrelationId } from './notification-format';

describe('notification-format', () => {
  it('formats a positive minor-units amount, grouped, scaled by the currency exponent', () => {
    expect(formatMoney(124250, 'USD')).toBe('1 242.50 USD');
  });

  it('formats zero and pads a single-digit minor-units remainder', () => {
    expect(formatMoney(0, 'EUR')).toBe('0.00 EUR');
    expect(formatMoney(105, 'GBP')).toBe('1.05 GBP');
  });

  it('formats a negative amount with a leading sign, never a negative remainder', () => {
    expect(formatMoney(-150, 'USD')).toBe('-1.50 USD');
  });

  it('formats a 0-exponent currency with no decimal point', () => {
    expect(formatMoney(5000, 'JPY')).toBe('5 000 JPY');
  });

  it('formats a 3-exponent currency', () => {
    expect(formatMoney(12345, 'BHD')).toBe('12.345 BHD');
  });

  it('synthesizes a deterministic, lower-cased recipient address from an identifier', () => {
    expect(recipientFor('RETAILER01')).toBe('retailer01@retailer.order-to-cash.example');
  });

  it('embeds the correlation id in the subject line', () => {
    expect(subjectWithCorrelationId('Order ORD-000001 placed', 'corr-123')).toBe(
      '[order-to-cash] Order ORD-000001 placed (correlationId: corr-123)',
    );
  });

  // N9 — every payload-derived string that lands in HTML must be escaped.
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`Tom & Jerry's "quote"`)).toBe('Tom &amp; Jerry&#39;s &quot;quote&quot;');
  });

  it('leaves an ordinary business reference unchanged', () => {
    expect(escapeHtml('PAY-000001')).toBe('PAY-000001');
  });
});
