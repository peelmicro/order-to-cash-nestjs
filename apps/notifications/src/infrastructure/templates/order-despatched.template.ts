import type { Envelope, OrderDespatchedPayload } from '@otc/contracts';
import type { NotificationMessage } from '../../application/ports/notification-sender.port';
import { escapeHtml, recipientFor, subjectWithCorrelationId } from './notification-format';

export function buildOrderDespatchedMessage(envelope: Envelope): NotificationMessage {
  const payload = envelope.payload as OrderDespatchedPayload;
  const lineSummary = payload.lines.map((line) => `${line.productCode} x${line.units}`).join(', ');

  const subject = subjectWithCorrelationId(
    `Order ${payload.orderReference} despatched (${payload.despatchReference})`,
    envelope.correlationId,
  );
  const text = [
    `Order ${payload.orderReference} has been despatched.`,
    `Despatch reference: ${payload.despatchReference}`,
    `Despatch date: ${payload.despatchDate}`,
    `Retailer: ${payload.retailerCode}`,
    `Company: ${payload.companyCode}`,
    `Lines: ${lineSummary}`,
    `Correlation id: ${envelope.correlationId}`,
  ].join('\n');
  // N9 — see order-placed.template.ts's comment: every payload-derived
  // string is escaped before landing in HTML (lineSummary is built from
  // `productCode`s, also payload-derived).
  const html = [
    `<p>Order <strong>${escapeHtml(payload.orderReference)}</strong> has been despatched.</p>`,
    '<ul>',
    `<li>Despatch reference: ${escapeHtml(payload.despatchReference)}</li>`,
    `<li>Despatch date: ${escapeHtml(payload.despatchDate)}</li>`,
    `<li>Retailer: ${escapeHtml(payload.retailerCode)}</li>`,
    `<li>Company: ${escapeHtml(payload.companyCode)}</li>`,
    `<li>Lines: ${escapeHtml(lineSummary)}</li>`,
    '</ul>',
    `<p>Correlation id: ${escapeHtml(envelope.correlationId)}</p>`,
  ].join('\n');

  return { to: recipientFor(payload.retailerCode), subject, text, html };
}
