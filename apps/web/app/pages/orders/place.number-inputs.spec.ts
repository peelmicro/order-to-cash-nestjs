// @vitest-environment nuxt
//
// Number boxes that lose malformed text (found in #9's web app, probed in #7's
// production build under Chromium: progress/impl_web_number_inputs.md). The
// quantity box was `type="number"`: Chromium reports "" for "1-2" and the
// page rewrote the box, so the order went out with a quantity the user did
// not type. It is now a text box, and the page must refuse text that is not
// a whole number of 1 or more: in words naming the line, nothing sent, no
// quantity substituted.
//
// The unit price and line discount boxes follow the same rule: see
// `place.amount-inputs.spec.ts`; `number-inputs.population.spec.ts` guards all five.
import { readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PlaceOrderPage from './place.vue';
import type { PlaceOrderRequest } from '#shared/types/gateway';

const posted: PlaceOrderRequest[] = [];

function registerEndpoints(): void {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));
  registerEndpoint('/api/orders', {
    method: 'POST',
    handler: async (event) => {
      posted.push(await readBody(event));
      return { orderId: 'order-1', orderReference: 'ORD-000001', status: 'placed', currency: 'EUR', orderDate: new Date().toISOString() };
    },
  });
}

async function renderFilledForm(): Promise<HTMLFormElement> {
  posted.length = 0;
  registerEndpoints();
  await renderSuspended(PlaceOrderPage, { global: { plugins: [VueQueryPlugin] } });
  await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
  await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');
  await fireEvent.update(screen.getByPlaceholderText('e.g. PRD-0001'), 'PRD-0001');
  return screen.getByRole('button', { name: /place order/i }).closest('form')!;
}

// None is a substring of another, and each differs from the control "3".
const MALFORMED_QUANTITIES = ['1-2', '12e', '2-', '0', '  ', '1.5', 'abc', '-4', '1e3', '1e-2'];

describe('orders/place.vue — quantity box refuses text that is not a whole number of 1 or more', () => {
  it.each(MALFORMED_QUANTITIES)('quantity-input refuses %j in words naming the line, sends nothing, and keeps the typed text', async (text) => {
    const form = await renderFilledForm();
    const box = screen.getByTestId('quantity-input') as HTMLInputElement;
    await fireEvent.update(box, text);

    await fireEvent.submit(form);

    const problem = await screen.findByTestId('quantity-problem');
    expect(problem.textContent).toContain('Line 1 quantity');
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

  it('quantity-input: an empty box is refused too, not read as "no quantity typed" and dropped', async () => {
    const form = await renderFilledForm();
    await fireEvent.update(screen.getByTestId('quantity-input'), '');

    await fireEvent.submit(form);

    expect((await screen.findByTestId('quantity-problem')).textContent).toContain('Line 1 quantity is required');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it('quantity-input control: "3" is sent as 3 and no problem is shown', async () => {
    const form = await renderFilledForm();
    await fireEvent.update(screen.getByTestId('quantity-input'), '3');

    await fireEvent.submit(form);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.lines?.[0]).toMatchObject({ productCode: 'PRD-0001', quantity: 3 });
    expect(screen.queryByTestId('quantity-problem')).not.toBeInTheDocument();
  });

  it('quantity-input: well-formed digits above the largest safe integer are refused as "too large", not as malformed, and nothing is sent', async () => {
    const form = await renderFilledForm();
    await fireEvent.update(screen.getByTestId('quantity-input'), '9007199254740993');
    await fireEvent.submit(form);
    expect((await screen.findByTestId('quantity-problem')).textContent).toContain('Line 1 quantity is too large');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it('quantity-input control: a valid quantity carries no aria-invalid and no aria-describedby', async () => {
    const form = await renderFilledForm();
    const box = screen.getByTestId('quantity-input');
    await fireEvent.update(box, '3');
    await fireEvent.submit(form);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(box.getAttribute('aria-invalid')).toBeNull();
    expect(box.getAttribute('aria-describedby')).toBeNull();
  });

  it('quantity-input: the problem is not shown before a submit attempt (a half-typed value is not nagged at)', async () => {
    await renderFilledForm();
    await fireEvent.update(screen.getByTestId('quantity-input'), '1-');
    expect(screen.queryByTestId('quantity-problem')).not.toBeInTheDocument();
  });
});
