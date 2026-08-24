import type { Envelope, OrderPlacedPayload } from '@otc/contracts';
import type { NotificationMessage } from '../../application/ports/notification-sender.port';
import { escapeHtml, formatMoney, recipientFor, subjectWithCorrelationId } from './notification-format';

export function buildOrderPlacedMessage(envelope: Envelope): NotificationMessage {
  const payload = envelope.payload as OrderPlacedPayload;
  const total = formatMoney(payload.totalAmount, payload.currency);

  const subject = subjectWithCorrelationId(`Order ${payload.orderReference} placed`, envelope.correlationId);
  const text = [
    `Order ${payload.orderReference} has been placed.`,
    `Retailer: ${payload.retailerCode}`,
    `Company: ${payload.companyCode}`,
    `Total: ${total}`,
    `Order date: ${payload.orderDate}`,
    `Correlation id: ${envelope.correlationId}`,
  ].join('\n');
  // N9 — every payload-derived string is escaped before landing in HTML
  // (notification-format.ts's escapeHtml doc); the plain text body above
  // needs no escaping, there is no markup to inject into.
  const html = [
    `<p>Order <strong>${escapeHtml(payload.orderReference)}</strong> has been placed.</p>`,
    '<ul>',
    `<li>Retailer: ${escapeHtml(payload.retailerCode)}</li>`,
    `<li>Company: ${escapeHtml(payload.companyCode)}</li>`,
    `<li>Total: ${escapeHtml(total)}</li>`,
    `<li>Order date: ${escapeHtml(payload.orderDate)}</li>`,
    '</ul>',
    `<p>Correlation id: ${escapeHtml(envelope.correlationId)}</p>`,
  ].join('\n');

  return { to: recipientFor(payload.retailerCode), subject, text, html };
}
