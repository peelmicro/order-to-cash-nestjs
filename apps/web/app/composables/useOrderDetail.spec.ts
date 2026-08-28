// @vitest-environment node
//
// Pure reducer tests for the cache-patching functions the live SSE frames
// drive — no Vue component, no DOM, just a real `QueryClient` (the same
// class `@tanstack/vue-query` wraps) and real cache reads/writes.
import { QueryClient } from '@tanstack/vue-query';
import { describe, expect, it } from 'vitest';
import { applyOrderStreamUpdate, applyTimelineAppended, orderDetailQueryKey, type OrderDetailResult } from './useOrderDetail';
import type { OrderDetail, OrderStreamUpdate, TimelineStreamEntry } from '#shared/types/gateway';

const ORDER_ID = 'ord-1';

function readyDetail(overrides: Partial<OrderDetail> = {}): OrderDetailResult {
  return {
    kind: 'ready',
    detail: {
      orderId: ORDER_ID,
      orderReference: 'ORD-000001',
      status: 'placed',
      cancellationReason: null,
      currency: 'EUR',
      totals: { initialAmount: 1000, initialDiscount: 0, totalAmount: 1000 },
      events: [{ eventId: 'evt-0', eventType: 'order.placed.v1', occurredAt: '2026-08-27T10:00:00.000Z', summary: 'Order placed' }],
      references: {},
      updatedAt: '2026-08-27T10:00:00.000Z',
      ...overrides,
    },
  };
}

function client(seed: OrderDetailResult): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(orderDetailQueryKey(ORDER_ID), seed);
  return queryClient;
}

describe('applyTimelineAppended — R51: dedup on eventId', () => {
  it('appends a new timeline entry to the cached ready document, sorted by occurredAt', () => {
    const queryClient = client(readyDetail());
    const entry: TimelineStreamEntry = {
      eventId: 'evt-1',
      orderId: ORDER_ID,
      eventType: 'stock.reserved.v1',
      occurredAt: '2026-08-27T10:05:00.000Z',
      summary: 'Stock reserved',
    };

    applyTimelineAppended(queryClient, ORDER_ID, entry);

    const result = queryClient.getQueryData<OrderDetailResult>(orderDetailQueryKey(ORDER_ID));
    expect(result?.kind).toBe('ready');
    if (result?.kind !== 'ready') throw new Error('expected ready');
    expect(result.detail.events.map((e) => e.eventId)).toEqual(['evt-0', 'evt-1']);
  });

  it('a redelivered frame (same eventId already present) leaves the events array unchanged — no duplicate entry', () => {
    const queryClient = client(readyDetail());
    const entry: TimelineStreamEntry = {
      eventId: 'evt-0', // already present in the seeded snapshot
      orderId: ORDER_ID,
      eventType: 'order.placed.v1',
      occurredAt: '2026-08-27T10:00:00.000Z',
      summary: 'Order placed',
    };

    applyTimelineAppended(queryClient, ORDER_ID, entry);

    const result = queryClient.getQueryData<OrderDetailResult>(orderDetailQueryKey(ORDER_ID));
    if (result?.kind !== 'ready') throw new Error('expected ready');
    expect(result.detail.events).toHaveLength(1);
  });

  it('is a no-op while the cached document is still projection-pending — nothing to patch yet', () => {
    const queryClient = new QueryClient();
    const pendingResult: OrderDetailResult = { kind: 'pending', pending: { orderId: ORDER_ID, status: 'projection_pending' } };
    queryClient.setQueryData<OrderDetailResult>(orderDetailQueryKey(ORDER_ID), pendingResult);
    const entry: TimelineStreamEntry = { eventId: 'evt-1', orderId: ORDER_ID, eventType: 'stock.reserved.v1', occurredAt: '2026-08-27T10:05:00.000Z', summary: 'Stock reserved' };

    applyTimelineAppended(queryClient, ORDER_ID, entry);

    const result = queryClient.getQueryData<OrderDetailResult>(orderDetailQueryKey(ORDER_ID));
    expect(result?.kind).toBe('pending');
  });
});

describe('applyOrderStreamUpdate', () => {
  it('patches status/totals/references/updatedAt onto the cached ready document', () => {
    const queryClient = client(readyDetail());
    const update: OrderStreamUpdate = {
      eventId: 'evt-2',
      orderId: ORDER_ID,
      status: 'confirmed',
      occurredAt: '2026-08-27T10:10:00.000Z',
      totals: { initialAmount: 1000, initialDiscount: 0, totalAmount: 1000 },
      references: { despatchReference: 'DES-000001' },
    };

    applyOrderStreamUpdate(queryClient, ORDER_ID, update);

    const result = queryClient.getQueryData<OrderDetailResult>(orderDetailQueryKey(ORDER_ID));
    if (result?.kind !== 'ready') throw new Error('expected ready');
    expect(result.detail.status).toBe('confirmed');
    expect(result.detail.references?.despatchReference).toBe('DES-000001');
    expect(result.detail.updatedAt).toBe('2026-08-27T10:10:00.000Z');
  });
});
