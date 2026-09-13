// Pure unit — a faked `CancelOrderHandler`, no NestJS bootstrap, no NATS, no
// database. Proves the controller never throws and maps every
// `CancelOrderResult` outcome onto the exact `OrdersCancelReplyPayload | RpcError`
// wire shape asyncapi.yaml's `ordersCancelReply` channel names, in
// particular that `not_cancellable` maps to `ORDER_NOT_CANCELLABLE` (never a
// transport-level failure), and that `compensation_pending` from the
// `credit_approved`/`confirmed` branch carries `compensationPlanned:
// ['stock_release', 'credit_release']` — SA-4's release order (stock, the
// contested resource, first), preserved verbatim onto the wire.
import { describe, expect, it } from 'vitest';
import type { NatsContext } from '@nestjs/microservices';
import type { CancelOrderCommand, CancelOrderHandler, CancelOrderResult } from '../application/cancel-order.handler';
import { OrdersCancelController } from './orders-cancel.controller';

const FIXTURE_ORDER_ID = '11111111-1111-4111-8111-111111111111';

function fakeNatsContext(): NatsContext {
  return { getHeaders: () => undefined } as unknown as NatsContext;
}

function fakeHandler(execute: (command: CancelOrderCommand) => Promise<CancelOrderResult>): CancelOrderHandler {
  return { execute } as unknown as CancelOrderHandler;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { orderId: FIXTURE_ORDER_ID, reason: 'operator_cancelled', ...overrides };
}

describe('OrdersCancelController — orders.cancel', () => {
  it('rejects an invalid payload with VALIDATION_FAILED, never touching the handler', async () => {
    let called = false;
    const controller = new OrdersCancelController(
      fakeHandler(async () => {
        called = true;
        return { outcome: 'not_found' };
      }),
    );

    const reply = await controller.cancel({ reason: 'operator_cancelled' }, fakeNatsContext());

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(called).toBe(false);
  });

  it('rejects a reason other than operator_cancelled — R8/asyncapi.yaml: "the only reason a caller may request"', async () => {
    const controller = new OrdersCancelController(fakeHandler(async () => ({ outcome: 'not_found' })));

    const reply = await controller.cancel(validPayload({ reason: 'credit_rejected' }), fakeNatsContext());

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('maps not_found to NOT_FOUND', async () => {
    const controller = new OrdersCancelController(fakeHandler(async () => ({ outcome: 'not_found' })));

    const reply = await controller.cancel(validPayload(), fakeNatsContext());

    expect(reply).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps not_cancellable to ORDER_NOT_CANCELLABLE — a legitimate business rejection, not a transport error', async () => {
    const controller = new OrdersCancelController(
      fakeHandler(async () => ({
        outcome: 'not_cancellable',
        orderId: FIXTURE_ORDER_ID,
        orderReference: 'ORD-000007',
        status: 'despatched',
      })),
    );

    const reply = await controller.cancel(validPayload(), fakeNatsContext());

    expect(reply).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', details: { status: 'despatched' } });
  });

  it('maps compensation_pending from the credit_approved/confirmed branch to a success reply carrying compensationPlanned: [stock_release, credit_release] — SA-4\'s order, preserved verbatim onto the wire', async () => {
    const controller = new OrdersCancelController(
      fakeHandler(async () => ({
        outcome: 'compensation_pending',
        orderId: FIXTURE_ORDER_ID,
        orderReference: 'ORD-000007',
        status: 'confirmed',
        compensationPlanned: ['stock_release', 'credit_release'],
      })),
    );

    const reply = await controller.cancel(validPayload(), fakeNatsContext());

    expect(reply).toMatchObject({
      orderId: FIXTURE_ORDER_ID,
      orderReference: 'ORD-000007',
      status: 'confirmed',
      compensationPlanned: ['stock_release', 'credit_release'],
    });
    // The sequence, not the set: a controller that sorted, reversed or
    // rebuilt this array would still satisfy a membership check.
    expect((reply as { compensationPlanned: readonly string[] }).compensationPlanned[0]).toBe('stock_release');
    expect(reply).not.toHaveProperty('cancellationReason');
  });

  it('maps compensation_pending to a success reply carrying compensationPlanned, no cancellationReason yet', async () => {
    const controller = new OrdersCancelController(
      fakeHandler(async () => ({
        outcome: 'compensation_pending',
        orderId: FIXTURE_ORDER_ID,
        orderReference: 'ORD-000007',
        status: 'stock_reserved',
        compensationPlanned: ['stock_release'],
      })),
    );

    const reply = await controller.cancel(validPayload(), fakeNatsContext());

    expect(reply).toMatchObject({
      orderId: FIXTURE_ORDER_ID,
      orderReference: 'ORD-000007',
      status: 'stock_reserved',
      compensationPlanned: ['stock_release'],
    });
    expect(reply).not.toHaveProperty('cancellationReason');
  });

  it('maps cancelled to a success reply carrying cancellationReason and an empty compensationPlanned', async () => {
    const controller = new OrdersCancelController(
      fakeHandler(async () => ({
        outcome: 'cancelled',
        orderId: FIXTURE_ORDER_ID,
        orderReference: 'ORD-000007',
        status: 'cancelled',
        cancellationReason: 'operator_cancelled',
      })),
    );

    const reply = await controller.cancel(validPayload(), fakeNatsContext());

    expect(reply).toMatchObject({
      orderId: FIXTURE_ORDER_ID,
      orderReference: 'ORD-000007',
      status: 'cancelled',
      cancellationReason: 'operator_cancelled',
      compensationPlanned: [],
    });
  });
});
