// @vitest-environment nuxt
//
// Regression test for the "Unit price override shows 24999 instead of
// 249.99" bug the user found by hand-testing: the field bound directly to
// `line.unitPrice` (the raw integer minor-units wire value) instead of a
// decimal major-unit amount, and "Fill demo order" populated it with the
// same raw integer. Investigation found "Line discount" bound the identical
// way (`line.lineDiscount`), just never surfaced in the screenshot because
// it always held `0` there — `0` reads the same whether it's "0 minor
// units" or "0.00 major units", so the bug was invisible in that field's
// screenshot without actually testing a non-trivial value. Both fields are
// covered here.
import { readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PlaceOrderPage from './place.vue';
import type { PlaceOrderRequest } from '#shared/types/gateway';

describe('orders/place.vue — unit price override / line discount decimal display', () => {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));

  it('R: "Fill demo order" pre-fills Unit price override with a decimal amount ("249.99"), not the raw minor-units integer ("24999")', async () => {
    await renderSuspended(PlaceOrderPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    await fireEvent.click(screen.getByRole('button', { name: /fill demo order/i }));

    const unitPriceInput = screen.getByTestId('unit-price-input') as HTMLInputElement;
    expect(unitPriceInput.value).toBe('249.99');
    expect(unitPriceInput.value).not.toBe('24999');
  });

  it('R: a typed decimal Unit price override ("19.99", a classic floating-point-error-prone amount) round-trips to exactly 1999 minor units on submit — not 1998 or 1999.0000000000002', async () => {
    let capturedBody: PlaceOrderRequest | undefined;
    registerEndpoint('/api/orders', {
      method: 'POST',
      handler: async (event) => {
        capturedBody = await readBody(event);
        return {
          orderId: 'order-1',
          orderReference: 'ORD-000001',
          status: 'placed',
          currency: 'EUR',
          orderDate: new Date().toISOString(),
        };
      },
    });

    await renderSuspended(PlaceOrderPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
    await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');
    await fireEvent.update(screen.getByPlaceholderText('e.g. PRD-0001'), 'PRD-0001');
    await fireEvent.update(screen.getByTestId('unit-price-input'), '19.99');

    // `fireEvent.submit(form)` rather than clicking the submit button:
    // happy-dom (unlike a real browser) does not dispatch a native `submit`
    // event on the form when a `<button type="submit">` inside it is
    // clicked — confirmed directly (a `fireEvent.click` on the button never
    // reached this endpoint at all, `capturedBody` stayed `undefined`).
    // Dispatching `submit` directly on the form exercises the exact same
    // `@submit.prevent="submit"` handler a real click ultimately triggers.
    await fireEvent.submit(screen.getByRole('button', { name: /place order/i }).closest('form')!);

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody?.lines?.[0]?.unitPrice).toBe(1999);
  });

  it('R: a typed decimal Line discount ("5.50") round-trips to exactly 550 minor units on submit — Line discount had the identical raw-minor-units bug as Unit price override', async () => {
    let capturedBody: PlaceOrderRequest | undefined;
    registerEndpoint('/api/orders', {
      method: 'POST',
      handler: async (event) => {
        capturedBody = await readBody(event);
        return {
          orderId: 'order-2',
          orderReference: 'ORD-000002',
          status: 'placed',
          currency: 'EUR',
          orderDate: new Date().toISOString(),
        };
      },
    });

    await renderSuspended(PlaceOrderPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
    await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');
    await fireEvent.update(screen.getByPlaceholderText('e.g. PRD-0001'), 'PRD-0001');
    await fireEvent.update(screen.getByTestId('line-discount-input'), '5.50');

    // See the equivalent unit-price test above for why this dispatches
    // `submit` on the form directly rather than clicking the button.
    await fireEvent.submit(screen.getByRole('button', { name: /place order/i }).closest('form')!);

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody?.lines?.[0]?.lineDiscount).toBe(550);
  });
});
