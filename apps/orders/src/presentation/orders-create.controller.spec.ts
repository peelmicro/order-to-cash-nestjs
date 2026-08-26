// Pure unit — a faked `PlaceOrderHandler`, no NestJS bootstrap, no NATS, no
// database. Proves the controller never throws: every outcome resolves
// with a plain object discriminated by shape (`orderId`/`status` for
// success, `code` for an RpcError) — asyncapi.yaml's "success/error are two
// message shapes on the same reply channel" contract.
import { describe, expect, it, vi } from 'vitest';
import type { NatsContext } from '@nestjs/microservices';
import { headers as natsHeaders } from 'nats';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { StockCheckTimeoutError } from '../application/ports/stock-availability.port';
import { injectNatsTraceContext, tracer } from '../infrastructure/observability/trace-context';
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

// A5 (observability_reliability, R57/OR4): `create` now extracts a trace
// context from the inbound NATS message's headers — a no-headers fake is
// enough for every case in this file, which is about the reply SHAPE, not
// trace propagation (that is trace-context.spec.ts's/the integration
// spec's own job).
function fakeNatsContext(): NatsContext {
  return { getHeaders: () => undefined } as unknown as NatsContext;
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

    const reply = await controller.create(validRequestPayload(), fakeNatsContext());

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

    const reply = await controller.create(validRequestPayload(), fakeNatsContext());

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

    const reply = await controller.create(validRequestPayload({ lines: [] }), fakeNatsContext());

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns a STOCK_UNAVAILABLE RpcError, never throws, when the handler rejects on stock unavailability', async () => {
    const handler = fakeHandler(async () => {
      throw new StockUnavailableError([{ productCode: 'PRD-0001', requested: 2, available: 1, sufficient: false }]);
    });
    const controller = new OrdersCreateController(handler);

    const reply = await controller.create(validRequestPayload(), fakeNatsContext());

    expect(reply).toMatchObject({ code: 'STOCK_UNAVAILABLE' });
  });

  it('returns a TIMEOUT RpcError, never throws, when the stock check times out', async () => {
    const handler = fakeHandler(async () => {
      throw new StockCheckTimeoutError('fulfillment.stock.check', 5000);
    });
    const controller = new OrdersCreateController(handler);

    const reply = await controller.create(validRequestPayload(), fakeNatsContext());

    expect(reply).toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('OrdersCreateController — trace propagation (OR4, R57, design.md §4.3)', () => {
  it('extracts the inbound request\'s trace context and CONTINUES it (same real traceId) while executing PlaceOrderHandler, rather than starting fresh', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const contextManager = new AsyncLocalStorageContextManager();
    provider.register({ contextManager, propagator: new W3CTraceContextPropagator() });

    try {
      const callerSpan = tracer().startSpan('test-gateway-rpc-client-span');
      const { traceId: callerTraceId } = callerSpan.spanContext();
      const headers = natsHeaders();
      context.with(trace.setSpan(context.active(), callerSpan), () => {
        injectNatsTraceContext(headers);
      });
      callerSpan.end();

      let observedTraceId: string | undefined;
      const handler = fakeHandler(async () => {
        observedTraceId = trace.getActiveSpan()?.spanContext().traceId;
        return {
          orderId: '11111111-1111-4111-8111-111111111111',
          orderReference: 'ORD-000007',
          status: 'placed',
          currency: 'EUR',
          initialAmount: 2_000,
          initialDiscount: 0,
          totalAmount: 2_000,
          orderDate: '2026-08-21T10:00:00.000Z',
        };
      });
      const controller = new OrdersCreateController(handler);
      const natsContext = { getHeaders: () => headers } as unknown as NatsContext;

      await controller.create(validRequestPayload(), natsContext);

      expect(observedTraceId).toBeDefined();
      expect(observedTraceId).toBe(callerTraceId);
      expect(observedTraceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      contextManager.disable();
      await provider.shutdown();
    }
  });
});
