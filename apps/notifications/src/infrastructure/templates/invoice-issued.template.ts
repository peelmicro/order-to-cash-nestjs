import type { Envelope, InvoiceIssuedPayload } from '@otc/contracts';
import type { NotificationMessage } from '../../application/ports/notification-sender.port';
import { escapeHtml, formatMoney, recipientFor, subjectWithCorrelationId } from './notification-format';

export function buildInvoiceIssuedMessage(envelope: Envelope): NotificationMessage {
  const payload = envelope.payload as InvoiceIssuedPayload;
  const total = formatMoney(payload.totalAmount, payload.currency);

  const subject = subjectWithCorrelationId(`Invoice ${payload.invoiceReference} issued`, envelope.correlationId);
  const text = [
    `Invoice ${payload.invoiceReference} has been issued for order ${payload.orderReference}.`,
    `Retailer: ${payload.retailerCode}`,
    `Company: ${payload.companyCode}`,
    `Total: ${total}`,
    `Invoice date: ${payload.invoiceDate}`,
    `Correlation id: ${envelope.correlationId}`,
  ].join('\n');
  // N9 — see order-placed.template.ts's comment: every payload-derived
  // string is escaped before landing in HTML.
  const html = [
    `<p>Invoice <strong>${escapeHtml(payload.invoiceReference)}</strong> has been issued for order ${escapeHtml(payload.orderReference)}.</p>`,
    '<ul>',
    `<li>Retailer: ${escapeHtml(payload.retailerCode)}</li>`,
    `<li>Company: ${escapeHtml(payload.companyCode)}</li>`,
    `<li>Total: ${escapeHtml(total)}</li>`,
    `<li>Invoice date: ${escapeHtml(payload.invoiceDate)}</li>`,
    '</ul>',
    `<p>Correlation id: ${escapeHtml(envelope.correlationId)}</p>`,
  ].join('\n');

  return { to: recipientFor(payload.retailerCode), subject, text, html };
}
