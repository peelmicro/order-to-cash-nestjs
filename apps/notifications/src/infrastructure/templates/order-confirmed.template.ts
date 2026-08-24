import type { Envelope, OrderConfirmedPayload } from '@otc/contracts';
import type { NotificationMessage } from '../../application/ports/notification-sender.port';
import { escapeHtml, formatMoney, recipientFor, subjectWithCorrelationId } from './notification-format';

export function buildOrderConfirmedMessage(envelope: Envelope): NotificationMessage {
  const payload = envelope.payload as OrderConfirmedPayload;
  const total = formatMoney(payload.totalAmount, payload.currency);

  const subject = subjectWithCorrelationId(`Order ${payload.orderReference} confirmed`, envelope.correlationId);
  const text = [
    `Order ${payload.orderReference} has been confirmed — stock reserved and credit approved.`,
    `Retailer: ${payload.retailerCode}`,
    `Company: ${payload.companyCode}`,
    `Total: ${total}`,
    `Confirmed at: ${payload.confirmedAt}`,
    `Correlation id: ${envelope.correlationId}`,
  ].join('\n');
  // N9 — see order-placed.template.ts's comment: every payload-derived
  // string is escaped before landing in HTML.
  const html = [
    `<p>Order <strong>${escapeHtml(payload.orderReference)}</strong> has been confirmed — stock reserved and credit approved.</p>`,
    '<ul>',
    `<li>Retailer: ${escapeHtml(payload.retailerCode)}</li>`,
    `<li>Company: ${escapeHtml(payload.companyCode)}</li>`,
    `<li>Total: ${escapeHtml(total)}</li>`,
    `<li>Confirmed at: ${escapeHtml(payload.confirmedAt)}</li>`,
    '</ul>',
    `<p>Correlation id: ${escapeHtml(envelope.correlationId)}</p>`,
  ].join('\n');

  return { to: recipientFor(payload.retailerCode), subject, text, html };
}
