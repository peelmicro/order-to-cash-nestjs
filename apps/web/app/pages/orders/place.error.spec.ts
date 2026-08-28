// @vitest-environment nuxt
//
// Error-handling sweep (feature 29 pass 7): the named 409/business-conflict
// example — a failed stock check at acceptance — surfaced with the
// server's own reason (openapi.yaml `StockUnavailableProblem`), not a
// generic "something went wrong".
import { createError } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import PlaceOrderPage from './place.vue';

function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderPlaceOrder() {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));
  return renderSuspended(PlaceOrderPage, { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } });
}

describe('orders/place.vue — 409 stock-unavailable is surfaced with the server\'s own reason', () => {
  it('renders the real detail text AND the per-product shortages from a 409 STOCK_UNAVAILABLE response', async () => {
    registerEndpoint('/api/orders', {
      method: 'POST',
      handler: () => {
        throw createError({
          statusCode: 409,
          statusMessage: 'Conflict',
          data: {
            code: 'STOCK_UNAVAILABLE',
            title: 'Insufficient stock at acceptance',
            detail: 'Insufficient stock for 1 line(s) at acceptance.',
            shortages: [{ productCode: 'PRD-0001', requested: 50, available: 12 }],
          },
        });
      },
    });

    await renderPlaceOrder();

    await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
    await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');
    await fireEvent.update(screen.getByPlaceholderText('e.g. PRD-0001'), 'PRD-0001');

    await fireEvent.submit(screen.getByRole('button', { name: /place order/i }).closest('form')!);

    const errorEl = await screen.findByTestId('place-order-error');
    expect(errorEl.textContent).toMatch(/insufficient stock for 1 line\(s\) at acceptance/i);

    const shortages = screen.getByTestId('place-order-shortages');
    expect(shortages.textContent).toMatch(/prd-0001/i);
    expect(shortages.textContent).toMatch(/requested 50/i);
    expect(shortages.textContent).toMatch(/only 12 available/i);
  });

  it('a 503 UpstreamUnavailable (e.g. Fulfillment down, RPC timeout) is surfaced with the real reason, not a generic fallback', async () => {
    registerEndpoint('/api/orders', {
      method: 'POST',
      handler: () => {
        throw createError({
          statusCode: 503,
          statusMessage: 'Gateway request failed',
          data: { code: 'UPSTREAM_UNAVAILABLE', title: 'The owning context is unreachable', detail: 'RPC call to "orders.create" failed: no responder is subscribed to this subject' },
        });
      },
    });

    await renderPlaceOrder();

    await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
    await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');

    await fireEvent.submit(screen.getByRole('button', { name: /place order/i }).closest('form')!);

    const errorEl = await screen.findByTestId('place-order-error');
    expect(errorEl.textContent).toMatch(/no responder is subscribed to this subject/i);
    expect(errorEl.textContent).not.toMatch(/placing the order failed\./i);
  });
});
