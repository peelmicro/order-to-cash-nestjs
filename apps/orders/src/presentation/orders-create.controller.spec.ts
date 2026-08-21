// Pure unit — a faked `PlaceOrderHandler`, no NestJS bootstrap, no NATS, no
// database. Proves the controller never throws: every outcome resolves
// with a plain object discriminated by shape (`orderId`/`status` for
// success, `code` for an RpcError) — asyncapi.yaml's "success/error are two
// message shapes on the same reply channel" contract.
import { describe, expect, it, vi } from 'vitest';
import { StockCheckTimeoutError } from '../application/ports/stock-availability.port';
import { StockUnavailableError } from '../application/place-order.errors';
import type { PlaceOrderCommand, PlaceOrderHandler, PlaceOrderResult } from '../application/place-order.handler';
import { OrdersCreateController } from './orders-create.controller';

function validRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    currency: 'EUR',
    lines: [{ productCode: 'PRD-0001', quantity: 2 }],
    ...overrides,
  };
}

function fakeHandler(execute: (command: PlaceOrderCommand) => Promise<PlaceOrderResult>): PlaceOrderHandler {
  return { execute } as unknown as PlaceOrderHandler;
}

describe('OrdersCreateController — orders.create', () => {
  it('returns the order id synchronously on success', async () => {
    const handler = fakeHandler(async () => ({
      orderId: '11111111-1111-4111-8111-111111111111',
      orderReference: 'ORD-000007',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 2_000,
      initialDiscount: 0,
      totalAmount: 2_000,
      orderDate: '2026-08-21T10:00:00.000Z',
    }));
    const controller = new OrdersCreateController(handler);

    const reply = await controller.create(validRequestPayload());

    expect(reply).toMatchObject({
      orderId: '11111111-1111-4111-8111-111111111111',
      orderReference: 'ORD-000007',
      status: 'placed',
    });
  });

  // D1 regression (review_orders_acceptance.md): the reviewer's mutation
  // `totalAmount: result.initialAmount` survived the whole suite because no
  // fixture anywhere used a non-zero `initialDiscount`, so `totalAmount`
  // was indistinguishable from `initialAmount`. This fixture picks three
  // DIFFERENT values on purpose so any field-swap in the controller's
  // reply mapping (orders-create.controller.ts) fails.
  it('maps initialAmount, initialDiscount and totalAmount onto DISTINCT reply fields when the order carries a discount', async () => {
    const handler = fakeHandler(async () => ({
      orderId: '11111111-1111-4111-8111-111111111111',
      orderReference: 'ORD-000007',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 2_000,
      initialDiscount: 300,
      totalAmount: 1_700,
      orderDate: '2026-08-21T10:00:00.000Z',
    }));
    const controller = new OrdersCreateController(handler);

    const reply = await controller.create(validRequestPayload());

    expect(reply).toMatchObject({
      currency: 'EUR',
      initialAmount: 2_000,
      initialDiscount: 300,
      totalAmount: 1_700,
    });
    // The payable total must never equal the pre-discount amount here —
    // this is what a `totalAmount: result.initialAmount` mapping bug
    // would silently produce.
    expect((reply as { totalAmount: number }).totalAmount).not.toBe(
      (reply as { initialAmount: number }).initialAmount,
    );
  });

  it('returns a VALIDATION_FAILED RpcError, never throws, for a malformed request', async () => {
    const handler = fakeHandler(vi.fn());
    const controller = new OrdersCreateController(handler);

    const reply = await controller.create(validRequestPayload({ lines: [] }));

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns a STOCK_UNAVAILABLE RpcError, never throws, when the handler rejects on stock unavailability', async () => {
    const handler = fakeHandler(async () => {
      throw new StockUnavailableError([{ productCode: 'PRD-0001', requested: 2, available: 1, sufficient: false }]);
    });
    const controller = new OrdersCreateController(handler);

    const reply = await controller.create(validRequestPayload());

    expect(reply).toMatchObject({ code: 'STOCK_UNAVAILABLE' });
  });

  it('returns a TIMEOUT RpcError, never throws, when the stock check times out', async () => {
    const handler = fakeHandler(async () => {
      throw new StockCheckTimeoutError('fulfillment.stock.check', 5000);
    });
    const controller = new OrdersCreateController(handler);

    const reply = await controller.create(validRequestPayload());

    expect(reply).toMatchObject({ code: 'TIMEOUT' });
  });
});
