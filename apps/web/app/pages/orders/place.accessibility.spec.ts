// @vitest-environment nuxt
//
// D8 regression guard (progress/review_sonarqube_quality_gates.md, second
// review): the a11y fixes from the SonarQube first-scan pass — `<Label
// for="…">`/`id` pairs on every form control — had no test that would fail
// if one were deleted. Armed and confirmed: deleting
// `for="order-status-filter"` from `orders/index.vue` survived the full 66-
// test suite untouched. This file asserts controls resolve by their VISIBLE
// LABEL (`getByLabelText`, the real accessible-name computation Testing
// Library performs from the DOM — not `data-testid`/`getByPlaceholderText`,
// which say nothing about whether a screen-reader user could find the
// field), in both branches of every `v-if`/`v-else` pair this page has
// (Select-usable vs. Input-fallback — see D9's note on why the Product
// field's two ids are both static-per-branch, matching Retailer/Company).
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PlaceOrderPage from './place.vue';

function mockEmptyCatalog(): void {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));
}

function mockPopulatedCatalog(): void {
  registerEndpoint('/api/catalog/retailers', () => ({
    items: [{ code: 'CarrefourEs', name: 'Carrefour Spain', country: 'ES', currency: 'EUR', gln: '1234567890123', enabled: true }],
  }));
  registerEndpoint('/api/catalog/companies', () => ({
    items: [{ code: 'IBERFOODS', name: 'Iberfoods SA', country: 'ES', currency: 'EUR', gln: '9876543210987', enabled: true }],
  }));
  registerEndpoint('/api/catalog/products', () => ({
    items: [{ code: 'PRD-0001', name: 'Widget', price: 24999, currency: 'EUR', enabled: true }],
  }));
}

async function renderPlaceOrder() {
  return renderSuspended(PlaceOrderPage, { global: { plugins: [VueQueryPlugin] } });
}

describe('orders/place.vue — form controls resolve by their visible label (D8 guard)', () => {
  it('the Input-fallback branch (catalogue unavailable): every field resolves by getByLabelText', async () => {
    mockEmptyCatalog();

    await renderPlaceOrder();

    expect(await screen.findByLabelText('Retailer')).toBeInTheDocument();
    expect(screen.getByLabelText('Company')).toBeInTheDocument();
    expect(screen.getByLabelText('Currency')).toBeInTheDocument();
    expect(screen.getByLabelText('Product')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Unit price override')).toBeInTheDocument();
    expect(screen.getByLabelText('Line discount')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
  });

  it('the Select-usable branch (catalogue available): the SAME fields resolve by getByLabelText, via a real reka-ui combobox this time — not just the Input fallback', async () => {
    mockPopulatedCatalog();

    await renderPlaceOrder();

    // These waits let the Select branch actually mount before querying —
    // `retailersUsable`/`companiesUsable`/`productsUsable` only flip once
    // each catalogue query resolves. `getByRole('combobox', { name })`
    // proves BOTH the real ARIA role AND the accessible name in one
    // assertion — the trigger is a reka-ui `<button role="combobox">`, not
    // the labelable element `getByLabelText` itself resolves to for a
    // non-native control.
    expect(await screen.findByRole('combobox', { name: 'Retailer' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Company' })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: 'Product' })).toBeInTheDocument();
    expect(screen.getByLabelText('Currency')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Unit price override')).toBeInTheDocument();
    expect(screen.getByLabelText('Line discount')).toBeInTheDocument();
  });
});
