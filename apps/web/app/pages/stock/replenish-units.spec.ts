// @vitest-environment nuxt
//
// Replenish "Units to add" box (stock/index.vue). It was `type="number"`:
// Chromium reports "" for "1-2" / "12e" / "5-" (Add units stayed disabled,
// nothing said) and "1.5" was sent as 1.5 units. It is now a text box; text
// that is not a whole number of 1 or more is refused in words, nothing sent.
// Probe evidence: progress/impl_web_number_inputs.md.
import { readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import StockPage from './index.vue';
import type { ReplenishStockRequest, ReplenishStockResponse, StockItem, StockPage as StockPageResponse } from '#shared/types/gateway';

const item: StockItem = { companyCode: 'IBERFOODS', productCode: 'PRD-0001', productName: 'Widget', units: 40, reservedUnits: 10, availableUnits: 30, lowStockThreshold: 20 };

const posted: ReplenishStockRequest[] = [];

async function openReplenishForm(): Promise<void> {
  posted.length = 0;
  registerEndpoint('/api/stock', () => ({ items: [item], page: { page: 1, pageSize: 20, total: 1 } } satisfies StockPageResponse));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));
  registerEndpoint('/api/stock/replenish', {
    method: 'POST',
    handler: async (event) => {
      posted.push(await readBody<ReplenishStockRequest>(event));
      return { items: [{ ...item, units: 47 }] } satisfies ReplenishStockResponse;
    },
  });
  await renderSuspended(StockPage, { global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] } });
  await fireEvent.click(await screen.findByTestId('replenish-button'));
}

// None is a substring of another, and each differs from the control "7".
const MALFORMED_UNITS = ['1-2', '12e', '5-', '1.5', '0', '  ', 'abc', '-4', '1e3', '1e-2'];

describe('stock/index.vue — replenish-units-input refuses text that is not a whole number of 1 or more', () => {
  it.each(MALFORMED_UNITS)('replenish-units-input refuses %j in words naming the field, sends nothing, and keeps the typed text', async (text) => {
    await openReplenishForm();
    const box = screen.getByTestId('replenish-units-input') as HTMLInputElement;
    await fireEvent.update(box, text);

    await fireEvent.click(screen.getByTestId('submit-replenish-button'));

    const problem = await screen.findByTestId('replenish-units-problem');
    expect(problem.textContent).toContain('Units to add');
    expect(problem.textContent).toContain(text.trim() === '' ? 'is required' : `"${text}"`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
    expect(box.value).toBe(text);
    // A text box: a number box would have reported "" for the malformed text and the page could not tell.
    expect(box.type).toBe('text');
    // The box is marked invalid and points at the element holding the problem text.
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const describedBy = box.getAttribute('aria-describedby');
    expect(describedBy, 'aria-describedby must name the problem element').toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(text.trim() === '' ? 'is required' : `"${text}"`);
  });

  it('replenish-units-input: an EMPTY box is refused in words (Add units is not disabled by empty text) and nothing is sent', async () => {
    await openReplenishForm();
    await fireEvent.update(screen.getByTestId('replenish-units-input'), '');
    const submit = screen.getByTestId('submit-replenish-button');
    expect(submit).not.toBeDisabled();

    await fireEvent.click(submit);

    expect((await screen.findByTestId('replenish-units-problem')).textContent).toContain('Units to add is required');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it('replenish-units-input: well-formed digits above the largest safe integer are refused as "too large"', async () => {
    await openReplenishForm();
    await fireEvent.update(screen.getByTestId('replenish-units-input'), '9007199254740993');
    await fireEvent.click(screen.getByTestId('submit-replenish-button'));
    expect((await screen.findByTestId('replenish-units-problem')).textContent).toContain('Units to add is too large');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it('replenish-units-input: the problem goes away as soon as the text changes', async () => {
    await openReplenishForm();
    await fireEvent.update(screen.getByTestId('replenish-units-input'), '5-');
    await fireEvent.click(screen.getByTestId('submit-replenish-button'));
    await screen.findByTestId('replenish-units-problem');

    await fireEvent.update(screen.getByTestId('replenish-units-input'), '5');

    expect(screen.queryByTestId('replenish-units-problem')).not.toBeInTheDocument();
  });

  it('replenish-units-input control: "7" is sent as 7 units and no problem is shown', async () => {
    await openReplenishForm();
    await fireEvent.update(screen.getByTestId('replenish-units-input'), '7');
    await fireEvent.click(screen.getByTestId('submit-replenish-button'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.lines[0]?.units).toBe(7);
    expect(screen.queryByTestId('replenish-units-problem')).not.toBeInTheDocument();
  });
});
