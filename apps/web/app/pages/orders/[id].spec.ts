// @vitest-environment nuxt
//
// Genuine renders of the real `[id].vue` page component (never a curl
// against a server route bypassing the DOM — that shortcut is exactly how
// the stuck-button bug from an earlier pass reached the human instead of
// being caught here). The initial `GET /api/orders/{id}` call is mocked via
// `registerEndpoint`, the same seam `place.vue`'s own tests already use;
// the SSE transport is substituted with a controllable `EventTarget`-based
// double injected via the page's `streamFactory` prop (a test-only seam —
// see the prop's own doc comment in `[id].vue`) — the dedup/reconnect LOGIC
// itself is never mocked here: it lives in the real, unmodified
// `OrderStreamClient`, proven separately and more rigorously against a real
// `EventSource` implementation in `app/lib/order-stream-client.spec.ts`.
// This file's job is to prove the Vue-layer wiring: real frames flowing
// through the real composable reach the real rendered DOM.
import { setResponseStatus } from 'h3';
import { afterEach, describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, waitFor, within } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import OrderDetailPage from './[id].vue';
import type { EventSourceLike } from '@/lib/order-stream-client';
import type { OrderDetail, ProjectionPending } from '#shared/types/gateway';

// `EventTarget`'s own `addEventListener` accepts a full DOM `Event`, wider
// than `EventSourceLike`'s narrower `(event: { data: string }) => void` —
// extending `EventTarget` (a real, standard, non-mocked base class; only
// its underlying transport is faked, never the dispatch mechanism) and
// exposing it through the same `as unknown as EventSourceLike` cast
// `useOrderStream.ts`'s own real-`EventSource` factory already uses is the
// accurate typing, not an `implements` clause fighting the two shapes.
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState = 1; // OPEN, per the real EventSource constants

  constructor(public readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(type: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function fakeFactory(url: string): EventSourceLike {
  return new FakeEventSource(url) as unknown as EventSourceLike;
}

function readyOrder(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    orderId: 'order-1',
    orderReference: 'ORD-000001',
    status: 'placed',
    cancellationReason: null,
    currency: 'EUR',
    totals: { initialAmount: 24999, initialDiscount: 0, totalAmount: 24999 },
    retailer: { code: 'CarrefourEs', gln: '1234567890123', name: 'Carrefour Spain' },
    company: { code: 'IBERFOODS', gln: '9876543210987', name: 'Iberfoods' },
    events: [{ eventId: 'evt-0', eventType: 'order.placed.v1', occurredAt: '2026-08-27T10:00:00.000Z', summary: 'Order placed' }],
    references: {},
    headerComplete: true,
    updatedAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('orders/[id].vue — order detail page with live SSE timeline', () => {
  afterEach(() => {
    FakeEventSource.instances = [];
  });

  it('R55 — renders the honest "waiting for projection" state for a 202/ProjectionPending answer, not a spinner or a 404', async () => {
    registerEndpoint('/api/orders/order-pending', {
      method: 'GET',
      handler: (event) => {
        setResponseStatus(event, 202);
        return { orderId: 'order-pending', status: 'projection_pending', message: 'The order was accepted and is not projected yet.', retryAfterMs: 500 } satisfies ProjectionPending;
      },
    });

    await renderSuspended(OrderDetailPage, {
      route: '/orders/order-pending',
      props: { orderId: 'order-pending' },
      global: { plugins: [VueQueryPlugin] },
    });

    const pending = await screen.findByTestId('order-detail-pending');
    expect(within(pending).getByText(/waiting for this order to appear/i)).toBeInTheDocument();
    expect(within(pending).getByText(/not projected yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('order-detail-error')).not.toBeInTheDocument();
  });

  it('renders the header and timeline from the real GET response once loaded', async () => {
    registerEndpoint('/api/orders/order-1', { method: 'GET', handler: () => readyOrder() });

    await renderSuspended(OrderDetailPage, {
      route: '/orders/order-1',
      props: { orderId: 'order-1', streamFactory: fakeFactory },
      global: { plugins: [VueQueryPlugin] },
    });

    expect(await screen.findByText('ORD-000001')).toBeInTheDocument();
    expect(screen.getByTestId('order-detail-status')).toHaveTextContent('placed');
    const timeline = screen.getByTestId('order-timeline');
    expect(within(timeline).getAllByTestId('timeline-entry')).toHaveLength(1);
    expect(within(timeline).getByText('Order placed')).toBeInTheDocument();
  });

  it('R51 — a live timeline.appended frame is rendered, and a redelivered frame (same eventId) never produces a second entry', async () => {
    registerEndpoint('/api/orders/order-1', { method: 'GET', handler: () => readyOrder() });

    await renderSuspended(OrderDetailPage, {
      route: '/orders/order-1',
      props: { orderId: 'order-1', streamFactory: fakeFactory },
      global: { plugins: [VueQueryPlugin] },
    });

    await screen.findByText('ORD-000001');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    source.emit('stream.ready', { cursor: 'c0', resumed: true });
    source.emit('timeline.appended', { eventId: 'evt-1', orderId: 'order-1', eventType: 'stock.reserved.v1', occurredAt: '2026-08-27T10:05:00.000Z', summary: 'Stock reserved' });

    await screen.findByText('Stock reserved');
    expect(within(screen.getByTestId('order-timeline')).getAllByTestId('timeline-entry')).toHaveLength(2);

    // Redelivery: the exact same eventId, sent again — must not duplicate.
    source.emit('timeline.appended', { eventId: 'evt-1', orderId: 'order-1', eventType: 'stock.reserved.v1', occurredAt: '2026-08-27T10:05:00.000Z', summary: 'Stock reserved' });

    await waitFor(() => {
      expect(within(screen.getByTestId('order-timeline')).getAllByTestId('timeline-entry')).toHaveLength(2);
    });
  });

  it('a live order.updated frame updates the rendered status badge', async () => {
    registerEndpoint('/api/orders/order-1', { method: 'GET', handler: () => readyOrder() });

    await renderSuspended(OrderDetailPage, {
      route: '/orders/order-1',
      props: { orderId: 'order-1', streamFactory: fakeFactory },
      global: { plugins: [VueQueryPlugin] },
    });

    await screen.findByText('ORD-000001');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    source.emit('stream.ready', { cursor: 'c0', resumed: true });
    source.emit('order.updated', { eventId: 'evt-2', orderId: 'order-1', status: 'confirmed', occurredAt: '2026-08-27T10:06:00.000Z' });

    await waitFor(() => expect(screen.getByTestId('order-detail-status')).toHaveTextContent('confirmed'));
  });

  it('resumed:false re-fetches the order detail instead of silently keeping stale data on screen', async () => {
    let callCount = 0;
    registerEndpoint('/api/orders/order-1', {
      method: 'GET',
      handler: () => {
        callCount += 1;
        return readyOrder(callCount === 1 ? {} : { status: 'confirmed' });
      },
    });

    await renderSuspended(OrderDetailPage, {
      route: '/orders/order-1',
      props: { orderId: 'order-1', streamFactory: fakeFactory },
      global: { plugins: [VueQueryPlugin] },
    });

    await screen.findByText('ORD-000001');
    expect(screen.getByTestId('order-detail-status')).toHaveTextContent('placed');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(callCount).toBe(1);

    FakeEventSource.instances[0]!.emit('stream.ready', { cursor: 'stale-cursor', resumed: false });

    await waitFor(() => expect(callCount).toBe(2));
    await waitFor(() => expect(screen.getByTestId('order-detail-status')).toHaveTextContent('confirmed'));
  });
});
