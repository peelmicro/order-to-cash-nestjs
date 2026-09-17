// @vitest-environment nuxt
//
// SA-5 (backlog id 97), at the call sites: `lib/money.spec.ts` proves the
// money helpers honour a currency's ISO 4217 exponent; these prove each page
// passes the RIGHT currency to them — the invoice's own on the billing
// payment form, the order form's own on place-order — so a caller hard-wired
// to a 2-decimal currency fails here.
import { readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor, within } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import BillingPage from './billing/index.vue';
import PlaceOrderPage from './orders/place.vue';
import type { Invoice, InvoicePage, CreditPage, PlaceOrderRequest, RegisterPaymentRequest, RegisterPaymentResponse } from '#shared/types/gateway';

function jpyInvoice(): Invoice {
  return {
    invoiceId: 'inv-jpy',
    invoiceReference: 'INV-000099',
    invoiceDate: '2026-08-18T10:00:00.000Z',
    orderReference: 'ORD-000099',
    retailerCode: 'CarrefourEs',
    companyCode: 'IBERFOODS',
    currency: 'JPY',
    amount: 24999,
    discount: 0,
    totalAmount: 24999,
    status: 'issued',
    paidAt: null,
  };
}

function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('billing/index.vue — a 0-exponent invoice (JPY)', () => {
  it('renders, pre-fills and submits the amount in whole yen, using the invoice\'s own currency', async () => {
    registerEndpoint('/api/invoices', () => ({ items: [jpyInvoice()], page: { page: 1, pageSize: 20, total: 1 } } satisfies InvoicePage));
    registerEndpoint('/api/credits', () => ({ items: [], page: { page: 1, pageSize: 20, total: 0 } } satisfies CreditPage));
    registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
    let capturedBody: RegisterPaymentRequest | undefined;
    registerEndpoint('/api/invoices/inv-jpy/payments', {
      method: 'POST',
      handler: async (event) => {
        capturedBody = await readBody(event);
        return {
          outcome: 'accepted',
          paymentReference: capturedBody!.paymentReference,
          invoiceReference: 'INV-000099',
          orderReference: 'ORD-000099',
          invoiceStatus: 'paid',
          paidAt: '2026-08-28T10:00:00.000Z',
        } satisfies RegisterPaymentResponse;
      },
    });

    await renderSuspended(BillingPage, { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } });

    const row = await screen.findByTestId('invoice-row');
    expect(within(row).getByTestId('invoice-total').textContent).not.toContain('249.99');

    await fireEvent.click(screen.getByTestId('register-payment-button'));
    const amountInput = screen.getByTestId('payment-amount-input') as HTMLInputElement;
    expect(amountInput.value).toBe('24999');
    expect(amountInput.getAttribute('step')).toBe('1');

    await fireEvent.click(screen.getByTestId('submit-payment-button'));
    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody?.amount).toEqual({ amount: 24999, currency: 'JPY' });
  });
});

describe('orders/place.vue — a 3-exponent order currency (BHD)', () => {
  it('parses the unit price and line discount with the form\'s own currency: "1.005" BHD is 1005, "0.5" BHD is 500', async () => {
    registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
    registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
    registerEndpoint('/api/catalog/products', () => ({ items: [] }));
    let capturedBody: PlaceOrderRequest | undefined;
    registerEndpoint('/api/orders', {
      method: 'POST',
      handler: async (event) => {
        capturedBody = await readBody(event);
        return { orderId: 'order-bhd', orderReference: 'ORD-000100', status: 'placed', currency: 'BHD', orderDate: new Date().toISOString() };
      },
    });

    await renderSuspended(PlaceOrderPage, { global: { plugins: [VueQueryPlugin] } });

    await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
    await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');
    await fireEvent.update(screen.getByLabelText('Currency'), 'BHD');
    await fireEvent.update(screen.getByPlaceholderText('e.g. PRD-0001'), 'PRD-0001');
    await fireEvent.update(screen.getByTestId('unit-price-input'), '1.005');
    await fireEvent.update(screen.getByTestId('line-discount-input'), '0.5');

    expect(screen.getByTestId('unit-price-input').getAttribute('step')).toBe('0.001');
    expect(screen.getByTestId('line-discount-input').getAttribute('step')).toBe('0.001');
    // 1 × 1005 − 500 = 505 fils, shown as 0.505 BHD.
    expect(screen.getByTestId('running-total').textContent?.trim()).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'BHD' }).format(0.505));

    // See `place.unit-price.spec.ts` for why `submit` is dispatched on the form.
    await fireEvent.submit(screen.getByRole('button', { name: /place order/i }).closest('form')!);

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody?.currency).toBe('BHD');
    expect(capturedBody?.lines?.[0]).toMatchObject({ unitPrice: 1005, lineDiscount: 500 });
  });
});
