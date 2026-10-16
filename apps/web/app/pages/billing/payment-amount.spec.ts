// @vitest-environment nuxt
//
// Register payment amount box (billing/index.vue). It was `type="number"`:
// Chromium reports "" for "1-2" / "12e" / "19.99-" / "5-", the Submit button
// stayed disabled with no word said, and "19.999" (3 decimals for EUR) made
// the handler return silently. It is now a text box; any text that is not an
// amount in the invoice's currency is refused in words, nothing is sent.
// Probe evidence: progress/impl_web_number_inputs.md.
import { readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import BillingPage from './index.vue';
import type { Invoice, InvoicePage, CreditPage, RegisterPaymentRequest, RegisterPaymentResponse } from '#shared/types/gateway';

const invoice: Invoice = {
  invoiceId: 'inv-1',
  invoiceReference: 'INV-000027',
  invoiceDate: '2026-08-18T10:00:00.000Z',
  orderReference: 'ORD-000042',
  retailerCode: 'CarrefourEs',
  companyCode: 'IBERFOODS',
  currency: 'EUR',
  amount: 24999,
  discount: 0,
  totalAmount: 24999,
  status: 'issued',
  paidAt: null,
};

const posted: RegisterPaymentRequest[] = [];

async function openPaymentForm(): Promise<void> {
  posted.length = 0;
  registerEndpoint('/api/invoices', () => ({ items: [invoice], page: { page: 1, pageSize: 20, total: 1 } } satisfies InvoicePage));
  registerEndpoint('/api/credits', () => ({ items: [], page: { page: 1, pageSize: 20, total: 0 } } satisfies CreditPage));
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/invoices/inv-1/payments', {
    method: 'POST',
    handler: async (event) => {
      const body = await readBody<RegisterPaymentRequest>(event);
      posted.push(body);
      return { outcome: 'accepted', paymentReference: body.paymentReference, invoiceReference: 'INV-000027', orderReference: 'ORD-000042', invoiceStatus: 'paid', paidAt: '2026-08-28T10:00:00.000Z' } satisfies RegisterPaymentResponse;
    },
  });
  await renderSuspended(BillingPage, { global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] } });
  await fireEvent.click(await screen.findByTestId('register-payment-button'));
}

// None is a substring of another; none is the pre-filled "249.99" nor the control "19.99".
const MALFORMED_AMOUNTS = ['1-2', '12e', '19.99-', '5-', '19.999', '  ', 'abc', '1,5', '1e3', '1e-2'];

describe('billing/index.vue — payment-amount-input refuses text that is not an amount', () => {
  it.each(MALFORMED_AMOUNTS)('payment-amount-input refuses %j in words naming the field, sends nothing, and keeps the typed text', async (text) => {
    await openPaymentForm();
    const box = screen.getByTestId('payment-amount-input') as HTMLInputElement;
    await fireEvent.update(box, text);

    await fireEvent.click(screen.getByTestId('submit-payment-button'));

    const problem = await screen.findByTestId('payment-amount-problem');
    expect(problem.textContent).toContain('Amount');
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

  it('payment-amount-input: an EMPTY box is refused in words (Submit is not disabled by empty text) and nothing is sent', async () => {
    await openPaymentForm();
    const box = screen.getByTestId('payment-amount-input') as HTMLInputElement;
    await fireEvent.update(box, '');
    const submit = screen.getByTestId('submit-payment-button');
    expect(submit).not.toBeDisabled();

    await fireEvent.click(submit);

    expect((await screen.findByTestId('payment-amount-problem')).textContent).toContain('Amount is required');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it('payment-amount-input: a well-formed amount above the largest safe integer in minor units is refused as "too large"', async () => {
    await openPaymentForm();
    await fireEvent.update(screen.getByTestId('payment-amount-input'), '90071992547409.92');
    await fireEvent.click(screen.getByTestId('submit-payment-button'));
    expect((await screen.findByTestId('payment-amount-problem')).textContent).toContain('Amount is too large');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(0);
  });

  it('payment-amount-input: the problem goes away as soon as the text changes', async () => {
    await openPaymentForm();
    await fireEvent.update(screen.getByTestId('payment-amount-input'), '5-');
    await fireEvent.click(screen.getByTestId('submit-payment-button'));
    await screen.findByTestId('payment-amount-problem');

    await fireEvent.update(screen.getByTestId('payment-amount-input'), '5');

    expect(screen.queryByTestId('payment-amount-problem')).not.toBeInTheDocument();
  });

  it('payment-amount-input controls: "19.99" is sent as 1999 and "0.29" as 29, with no problem shown', async () => {
    await openPaymentForm();
    await fireEvent.update(screen.getByTestId('payment-amount-input'), '19.99');
    await fireEvent.click(screen.getByTestId('submit-payment-button'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.amount).toEqual({ amount: 1999, currency: 'EUR' });
    expect(screen.queryByTestId('payment-amount-problem')).not.toBeInTheDocument();
  });

  it('payment-amount-input control: "0.29" is sent as 29', async () => {
    await openPaymentForm();
    await fireEvent.update(screen.getByTestId('payment-amount-input'), '0.29');
    await fireEvent.click(screen.getByTestId('submit-payment-button'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.amount).toEqual({ amount: 29, currency: 'EUR' });
  });
});
