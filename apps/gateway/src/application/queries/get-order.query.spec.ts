import { describe, expect, it } from 'vitest';
import { GetOrderHandler, GetOrderQuery } from './get-order.query';
import { FakeOrderReadModel } from '../../test-support/fake-order-read-model';
import { newIssuedOrderWindow } from '../../test-support/fake-issued-order-window';
import type { OrderTimelineDocumentLike } from '../../domain/projection/order-read-model-mapper';

function doc(overrides: Partial<OrderTimelineDocumentLike> = {}): OrderTimelineDocumentLike {
  return {
    _id: 'order-1',
    orderId: 'order-1',
    orderReference: 'ORD-000042',
    orderDate: '2026-08-18T09:00:00.000Z',
    retailer: { code: 'CarrefourEs', name: 'Carrefour', gln: '8412345000013' },
    company: { code: 'IBERFOODS', name: 'Iberfoods', gln: '8412345000020' },
    status: 'placed',
    cancellationReason: null,
    currency: 'EUR',
    totals: { initialAmount: 100, initialDiscount: 0, totalAmount: 100 },
    items: [],
    references: { despatchReference: null, invoiceReference: null, paymentReference: null },
    events: [],
    headerComplete: true,
    updatedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

describe('GetOrderHandler', () => {
  it('R54 — returns kind:"found" with the mapped OrderDetail for a known order id', async () => {
    const readModel = new FakeOrderReadModel();
    readModel.documents.push(doc());
    const handler = new GetOrderHandler(readModel, newIssuedOrderWindow());

    const result = await handler.execute(new GetOrderQuery('order-1'));

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected kind:found');
    expect(result.detail.orderId).toBe('order-1');
    expect(result.detail.headerComplete).toBe(true);
  });

  it('R55/F3 — returns kind:"pending" when no document exists yet AND this gateway recently issued the id, letting the presentation layer answer 202', async () => {
    const readModel = new FakeOrderReadModel();
    const issuedOrders = newIssuedOrderWindow();
    issuedOrders.record('order-1');
    const handler = new GetOrderHandler(readModel, issuedOrders);

    const result = await handler.execute(new GetOrderQuery('order-1'));

    expect(result).toEqual({ kind: 'pending' });
  });

  it('F3 — returns kind:"unknown" when no document exists AND this gateway never issued the id, letting the presentation layer answer 404', async () => {
    const readModel = new FakeOrderReadModel();
    const handler = new GetOrderHandler(readModel, newIssuedOrderWindow());

    const result = await handler.execute(new GetOrderQuery('never-issued-order'));

    expect(result).toEqual({ kind: 'unknown' });
  });
});
