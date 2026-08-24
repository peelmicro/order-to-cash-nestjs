import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@otc/contracts';
import { NotificationDispatchService } from '../notification-dispatch.service';
import { buildInvoiceIssuedMessage } from '../../infrastructure/templates/invoice-issued.template';
import { buildOrderCancelledMessage } from '../../infrastructure/templates/order-cancelled.template';
import { buildOrderCompletedMessage } from '../../infrastructure/templates/order-completed.template';
import { buildOrderConfirmedMessage } from '../../infrastructure/templates/order-confirmed.template';
import { buildOrderDespatchedMessage } from '../../infrastructure/templates/order-despatched.template';
import { buildOrderPlacedMessage } from '../../infrastructure/templates/order-placed.template';
import { buildPaymentReceivedMessage } from '../../infrastructure/templates/payment-received.template';
import {
  NotifyInvoiceIssuedCommand,
  NotifyOrderCancelledCommand,
  NotifyOrderCompletedCommand,
  NotifyOrderConfirmedCommand,
  NotifyOrderDespatchedCommand,
  NotifyOrderPlacedCommand,
  NotifyPaymentReceivedCommand,
} from './notify.commands';
import {
  NotifyInvoiceIssuedHandler,
  NotifyOrderCancelledHandler,
  NotifyOrderCompletedHandler,
  NotifyOrderConfirmedHandler,
  NotifyOrderDespatchedHandler,
  NotifyOrderPlacedHandler,
  NotifyPaymentReceivedHandler,
} from './notify.command-handlers';

const ENVELOPE: Envelope = {
  eventId: 'event-1',
  eventType: 'irrelevant-for-this-fixture',
  aggregateId: 'aggregate-1',
  correlationId: 'order-1',
  causationId: 'cause-1',
  occurredAt: '2026-08-24T10:00:00.000Z',
  payload: {},
};

function fakeDispatcher(): { dispatcher: NotificationDispatchService; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn().mockResolvedValue('processed');
  return { dispatcher: { dispatch } as unknown as NotificationDispatchService, dispatch };
}

// Seven fact-emission guards — NS1..NS7 — each proves the handler still
// delegates to NotificationDispatchService.dispatch with the fact's OWN
// template builder. Per CLAUDE.md's testing conventions, at least three of
// these were armed (the `dispatcher.dispatch(...)` call physically deleted
// from the handler, suite re-run, verbatim failure recorded) — see
// progress/impl_notifications_service.md.
describe('notify.command-handlers — NS1..NS7', () => {
  it('NS1 — NotifyOrderPlacedHandler dispatches order.placed.v1 with buildOrderPlacedMessage', async () => {
    const { dispatcher, dispatch } = fakeDispatcher();
    const handler = new NotifyOrderPlacedHandler(dispatcher);

    await handler.execute(new NotifyOrderPlacedCommand(ENVELOPE));

    expect(dispatch).toHaveBeenCalledWith(ENVELOPE, buildOrderPlacedMessage);
  });

  it('NS2 — NotifyOrderConfirmedHandler dispatches order.confirmed.v1 with buildOrderConfirmedMessage', async () => {
    const { dispatcher, dispatch } = fakeDispatcher();
    const handler = new NotifyOrderConfirmedHandler(dispatcher);

    await handler.execute(new NotifyOrderConfirmedCommand(ENVELOPE));

    expect(dispatch).toHaveBeenCalledWith(ENVELOPE, buildOrderConfirmedMessage);
  });

  it('NS3 — NotifyOrderDespatchedHandler dispatches order.despatched.v1 with buildOrderDespatchedMessage', async () => {
    const { dispatcher, dispatch } = fakeDispatcher();
    const handler = new NotifyOrderDespatchedHandler(dispatcher);

    await handler.execute(new NotifyOrderDespatchedCommand(ENVELOPE));

    expect(dispatch).toHaveBeenCalledWith(ENVELOPE, buildOrderDespatchedMessage);
  });

  it('NS4 — NotifyInvoiceIssuedHandler dispatches invoice.issued.v1 with buildInvoiceIssuedMessage', async () => {
    const { dispatcher, dispatch } = fakeDispatcher();
    const handler = new NotifyInvoiceIssuedHandler(dispatcher);

    await handler.execute(new NotifyInvoiceIssuedCommand(ENVELOPE));

    expect(dispatch).toHaveBeenCalledWith(ENVELOPE, buildInvoiceIssuedMessage);
  });

  it('NS5 — NotifyPaymentReceivedHandler dispatches payment.received.v1 with buildPaymentReceivedMessage', async () => {
    const { dispatcher, dispatch } = fakeDispatcher();
    const handler = new NotifyPaymentReceivedHandler(dispatcher);

    await handler.execute(new NotifyPaymentReceivedCommand(ENVELOPE));

    expect(dispatch).toHaveBeenCalledWith(ENVELOPE, buildPaymentReceivedMessage);
  });

  it('NS6 — NotifyOrderCompletedHandler dispatches order.completed.v1 with buildOrderCompletedMessage', async () => {
    const { dispatcher, dispatch } = fakeDispatcher();
    const handler = new NotifyOrderCompletedHandler(dispatcher);

    await handler.execute(new NotifyOrderCompletedCommand(ENVELOPE));

    expect(dispatch).toHaveBeenCalledWith(ENVELOPE, buildOrderCompletedMessage);
  });

  it('NS7 — NotifyOrderCancelledHandler dispatches order.cancelled.v1 with buildOrderCancelledMessage', async () => {
    const { dispatcher, dispatch } = fakeDispatcher();
    const handler = new NotifyOrderCancelledHandler(dispatcher);

    await handler.execute(new NotifyOrderCancelledCommand(ENVELOPE));

    expect(dispatch).toHaveBeenCalledWith(ENVELOPE, buildOrderCancelledMessage);
  });
});
