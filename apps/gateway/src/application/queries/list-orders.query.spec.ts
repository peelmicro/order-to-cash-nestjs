import { describe, expect, it } from 'vitest';
import { ListOrdersHandler, ListOrdersQuery } from './list-orders.query';
import { FakeOrderReadModel } from '../../test-support/fake-order-read-model';
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

describe('ListOrdersHandler', () => {
  it('R54 — reads exclusively from the OrderReadModel port, never an RPC call', async () => {
    const readModel = new FakeOrderReadModel();
    readModel.documents.push(doc());
    const handler = new ListOrdersHandler(readModel);

    const result = await handler.execute(new ListOrdersQuery({ page: 1, pageSize: 25 }));

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.orderReference).toBe('ORD-000042');
    expect(result.page).toEqual({ page: 1, pageSize: 25, total: 1 });
  });

  it('R53 — a placeholder document (no orderReference) is silently excluded from the list, not emitted half-filled', async () => {
    const readModel = new FakeOrderReadModel();
    readModel.documents.push(doc({ orderReference: null, orderDate: null, currency: null, headerComplete: false }));
    const handler = new ListOrdersHandler(readModel);

    const result = await handler.execute(new ListOrdersQuery({ page: 1, pageSize: 25 }));

    expect(result.items).toHaveLength(0);
  });
});
