// @vitest-environment nuxt
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PlaceOrderPage from './place.vue';

/**
 * Regression test for the currency/retailer mismatch gap: the `currency`
 * field used to be a static text input defaulting to `'EUR'`, with no
 * relationship to the selected retailer's actual trading currency —
 * confirmed live that `AldiGb` trades in GBP, so a form submission with
 * `retailerCode: 'AldiGb'` and `currency: 'EUR'` was a real, silent
 * mismatch. Proves: selecting a GBP retailer updates the currency field to
 * GBP, not EUR — the field re-derives its default from the selected
 * retailer's own `currency` (`GET /catalog/retailers`'s `Party.currency`),
 * rather than being permanently stuck at the form's initial default.
 */
describe('orders/place.vue — currency follows the selected retailer', () => {
  registerEndpoint('/api/catalog/retailers', () => ({
    items: [
      { code: 'CarrefourEs', name: 'Carrefour Spain', country: 'ES', currency: 'EUR', gln: '1234567890123', enabled: true },
      { code: 'AldiGb', name: 'Aldi UK', country: 'GB', currency: 'GBP', gln: '9876543210987', enabled: true },
    ],
  }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));

  it('defaults to EUR, then updates to GBP once the GBP-trading retailer (AldiGb) is selected', async () => {
    await renderSuspended(PlaceOrderPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    const currencyInput = (await screen.findByLabelText('Currency')) as HTMLInputElement;
    expect(currencyInput.value).toBe('EUR');

    // reka-ui's Select opens on a real mouse `pointerdown`, which happy-dom
    // does not simulate the same way `fireEvent` does — the library's own
    // documented, equally-real keyboard path (`OPEN_KEYS` includes `Enter`)
    // opens it just as validly.
    await fireEvent.keyDown(await screen.findByTestId('retailer-select-trigger'), { key: 'Enter' });
    const option = await screen.findByRole('option', { name: 'Aldi UK (AldiGb)' });
    // reka-ui's SelectContentImpl always arms a document-level, `once`,
    // capture-phase `pointerup` guard the instant the listbox opens (a
    // Radix-style "don't let the same click that opened the trigger also
    // select the item underneath the cursor" safeguard) — it swallows
    // exactly one `pointerup` system-wide before any item's own handler
    // sees one. A real mouse user's opening click is what that guard is
    // tuned to consume; a scripted, keyboard-opened interaction has no such
    // "opening click" to burn, so the first synthetic `pointerup` must be
    // spent deliberately here before the one that actually selects the
    // item — confirmed directly against reka-ui's own source
    // (`SelectContentImpl.vue`'s `handlePointerUp`/`triggerPointerDownPosRef`).
    await fireEvent.pointerUp(option);
    await fireEvent.pointerUp(option);

    await waitFor(() => expect(currencyInput.value).toBe('GBP'));
  });
});
