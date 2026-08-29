// @vitest-environment nuxt
//
// Order list — no dedicated spec file existed for this page before this
// pass's error-handling sweep. Loading / empty / error must be three
// genuinely distinct renderings (the sweep's own core claim), not the same
// "no orders" copy shown whether the request succeeded-empty or failed.
import { createError } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, waitFor } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import OrdersPage from './index.vue';
import type { OrderSummary, OrderSummaryPage } from '#shared/types/gateway';

function makeOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    orderId: 'order-1',
    orderReference: 'ORD-000001',
    orderDate: '2026-08-28T10:00:00.000Z',
    retailer: { code: 'CarrefourEs', gln: '5400000000010' },
    company: { code: 'IBERFOODS', gln: '5400000000218' },
    status: 'placed',
    cancellationReason: null,
    currency: 'EUR',
    totals: { initialAmount: 24999, initialDiscount: 0, totalAmount: 24999 },
    updatedAt: '2026-08-28T10:00:00.000Z',
    ...overrides,
  };
}

function mockRetailers(): void {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
}

// See `app/pages/stock/index.spec.ts` for why a test-only, no-retry
// QueryClient is needed to observe an error state deterministically.
function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderOrders() {
  return renderSuspended(OrdersPage, { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } });
}

describe('orders/index.vue — loading / empty / error are three distinct states', () => {
  it('renders real order rows', async () => {
    registerEndpoint('/api/orders', () => ({
      items: [makeOrder()],
      page: { page: 1, pageSize: 20, total: 1 },
    } satisfies OrderSummaryPage));
    mockRetailers();

    await renderOrders();

    expect((await screen.findAllByText('ORD-000001')).length).toBeGreaterThan(0);
  });

  it('shows a distinct loading state, then a distinct empty state', async () => {
    let resolveResponse: (value: OrderSummaryPage) => void;
    const responsePromise = new Promise<OrderSummaryPage>((resolve) => {
      resolveResponse = resolve;
    });

    registerEndpoint('/api/orders', () => responsePromise);
    mockRetailers();

    const renderPromise = renderOrders();

    // While loading, the loading state should be visible
    await waitFor(() => {
      expect(screen.getByTestId('orders-loading')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('orders-error')).not.toBeInTheDocument();
    expect(screen.queryByText('No orders match these filters.')).not.toBeInTheDocument();

    // Resolve the response with empty items
    resolveResponse!({ items: [], page: { page: 1, pageSize: 20, total: 0 } });
    await renderPromise;

    // After loading completes with empty result, the empty state should be visible
    await waitFor(() => {
      expect(screen.queryByTestId('orders-loading')).not.toBeInTheDocument();
    });
    const emptyText = await screen.findByText('No orders match these filters.');
    expect(emptyText).toBeTruthy();
    expect(screen.queryByTestId('orders-error')).not.toBeInTheDocument();
  });

  it('renders a distinct empty state for a genuinely empty result', async () => {
    registerEndpoint('/api/orders', () => ({ items: [], page: { page: 1, pageSize: 20, total: 0 } } satisfies OrderSummaryPage));
    mockRetailers();

    await renderOrders();

    await screen.findByText('No orders match these filters.');
    expect(screen.queryByTestId('orders-error')).not.toBeInTheDocument();
  });

  it('a failed GET /api/orders renders a visible, distinct error — not an empty table, not a stuck spinner (R: RPC timeouts/upstream failures surfaced, none swallowed)', async () => {
    registerEndpoint('/api/orders', () => {
      throw createError({
        statusCode: 503,
        statusMessage: 'Gateway request failed',
        data: { code: 'UPSTREAM_TIMEOUT', title: 'The owning context did not answer within the deadline', detail: 'RPC call to "order.list" timed out after 5000ms' },
      });
    });
    mockRetailers();

    await renderOrders();

    const errorEl = await screen.findByTestId('orders-error');
    expect(errorEl.textContent).toMatch(/rpc call to "order\.list" timed out/i);
    expect(screen.queryByText('No orders match these filters.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('orders-loading')).not.toBeInTheDocument();
  });
});

// D8 regression guard (progress/review_sonarqube_quality_gates.md, second
// review): the a11y fixes had no test that would fail if deleted — armed and
// confirmed against this exact page (`for="order-status-filter"` deletion
// survived the full 66-test suite). These assert the ACCESSIBLE properties
// (label association, real `columnheader` roles), not `data-testid`, so a
// legitimate refactor of the mechanism would still pass.
describe('orders/index.vue — accessible filter controls and table headers (D8 guard)', () => {
  it('the Status and Retailer filters resolve by their visible label, not only by data-testid', async () => {
    registerEndpoint('/api/orders', () => ({ items: [], page: { page: 1, pageSize: 20, total: 0 } } satisfies OrderSummaryPage));
    mockRetailers();

    await renderOrders();

    expect(await screen.findByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByLabelText('Retailer')).toBeInTheDocument();
  });

  it('the order table exposes real column headers (role=columnheader, scope=col — WCAG 2.2 1.3.1), not just visible text', async () => {
    registerEndpoint('/api/orders', () => ({
      items: [makeOrder()],
      page: { page: 1, pageSize: 20, total: 1 },
    } satisfies OrderSummaryPage));
    mockRetailers();

    await renderOrders();

    const headers = await screen.findAllByRole('columnheader');
    expect(headers.map((h) => h.textContent?.trim())).toEqual(['Reference', 'Date', 'Retailer', 'Company', 'Status', 'Total']);
    headers.forEach((header) => expect(header).toHaveAttribute('scope', 'col'));
  });
});
