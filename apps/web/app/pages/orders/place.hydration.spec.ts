// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';

/**
 * Bug 1 regression, place-order half: same `<form>`-with-no-`action`
 * pre-hydration native-GET-submit shape as `login.vue` (no password field
 * here, so the security angle doesn't apply, but the "first click does
 * nothing until hydration finishes" UX bug does). Same fix (`mounted` ref,
 * `onMounted`-gated `:disabled`), same test strategy — see
 * `apps/web/app/pages/login.spec.ts`'s header comment for the full
 * explanation of why `onMounted` never firing is used to deterministically
 * simulate the pre-hydration instant, rather than relying on
 * `renderSuspended`'s own timing (which — proven directly against this
 * harness — already resolves *after* a real `onMounted` has fired, so it
 * cannot itself observe the true pre-mount tick).
 */
describe('orders/place.vue — submit button is gated on hydration, not only on isPending/form-validity', () => {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));

  it('stays disabled even with valid retailer/company filled in, for as long as onMounted has not fired (pre-hydration window)', async () => {
    vi.doMock('vue', async (importOriginal) => {
      const actual = await importOriginal<typeof import('vue')>();
      return { ...actual, onMounted: vi.fn() };
    });
    vi.resetModules();
    const { default: PlaceOrderPage } = await import('./place.vue');

    await renderSuspended(PlaceOrderPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
    await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');

    const button = screen.getByRole('button', { name: /place order|placing/i });
    expect(button).toBeDisabled();

    vi.doUnmock('vue');
    vi.resetModules();
  });
});
