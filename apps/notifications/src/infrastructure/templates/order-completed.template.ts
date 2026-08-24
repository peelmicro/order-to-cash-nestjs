import type { Envelope, OrderCompletedPayload } from '@otc/contracts';
import type { NotificationMessage } from '../../application/ports/notification-sender.port';
import { escapeHtml, formatMoney, recipientFor, subjectWithCorrelationId } from './notification-format';

export function buildOrderCompletedMessage(envelope: Envelope): NotificationMessage {
  const payload = envelope.payload as OrderCompletedPayload;
  const total = formatMoney(payload.totalAmount, payload.currency);

  const subject = subjectWithCorrelationId(`Order ${payload.orderReference} completed`, envelope.correlationId);
  const text = [
    `Order ${payload.orderReference} is complete — despatched, invoiced and paid.`,
    `Retailer: ${payload.retailerCode}`,
    `Company: ${payload.companyCode}`,
    `Total: ${total}`,
    `Completed at: ${payload.completedAt}`,
    `Correlation id: ${envelope.correlationId}`,
  ].join('\n');
  // N9 — see order-placed.template.ts's comment: every payload-derived
  // string is escaped before landing in HTML.
  const html = [
    `<p>Order <strong>${escapeHtml(payload.orderReference)}</strong> is complete — despatched, invoiced and paid.</p>`,
    '<ul>',
    `<li>Retailer: ${escapeHtml(payload.retailerCode)}</li>`,
    `<li>Company: ${escapeHtml(payload.companyCode)}</li>`,
    `<li>Total: ${escapeHtml(total)}</li>`,
    `<li>Completed at: ${escapeHtml(payload.completedAt)}</li>`,
    '</ul>',
    `<p>Correlation id: ${escapeHtml(envelope.correlationId)}</p>`,
  ].join('\n');

  return { to: recipientFor(payload.retailerCode), subject, text, html };
}
