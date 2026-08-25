import { describe, expect, it } from 'vitest';
import { CancelOrderCommand, CancelOrderHandler, ORDERS_CANCEL_SUBJECT } from './cancel-order.command';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';

describe('CancelOrderHandler', () => {
  it('R27/R28 — translates to orders.cancel, correlationId is the KNOWN order id (not a fresh gateway id)', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(ORDERS_CANCEL_SUBJECT, {
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      status: 'stock_reserved',
      compensationPlanned: ['stock_release'],
    });
    const handler = new CancelOrderHandler(rpc);

    const result = await handler.execute(new CancelOrderCommand('order-1', 'demo cancel'));

    expect(rpc.calls[0]?.meta.correlationId).toBe('order-1');
    expect((rpc.calls[0]?.payload as { reason: string }).reason).toBe('operator_cancelled');
    expect(result).toEqual({
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      status: 'stock_reserved',
      cancellationReason: 'operator_cancelled',
      compensationPlanned: ['stock_release'],
    });
  });

  it('an order with nothing yet acquired plans no compensation', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(ORDERS_CANCEL_SUBJECT, { orderId: 'order-2', orderReference: 'ORD-000043', status: 'placed', compensationPlanned: [] });
    const handler = new CancelOrderHandler(rpc);

    const result = await handler.execute(new CancelOrderCommand('order-2', undefined));

    expect(result.compensationPlanned).toEqual([]);
  });
});
