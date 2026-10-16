// @vitest-environment nuxt
//
// Unit price override and line discount boxes (orders/place.vue). They were
// `type="number"` inside a form, which Chromium's native validation refused
// with a bubble that does not name the field and that a `novalidate` would
// silently remove. They are now text boxes (`inputmode` from the currency's
// exponent): empty means "not typed" (catalogue price, no discount), any
// other text that is not an amount in the form's currency is refused in
// words naming the line and the field, nothing sent, nothing substituted.
// Probe evidence: progress/impl_web_number_inputs.md ("Round 1").
import { readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor } from '@testing-library/vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import PlaceOrderPage from './place.vue';
import type { PlaceOrderRequest } from '#shared/types/gateway';

const posted: PlaceOrderRequest[] = [];

async function renderFilledForm(currency = 'EUR'): Promise<HTMLFormElement> {
  posted.length = 0;
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));
  registerEndpoint('/api/orders', {
    method: 'POST',
    handler: async (event) => {
      posted.push(await readBody(event));
      return { orderId: 'order-1', orderReference: 'ORD-000001', status: 'placed', currency, orderDate: new Date().toISOString() };
    },
  });
  await renderSuspended(PlaceOrderPage, { global: { plugins: [VueQueryPlugin] } });
  await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
  await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');
  await fireEvent.update(screen.getByLabelText('Currency'), currency);
  await fireEvent.update(screen.getByPlaceholderText('e.g. PRD-0001'), 'PRD-0001');
  return screen.getByRole('button', { name: /place order/i }).closest('form')!;
}

// None is a substring of another; none equals a control ("19.99", "0.29", "1.005").
const MALFORMED_AMOUNTS = ['1-2', '12e', '19.99-', '5-', '19.999', '  x', 'abc', '1,5', '1e3', '1e-2'];

const BOXES: [string, string][] = [
  ['unit-price-input', 'Line 1 unit price override'],
  ['line-discount-input', 'Line 1 line discount'],
];

describe.each(BOXES)('orders/place.vue — %s', (testId, label) => {
  it.each(MALFORMED_AMOUNTS)(`${testId} refuses %j in words naming the field, sends nothing, and keeps the typed text`, async (text) => {
    const form = await renderFilledForm();
    const box = screen.getByTestId(testId) as HTMLInputElement;
    await fireEvent.update(box, text);

    await fireEvent.submit(form);

    const problem = await screen.findByTestId('line-amount-problem');
    expect(problem.textContent).toContain(label);
    expect(problem.textContent).toContain(`"${text}"`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
    expect(box.value).toBe(text);
    // A text box: a number box would have reported "" for the malformed text.
    expect(box.type).toBe('text');
    // The box is marked invalid and points at the element holding the problem text.
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const describedBy = box.getAttribute('aria-describedby');
    expect(describedBy, 'aria-describedby must name the problem element').toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(`"${text}"`);
  });

  it(`${testId} control: "19.99" is sent as 1999 and nothing is refused`, async () => {
    const form = await renderFilledForm();
    await fireEvent.update(screen.getByTestId(testId), '19.99');
    await fireEvent.submit(form);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.lines?.[0]).toMatchObject(testId === 'unit-price-input' ? { unitPrice: 1999 } : { lineDiscount: 1999 });
    expect(screen.queryByTestId('line-amount-problem')).not.toBeInTheDocument();
  });

  it(`${testId} control: "0.29" is sent as 29`, async () => {
    const form = await renderFilledForm();
    await fireEvent.update(screen.getByTestId(testId), '0.29');
    await fireEvent.submit(form);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.lines?.[0]).toMatchObject(testId === 'unit-price-input' ? { unitPrice: 29 } : { lineDiscount: 29 });
  });

  it(`${testId}: a well-formed amount above the largest safe integer in minor units is refused as "too large", and nothing is sent`, async () => {
    const form = await renderFilledForm();
    await fireEvent.update(screen.getByTestId(testId), '90071992547409.92');
    await fireEvent.submit(form);
    expect((await screen.findByTestId('line-amount-problem')).textContent).toContain(`${label} is too large`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it(`${testId} control: a valid amount carries no aria-invalid and no aria-describedby`, async () => {
    const form = await renderFilledForm();
    const box = screen.getByTestId(testId);
    await fireEvent.update(box, '19.99');
    await fireEvent.submit(form);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(box.getAttribute('aria-invalid')).toBeNull();
    expect(box.getAttribute('aria-describedby')).toBeNull();
  });

  it(`${testId}: an empty box is "not typed" (no override, no discount), not a refusal`, async () => {
    const form = await renderFilledForm();
    await fireEvent.update(screen.getByTestId(testId), '');
    await fireEvent.submit(form);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.lines?.[0]).not.toHaveProperty(testId === 'unit-price-input' ? 'unitPrice' : 'lineDiscount');
  });

  it(`${testId}: the form's own currency drives parsing: "1.005" is 1005 in BHD (3 decimals) and the box asks for the decimal keyboard`, async () => {
    const bhd = await renderFilledForm('BHD');
    await fireEvent.update(screen.getByTestId(testId), '1.005');
    await fireEvent.submit(bhd);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.lines?.[0]).toMatchObject(testId === 'unit-price-input' ? { unitPrice: 1005 } : { lineDiscount: 1005 });
    expect(screen.getByTestId(testId).getAttribute('inputmode')).toBe('decimal');
  });

  it(`${testId}: "1.005" is refused in EUR (2 decimals), naming the field`, async () => {
    const form = await renderFilledForm('EUR');
    await fireEvent.update(screen.getByTestId(testId), '1.005');
    await fireEvent.submit(form);
    expect((await screen.findByTestId('line-amount-problem')).textContent).toContain('up to 2 decimals');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it(`${testId}: "19.5" is refused in JPY, which has no decimals, and asks for the numeric keyboard`, async () => {
    const jpy = await renderFilledForm('JPY');
    await fireEvent.update(screen.getByTestId(testId), '19.5');
    await fireEvent.submit(jpy);
    expect((await screen.findByTestId('line-amount-problem')).textContent).toContain('JPY has no decimals');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
    expect(screen.getByTestId(testId).getAttribute('inputmode')).toBe('numeric');
  });
});

// A9: a total built from a refused box is unknown, not a catalogue-price fallback and not a 0.
describe('orders/place.vue — the running total is unknown while a box holds a refused text', () => {
  const eur = (amount: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(amount);

  it('shows 2 x 19.99 = 39.98 for valid boxes, then "—" (no number) when the unit price, the discount or the quantity holds a refused text', async () => {
    await renderFilledForm();
    await fireEvent.update(screen.getByTestId('quantity-input'), '2');
    await fireEvent.update(screen.getByTestId('unit-price-input'), '19.99');
    const total = screen.getByTestId('running-total');
    expect(total.textContent?.trim()).toBe(eur(39.98));

    await fireEvent.update(screen.getByTestId('unit-price-input'), '19.99-');
    expect(total.textContent?.trim()).toBe('—');
    await fireEvent.update(screen.getByTestId('unit-price-input'), '19.99');
    expect(total.textContent?.trim()).toBe(eur(39.98));

    await fireEvent.update(screen.getByTestId('line-discount-input'), '5-');
    expect(total.textContent?.trim()).toBe('—');
    await fireEvent.update(screen.getByTestId('line-discount-input'), '');
    expect(total.textContent?.trim()).toBe(eur(39.98));

    await fireEvent.update(screen.getByTestId('quantity-input'), '1-2');
    expect(total.textContent?.trim()).toBe('—');
  });
});
