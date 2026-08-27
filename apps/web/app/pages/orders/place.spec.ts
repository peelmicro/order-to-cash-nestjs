// @vitest-environment nuxt
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PlaceOrderPage from './place.vue';

/**
 * Regression test for the "Placing…"/disabled-on-first-load bug: the submit
 * button's label and disabled state were driven by `placeOrder.isPending`
 * (a raw `Ref<boolean>` from `usePlaceOrderMutation()`) used directly in a
 * template ternary/`:disabled` expression instead of `placeOrder.isPending.value`.
 * `<script setup>`'s compiler only auto-unwraps a top-level ref *identifier*
 * (here `placeOrder` itself is a plain object, not a ref) — it does not
 * unwrap a nested `.isPending` member access, so the ternary's condition was
 * always the (truthy, referentially-stable) `Ref` object itself, regardless
 * of the mutation's real state. Proves R: "Place order" button reflects the
 * mutation's actual idle/pending state, not a permanently-truthy Ref object.
 */
describe('orders/place.vue — submit button initial state', () => {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));

  it('reads "Place order" and is not stuck in the pending label before any submit', async () => {
    await renderSuspended(PlaceOrderPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    const button = screen.getByRole('button', { name: /place order|placing/i });
    expect(button).toHaveTextContent('Place order');
    expect(button).not.toHaveTextContent('Placing');
  });

  it('is disabled only by the retailer/company form-validity guard, not by a permanently-truthy mutation state', async () => {
    await renderSuspended(PlaceOrderPage, {
      global: { plugins: [VueQueryPlugin] },
    });

    // Fields empty on mount — the button should be disabled by the guard.
    const button = screen.getByRole('button', { name: /place order|placing/i });
    expect(button).toBeDisabled();

    // Filling in the required fields (no submit yet — `mutateAsync` never
    // called) must enable it: nothing here should keep it permanently
    // disabled just because the mutation's `isPending` ref exists.
    await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
    await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');

    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent('Place order');
  });
});
