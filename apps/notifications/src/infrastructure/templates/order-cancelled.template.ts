import type { Envelope, OrderCancelledPayload } from '@otc/contracts';
import type { NotificationMessage } from '../../application/ports/notification-sender.port';
import { escapeHtml, recipientFor, subjectWithCorrelationId } from './notification-format';

export function buildOrderCancelledMessage(envelope: Envelope): NotificationMessage {
  const payload = envelope.payload as OrderCancelledPayload;
  const compensationSummary =
    payload.compensationSteps.length === 0
      ? 'none'
      : payload.compensationSteps.map((step) => step.step).join(', ');

  const subject = subjectWithCorrelationId(`Order ${payload.orderReference} cancelled`, envelope.correlationId);
  const text = [
    `Order ${payload.orderReference} has been cancelled.`,
    `Reason: ${payload.cancellationReason}`,
    `Retailer: ${payload.retailerCode}`,
    `Company: ${payload.companyCode}`,
    `Cancelled at: ${payload.cancelledAt}`,
    `Compensation steps: ${compensationSummary}`,
    `Correlation id: ${envelope.correlationId}`,
  ].join('\n');
  // N9 — see order-placed.template.ts's comment: every payload-derived
  // string is escaped before landing in HTML.
  const html = [
    `<p>Order <strong>${escapeHtml(payload.orderReference)}</strong> has been cancelled.</p>`,
    '<ul>',
    `<li>Reason: ${escapeHtml(payload.cancellationReason)}</li>`,
    `<li>Retailer: ${escapeHtml(payload.retailerCode)}</li>`,
    `<li>Company: ${escapeHtml(payload.companyCode)}</li>`,
    `<li>Cancelled at: ${escapeHtml(payload.cancelledAt)}</li>`,
    `<li>Compensation steps: ${escapeHtml(compensationSummary)}</li>`,
    '</ul>',
    `<p>Correlation id: ${escapeHtml(envelope.correlationId)}</p>`,
  ].join('\n');

  return { to: recipientFor(payload.retailerCode), subject, text, html };
}
