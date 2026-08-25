import { describe, expect, it } from 'vitest';
import { ORDERS_CREATE_SUBJECT, PlaceOrderCommand, PlaceOrderHandler } from './place-order.command';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';
import { newIssuedOrderWindow } from '../../test-support/fake-issued-order-window';
import type { PlaceOrderRequest } from '@otc/contracts';

const request: PlaceOrderRequest = {
  retailerCode: 'CarrefourEs',
  companyCode: 'IBERFOODS',
  currency: 'EUR',
  lines: [{ productCode: 'PRD-0001', quantity: 5 }],
};

describe('PlaceOrderHandler', () => {
  it('R13 — translates to orders.create and always answers projectionPending:true (R55)', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(ORDERS_CREATE_SUBJECT, {
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 124950,
      initialDiscount: 0,
      totalAmount: 124950,
      orderDate: '2026-08-18T10:15:00.000Z',
    });
    const handler = new PlaceOrderHandler(rpc, newIssuedOrderWindow());

    const result = await handler.execute(new PlaceOrderCommand(request, undefined));

    expect(result).toEqual({
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 124950,
      initialDiscount: 0,
      totalAmount: 124950,
      orderDate: '2026-08-18T10:15:00.000Z',
      projectionPending: true,
    });
  });

  it('an Idempotency-Key becomes the orders.create payload requestId, never the RPC header alone', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(ORDERS_CREATE_SUBJECT, {
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      status: 'placed',
      currency: 'EUR',
      totalAmount: 124950,
      orderDate: '2026-08-18T10:15:00.000Z',
    });
    const handler = new PlaceOrderHandler(rpc, newIssuedOrderWindow());
    const idempotencyKey = '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

    await handler.execute(new PlaceOrderCommand(request, idempotencyKey));

    expect(rpc.calls[0]?.subject).toBe(ORDERS_CREATE_SUBJECT);
    expect((rpc.calls[0]?.payload as { requestId?: string }).requestId).toBe(idempotencyKey);
  });

  it('F3 — records the newly-issued orderId in the IssuedOrderWindow, so GET /orders/{id} can answer 202 rather than a false 404', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(ORDERS_CREATE_SUBJECT, {
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      status: 'placed',
      currency: 'EUR',
      totalAmount: 124950,
      orderDate: '2026-08-18T10:15:00.000Z',
    });
    const issuedOrders = newIssuedOrderWindow();
    const handler = new PlaceOrderHandler(rpc, issuedOrders);

    await handler.execute(new PlaceOrderCommand(request, undefined));

    expect(issuedOrders.isRecentlyIssued('order-1')).toBe(true);
    expect(issuedOrders.isRecentlyIssued('some-other-order')).toBe(false);
  });

  it('the order is not yet known, so correlationId is a fresh gateway request id, not the eventual orderId', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(ORDERS_CREATE_SUBJECT, {
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      status: 'placed',
      currency: 'EUR',
      totalAmount: 124950,
      orderDate: '2026-08-18T10:15:00.000Z',
    });
    const handler = new PlaceOrderHandler(rpc, newIssuedOrderWindow());

    await handler.execute(new PlaceOrderCommand(request, undefined));

    expect(rpc.calls[0]?.meta.correlationId).not.toBe('order-1');
  });
});
