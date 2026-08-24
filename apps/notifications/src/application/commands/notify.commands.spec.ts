import { describe, expect, it } from 'vitest';
import {
  notifyCommandFor,
  NotifyInvoiceIssuedCommand,
  NotifyOrderCancelledCommand,
  NotifyOrderCompletedCommand,
  NotifyOrderConfirmedCommand,
  NotifyOrderDespatchedCommand,
  NotifyOrderPlacedCommand,
  NotifyPaymentReceivedCommand,
} from './notify.commands';

describe('notifyCommandFor', () => {
  it.each([
    ['order.placed.v1', NotifyOrderPlacedCommand],
    ['order.confirmed.v1', NotifyOrderConfirmedCommand],
    ['order.despatched.v1', NotifyOrderDespatchedCommand],
    ['invoice.issued.v1', NotifyInvoiceIssuedCommand],
    ['payment.received.v1', NotifyPaymentReceivedCommand],
    ['order.completed.v1', NotifyOrderCompletedCommand],
    ['order.cancelled.v1', NotifyOrderCancelledCommand],
  ] as const)('maps %s to its Command class', (eventType, expectedCtor) => {
    expect(notifyCommandFor(eventType)).toBe(expectedCtor);
  });

  it.each([
    'stock.reserved.v1',
    'stock.released.v1',
    'stock.rejected.v1',
    'credit.approved.v1',
    'credit.released.v1',
    'credit.rejected.v1',
  ])('returns undefined for the six facts this service does not notify on (%s)', (eventType) => {
    expect(notifyCommandFor(eventType)).toBeUndefined();
  });
});
