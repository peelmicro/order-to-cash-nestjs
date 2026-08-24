import type { Envelope, PaymentReceivedPayload } from '@otc/contracts';
import type { NotificationMessage } from '../../application/ports/notification-sender.port';
import { escapeHtml, formatMoney, recipientFor, subjectWithCorrelationId } from './notification-format';

export function buildPaymentReceivedMessage(envelope: Envelope): NotificationMessage {
  const payload = envelope.payload as PaymentReceivedPayload;
  const amount = formatMoney(payload.amount, payload.currency);

  const subject = subjectWithCorrelationId(
    `Payment received for invoice ${payload.invoiceReference}`,
    envelope.correlationId,
  );
  const text = [
    `Payment ${payload.paymentReference} has been received for invoice ${payload.invoiceReference} (order ${payload.orderReference}).`,
    `Amount: ${amount}`,
    `Value date: ${payload.valueDate}`,
    `Source: ${payload.source}`,
    `Correlation id: ${envelope.correlationId}`,
  ].join('\n');
  // N9 — every payload-derived string is escaped before landing in HTML.
  // `paymentReference` is the field most worth this: unlike the other six
  // facts, the remittance path (feature 22) lets an EXTERNAL caller supply
  // it — this is the one template where an unescaped value is genuinely
  // reachable from outside the system, not merely internally produced.
  const html = [
    `<p>Payment <strong>${escapeHtml(payload.paymentReference)}</strong> has been received for invoice ${escapeHtml(payload.invoiceReference)} (order ${escapeHtml(payload.orderReference)}).</p>`,
    '<ul>',
    `<li>Amount: ${escapeHtml(amount)}</li>`,
    `<li>Value date: ${escapeHtml(payload.valueDate)}</li>`,
    `<li>Source: ${escapeHtml(payload.source)}</li>`,
    '</ul>',
    `<p>Correlation id: ${escapeHtml(envelope.correlationId)}</p>`,
  ].join('\n');

  // PaymentReceivedPayload carries no retailerCode (notification-format.ts's
  // recipientFor doc) — orderReference is the best available identifier.
  return { to: recipientFor(payload.orderReference), subject, text, html };
}
