import { describe, expect, it } from 'vitest';
import { toOrderDetail, toOrderSummary, type OrderTimelineDocumentLike } from './order-read-model-mapper';

function completeDoc(overrides: Partial<OrderTimelineDocumentLike> = {}): OrderTimelineDocumentLike {
  return {
    _id: 'order-1',
    orderId: 'order-1',
    orderReference: 'ORD-000042',
    orderDate: '2026-08-18T10:15:00.000Z',
    retailer: { code: 'CarrefourEs', name: 'Carrefour ES', gln: '8412345000013' },
    company: { code: 'IBERFOODS', name: 'Iberfoods', gln: '8412345000020' },
    status: 'placed',
    cancellationReason: null,
    currency: 'EUR',
    totals: { initialAmount: 130000, initialDiscount: 5750, totalAmount: 124250 },
    items: [{ productCode: 'PRD-0001', quantity: 5, unitPrice: 24999, lineDiscount: 0 }],
    references: { despatchReference: null, invoiceReference: null, paymentReference: null },
    events: [{ eventId: 'evt-1', eventType: 'order.placed.v1', occurredAt: '2026-08-18T10:15:00.000Z', summary: 'Order placed' }],
    headerComplete: true,
    updatedAt: '2026-08-18T10:15:00.000Z',
    ...overrides,
  };
}

describe('toOrderSummary', () => {
  it('R54 — projects a complete document to the OrderSummary wire shape', () => {
    const summary = toOrderSummary(completeDoc());
    expect(summary).toEqual({
      orderId: 'order-1',
      orderReference: 'ORD-000042',
      orderDate: '2026-08-18T10:15:00.000Z',
      retailer: { code: 'CarrefourEs', name: 'Carrefour ES', gln: '8412345000013' },
      company: { code: 'IBERFOODS', name: 'Iberfoods', gln: '8412345000020' },
      status: 'placed',
      cancellationReason: null,
      currency: 'EUR',
      totals: { initialAmount: 130000, initialDiscount: 5750, totalAmount: 124250 },
      updatedAt: '2026-08-18T10:15:00.000Z',
    });
  });

  it('R53/R54 — returns null for a placeholder document (no orderReference yet), never a half-filled row', () => {
    const placeholder = completeDoc({ orderReference: null, orderDate: null, currency: null, headerComplete: false });
    expect(toOrderSummary(placeholder)).toBeNull();
  });

  it('preserves a non-null cancellationReason', () => {
    const cancelled = completeDoc({ status: 'cancelled', cancellationReason: 'operator_cancelled' });
    expect(toOrderSummary(cancelled)?.cancellationReason).toBe('operator_cancelled');
  });
});

describe('toOrderDetail', () => {
  it('R54 — projects a complete document to the OrderDetail wire shape, including the full timeline', () => {
    const detail = toOrderDetail(completeDoc());
    expect(detail.orderId).toBe('order-1');
    expect(detail.headerComplete).toBe(true);
    expect(detail.events).toHaveLength(1);
    expect(detail.totals).toEqual({ initialAmount: 130000, initialDiscount: 5750, totalAmount: 124250 });
  });

  it('R53 — a placeholder document is returned with headerComplete:false and null header fields, timeline intact', () => {
    const placeholder = completeDoc({
      orderReference: null,
      orderDate: null,
      currency: null,
      retailer: { code: null, name: null, gln: null },
      company: { code: null, name: null, gln: null },
      totals: { initialAmount: null, initialDiscount: null, totalAmount: null },
      headerComplete: false,
      events: [{ eventId: 'evt-0', eventType: 'stock.reserved.v1', occurredAt: '2026-08-18T10:14:00.000Z', summary: 'Stock reserved' }],
    });
    const detail = toOrderDetail(placeholder);
    expect(detail.headerComplete).toBe(false);
    expect(detail.orderReference).toBeNull();
    expect(detail.retailer).toBeNull();
    expect(detail.totals).toBeNull();
    expect(detail.events).toHaveLength(1);
  });
});
