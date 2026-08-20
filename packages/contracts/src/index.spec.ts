import { describe, expect, it } from 'vitest';
import type {
  Envelope,
  OrderPlacedEvent,
  StockReservedEvent,
  CreditApprovedEvent,
  OrdersCreateRequestPayload,
  OrdersCreateReplyPayload,
  PlaceOrderResponse,
  OrderDetail,
  Problem,
} from './index.js';

/**
 * "Test" here means what the task asks for: representative literal values
 * that satisfy the generated types. If a regeneration narrows, widens or
 * renames a field these assignments fail to compile — caught by
 * `pnpm --filter @otc/contracts run typecheck` (and by `pnpm typecheck` at
 * the root) — which is the real assertion. The `expect(...)` calls below are
 * the "couple of runtime-shape assertions" the task also asks for, checking
 * that the same literal actually carries the fields a consumer will read.
 */
describe('@otc/contracts — representative usage compiles and shapes hold', () => {
  it('accepts a well-formed Envelope', () => {
    const envelope: Envelope = {
      eventId: '5b7a0f1e-1f22-4c1f-9f2a-8c1a1f2b3c4d',
      eventType: 'order.placed.v1',
      aggregateId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      correlationId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      causationId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      occurredAt: '2026-08-18T10:15:00.000Z',
      payload: {},
    };

    expect(envelope.correlationId).toBe(envelope.aggregateId);
  });

  it('accepts one fact payload per fact topic — orders, fulfillment, billing', () => {
    const orderPlaced: OrderPlacedEvent = {
      eventId: '5b7a0f1e-1f22-4c1f-9f2a-8c1a1f2b3c4d',
      eventType: 'order.placed.v1',
      aggregateId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      correlationId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      causationId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      occurredAt: '2026-08-18T10:15:00.000Z',
      payload: {
        orderReference: 'ORD-000042',
        retailerCode: 'CarrefourEs',
        companyCode: 'IBERFOODS',
        buyerGln: '8412345000013',
        supplierGln: '8400000000017',
        currency: 'EUR',
        orderDate: '2026-08-18T10:15:00.000Z',
        lines: [{ productCode: 'PRD-0001', quantity: 5, unitPrice: 2995, lineDiscount: 0 }],
        initialAmount: 14975,
        initialDiscount: 0,
        totalAmount: 14975,
      },
    };

    const stockReserved: StockReservedEvent = {
      eventId: 'a1b2c3d4-1f22-4c1f-9f2a-8c1a1f2b3c4d',
      eventType: 'stock.reserved.v1',
      aggregateId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      correlationId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      causationId: '5b7a0f1e-1f22-4c1f-9f2a-8c1a1f2b3c4d',
      occurredAt: '2026-08-18T10:15:02.000Z',
      payload: {
        orderReference: 'ORD-000042',
        companyCode: 'IBERFOODS',
        retailerCode: 'CarrefourEs',
        reservations: [
          {
            reservationId: 'b2c3d4e5-1f22-4c1f-9f2a-8c1a1f2b3c4d',
            productCode: 'PRD-0001',
            units: 5,
          },
        ],
      },
    };

    const creditApproved: CreditApprovedEvent = {
      eventId: 'c3d4e5f6-1f22-4c1f-9f2a-8c1a1f2b3c4d',
      eventType: 'credit.approved.v1',
      aggregateId: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
      correlationId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      causationId: 'a1b2c3d4-1f22-4c1f-9f2a-8c1a1f2b3c4d',
      occurredAt: '2026-08-18T10:15:03.000Z',
      payload: {
        orderReference: 'ORD-000042',
        retailerCode: 'CarrefourEs',
        companyCode: 'IBERFOODS',
        creditCode: 'CR-000004',
        currency: 'EUR',
        heldAmount: 14975,
        availableCreditAfter: 485025,
      },
    };

    expect(orderPlaced.eventType).toBe('order.placed.v1');
    expect(stockReserved.payload?.reservations).toHaveLength(1);
    expect(creditApproved.payload?.heldAmount).toBe(14975);
  });

  it('accepts one RPC request/reply pair — orders.create', () => {
    const request: OrdersCreateRequestPayload = {
      retailerCode: 'CarrefourEs',
      companyCode: 'IBERFOODS',
      currency: 'EUR',
      lines: [{ productCode: 'PRD-0001', quantity: 5 }],
    };

    const reply: OrdersCreateReplyPayload = {
      orderId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      orderReference: 'ORD-000042',
      status: 'placed',
      currency: 'EUR',
      initialAmount: 14975,
      initialDiscount: 0,
      totalAmount: 14975,
      orderDate: '2026-08-18T10:15:00.000Z',
    };

    expect(reply.orderReference).toMatch(/^ORD-\d{6,}$/);
    expect(request.lines[0]?.productCode).toBe('PRD-0001');
  });

  it('accepts one REST response from the OpenAPI contract', () => {
    const placed: PlaceOrderResponse = {
      orderId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      orderReference: 'ORD-000042',
      status: 'placed',
      currency: 'EUR',
      totalAmount: 14975,
      orderDate: '2026-08-18T10:15:00.000Z',
    };

    const detail: OrderDetail = {
      orderId: '9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      status: 'placed',
      events: [],
      updatedAt: '2026-08-18T10:15:00.000Z',
    };

    const problem: Problem = {
      type: 'about:blank',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
    };

    expect(placed.status).toBe('placed');
    expect(detail.events).toEqual([]);
    expect(problem.status).toBe(400);
  });
});
