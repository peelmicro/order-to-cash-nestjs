// @vitest-environment nuxt
//
// Stock view (feature 29 pass 7): `GET /stock` (a live read of Fulfillment's
// own write model, not the Mongo read model — no projection lag here) and
// `POST /stock/replenish` (a DELTA, never a target level).
import { createError, getQuery, readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor, within } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import StockPage from './index.vue';
import type { ReplenishStockRequest, ReplenishStockResponse, StockItem, StockPage as StockPageResponse } from '#shared/types/gateway';

function makeStockItem(overrides: Partial<StockItem> = {}): StockItem {
  return {
    companyCode: 'IBERFOODS',
    productCode: 'PRD-0001',
    productName: 'Widget',
    units: 40,
    reservedUnits: 10,
    availableUnits: 30,
    lowStockThreshold: 20,
    ...overrides,
  };
}

/**
 * The app's own production `QueryClient` (`app/plugins/vue-query.ts`) sets
 * `retry: 1`; a bare `VueQueryPlugin` in a test — the pattern every earlier
 * spec file in this app used — gets TanStack Query's OWN built-in default
 * (`retry: 3`, exponential backoff) instead, since no queryClient is
 * supplied. No earlier spec file in this app noticed, because none of them
 * exercised an actual `useQuery` error path — this pass's error-handling
 * sweep is the first to. Left at the default, an error-state assertion
 * either times out or takes several real seconds per retry cycle; `retry:
 * false` here makes the error surface on the first attempt, deterministically.
 */
function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderStock() {
  return renderSuspended(StockPage, { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } });
}

describe('stock/index.vue — stock table', () => {
  it('renders rows with the correct availableUnits (units − reservedUnits, per invariant F1)', async () => {
    registerEndpoint('/api/stock', () => ({
      items: [makeStockItem({ units: 40, reservedUnits: 10, availableUnits: 30 })],
      page: { page: 1, pageSize: 20, total: 1 },
    } satisfies StockPageResponse));

    await renderStock();

    const row = await screen.findByTestId('stock-row');
    expect(within(row).getByTestId('stock-units').textContent).toContain('40');
    expect(within(row).getByTestId('stock-available').textContent).toContain('30');
  });

  it('the belowThreshold filter changes the query sent to /api/stock', async () => {
    let lastBelowThreshold: unknown;
    registerEndpoint('/api/stock', (event) => {
      lastBelowThreshold = getQuery(event).belowThreshold;
      return { items: [makeStockItem()], page: { page: 1, pageSize: 20, total: 1 } } satisfies StockPageResponse;
    });

    await renderStock();
    await screen.findByTestId('stock-row');

    expect(lastBelowThreshold).toBeUndefined();

    await fireEvent.click(screen.getByTestId('below-threshold-toggle'));

    await waitFor(() => expect(lastBelowThreshold).toBe('true'));
  });

  it('shows a distinct loading state, then a distinct empty state (not the same rendering as an error)', async () => {
    let resolveResponse: (value: StockPageResponse) => void;
    const responsePromise = new Promise<StockPageResponse>((resolve) => {
      resolveResponse = resolve;
    });

    registerEndpoint('/api/stock', () => responsePromise);

    const renderPromise = renderStock();

    // While loading, the loading state should be visible
    await waitFor(() => {
      expect(screen.getByTestId('stock-loading')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('stock-error')).not.toBeInTheDocument();
    expect(screen.queryByText('No stock lines match these filters.')).not.toBeInTheDocument();

    // Resolve the response with empty items
    resolveResponse!({ items: [], page: { page: 1, pageSize: 20, total: 0 } });
    await renderPromise;

    // After loading completes with empty result, the empty state should be visible
    await waitFor(() => {
      expect(screen.queryByTestId('stock-loading')).not.toBeInTheDocument();
    });
    const emptyText = await screen.findByText('No stock lines match these filters.');
    expect(emptyText).toBeTruthy();
    expect(screen.queryByTestId('stock-error')).not.toBeInTheDocument();
  });
});

describe('stock/index.vue — replenish (a delta, never a target level)', () => {
  it('submits the typed amount as a DELTA (`units`), not the resulting target level', async () => {
    registerEndpoint('/api/stock', () => ({
      items: [makeStockItem({ units: 40, reservedUnits: 10, availableUnits: 30 })],
      page: { page: 1, pageSize: 20, total: 1 },
    } satisfies StockPageResponse));

    let capturedBody: ReplenishStockRequest | undefined;
    registerEndpoint('/api/stock/replenish', {
      method: 'POST',
      handler: async (event) => {
        capturedBody = await readBody(event);
        return {
          items: [makeStockItem({ units: 150, reservedUnits: 10, availableUnits: 140 })],
        } satisfies ReplenishStockResponse;
      },
    });

    await renderStock();

    await fireEvent.click(await screen.findByTestId('replenish-button'));
    await fireEvent.update(screen.getByTestId('replenish-units-input'), '110');
    await fireEvent.click(screen.getByTestId('submit-replenish-button'));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody?.companyCode).toBe('IBERFOODS');
    expect(capturedBody?.lines).toEqual([{ productCode: 'PRD-0001', units: 110 }]);
    // The delta (110), not the pre-existing on-hand (40) nor the post-replenish
    // total (150) — proves the field is genuinely a delta on the wire, not
    // silently resolved to a target level.
    expect(capturedBody?.lines[0]?.units).not.toBe(40);
    expect(capturedBody?.lines[0]?.units).not.toBe(150);

    await screen.findByTestId('replenish-outcome');
  });

  it('surfaces the "delta, not target" semantics visibly in the replenish form', async () => {
    registerEndpoint('/api/stock', () => ({
      items: [makeStockItem()],
      page: { page: 1, pageSize: 20, total: 1 },
    } satisfies StockPageResponse));

    await renderStock();

    await fireEvent.click(await screen.findByTestId('replenish-button'));

    const form = screen.getByTestId('replenish-form');
    expect(form.textContent).toMatch(/adds.*on-hand.*delta.*not a target level/is);
  });
});

// ── Error-handling sweep (Part 2 of this pass's brief) ─────────────────────
describe('stock/index.vue — error handling', () => {
  it('a failed GET /api/stock (e.g. Fulfillment down, 503 UpstreamUnavailable) renders a visible, distinct error — not an empty table, not a stuck spinner', async () => {
    registerEndpoint('/api/stock', () => {
      throw createError({
        statusCode: 503,
        statusMessage: 'Gateway request failed',
        data: { code: 'UPSTREAM_UNAVAILABLE', title: 'The owning context is unreachable', detail: 'RPC call to "fulfillment.stock.list" failed: no responder is subscribed to this subject' },
      });
    });

    await renderStock();

    const errorEl = await screen.findByTestId('stock-error');
    expect(errorEl.textContent).toMatch(/could not load stock/i);
    // Distinct from the empty-result state: the "no stock lines" copy must
    // never render at the same time as the error.
    expect(screen.queryByText('No stock lines match these filters.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stock-loading')).not.toBeInTheDocument();
  });

  it('a failed POST /api/stock/replenish surfaces the server\'s own reason, and it does not persist when the form is reopened for a different item', async () => {
    registerEndpoint('/api/stock', () => ({
      items: [makeStockItem({ companyCode: 'IBERFOODS', productCode: 'PRD-0001' }), makeStockItem({ companyCode: 'IBERFOODS', productCode: 'PRD-0002' })],
      page: { page: 1, pageSize: 20, total: 2 },
    } satisfies StockPageResponse));

    registerEndpoint('/api/stock/replenish', {
      method: 'POST',
      handler: async () => {
        throw createError({
          statusCode: 404,
          statusMessage: 'Not found',
          data: { code: 'NOT_FOUND', title: 'No such product', detail: 'No stock line for IBERFOODS/PRD-0001' },
        });
      },
    });

    await renderStock();

    const buttons = await screen.findAllByTestId('replenish-button');
    await fireEvent.click(buttons[0]!);
    await fireEvent.update(screen.getByTestId('replenish-units-input'), '10');
    await fireEvent.click(screen.getByTestId('submit-replenish-button'));

    const errorEl = await screen.findByTestId('replenish-error');
    expect(errorEl.textContent).toMatch(/no stock line for iberfoods\/prd-0001/i);

    await fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    const buttonsAfter = await screen.findAllByTestId('replenish-button');
    await fireEvent.click(buttonsAfter[1]!);

    // The stale error from the FIRST item's failed submit must not reappear
    // on the freshly-opened form for a DIFFERENT item (Pass 6's own
    // disclosed, non-blocking finding — applied here from the start).
    expect(screen.queryByTestId('replenish-error')).not.toBeInTheDocument();
  });
});
