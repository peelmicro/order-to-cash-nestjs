// @vitest-environment nuxt
//
// Billing view: invoice list + credit limits (R47/R48/R49's own surface —
// invoice status only ever changes via `POST /invoices/{id}/payments`,
// there is no internal timer) and the Register-payment form.
import { createError, getQuery, readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor, within } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import BillingPage from './index.vue';
import type { Credit, Invoice, InvoicePage, CreditPage, RegisterPaymentRequest, RegisterPaymentResponse } from '#shared/types/gateway';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
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
    ...overrides,
  };
}

function mockInvoices(invoices: Invoice[]): void {
  registerEndpoint('/api/invoices', () => ({
    items: invoices,
    page: { page: 1, pageSize: 20, total: invoices.length },
  } satisfies InvoicePage));
}

function makeCredit(overrides: Partial<Credit> = {}): Credit {
  return {
    creditCode: 'CR-000001',
    retailerCode: 'CarrefourEs',
    companyCode: 'IBERFOODS',
    currency: 'EUR',
    creditLimit: 500000,
    activeHolds: 24999,
    openExposure: 0,
    availableCredit: 475001,
    ...overrides,
  };
}

function mockCredits(items: CreditPage['items'] = []): void {
  registerEndpoint('/api/credits', () => ({
    items,
    page: { page: 1, pageSize: 20, total: items.length },
  } satisfies CreditPage));
}

/** Real, query-honouring pagination — used by the pagination test below (Pass 6 review, non-blocking finding #2). */
function mockCreditsPaged(all: Credit[], pageSize: number): void {
  registerEndpoint('/api/credits', (event) => {
    const query = getQuery(event);
    const page = Number(query.page ?? 1);
    const effectivePageSize = Number(query.pageSize ?? pageSize);
    const start = (page - 1) * effectivePageSize;
    return {
      items: all.slice(start, start + effectivePageSize),
      page: { page, pageSize: effectivePageSize, total: all.length },
    } satisfies CreditPage;
  });
}

function mockRetailers(): void {
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
}

// See `app/pages/stock/index.spec.ts` for why a test-only, no-retry
// QueryClient is needed to observe an error state deterministically — the
// app's own production `retry: 1` (or TanStack's built-in `retry: 3`
// default when no queryClient is supplied at all, the gap this test's own
// `renderBilling` had before this pass) otherwise delays/hangs the
// assertion.
function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderBilling() {
  return renderSuspended(BillingPage, { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } });
}

describe('billing/index.vue — invoice list', () => {
  it('renders real invoice rows with correctly formatted decimal amounts, not the raw minor-units integer', async () => {
    mockInvoices([makeInvoice({ totalAmount: 24999 })]);
    mockCredits();
    mockRetailers();

    await renderBilling();

    const row = await screen.findByTestId('invoice-row');
    expect(within(row).getByText('INV-000027')).toBeTruthy();
    expect(within(row).getByText('ORD-000042')).toBeTruthy();
    const totalCell = within(row).getByTestId('invoice-total');
    expect(totalCell.textContent).toContain('249.99');
    expect(totalCell.textContent).not.toContain('24999');
  });

  it('renders credit limits with the amount currently held, as a decimal amount not raw minor units', async () => {
    mockInvoices([]);
    mockCredits([
      {
        creditCode: 'CR-000001',
        retailerCode: 'CarrefourEs',
        companyCode: 'IBERFOODS',
        currency: 'EUR',
        creditLimit: 500000,
        activeHolds: 24999,
        openExposure: 0,
        availableCredit: 475001,
      },
    ]);
    mockRetailers();

    await renderBilling();

    const held = await screen.findByTestId('credit-held');
    expect(held.textContent).toContain('249.99');
    expect(held.textContent).not.toContain('24999');
  });

  it('shows a distinct loading state, then a distinct empty state for invoices', async () => {
    let resolveResponse: (value: InvoicePage) => void;
    const responsePromise = new Promise<InvoicePage>((resolve) => {
      resolveResponse = resolve;
    });

    registerEndpoint('/api/invoices', () => responsePromise);
    mockCredits();
    mockRetailers();

    const renderPromise = renderBilling();

    // While loading, the loading state should be visible
    await waitFor(() => {
      expect(screen.getByTestId('invoices-loading')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('invoices-error')).not.toBeInTheDocument();
    expect(screen.queryByText('No invoices match these filters.')).not.toBeInTheDocument();

    // Resolve the response with empty items
    resolveResponse!({ items: [], page: { page: 1, pageSize: 20, total: 0 } });
    await renderPromise;

    // After loading completes with empty result, the empty state should be visible
    await waitFor(() => {
      expect(screen.queryByTestId('invoices-loading')).not.toBeInTheDocument();
    });
    const emptyText = await screen.findByText('No invoices match these filters.');
    expect(emptyText).toBeTruthy();
    expect(screen.queryByTestId('invoices-error')).not.toBeInTheDocument();
  });
});

describe('billing/index.vue — register payment form', () => {
  it('pre-fills a payment reference suggestion and lets the operator overwrite it', async () => {
    mockInvoices([makeInvoice()]);
    mockCredits();
    mockRetailers();

    await renderBilling();

    await fireEvent.click(await screen.findByTestId('register-payment-button'));

    const referenceInput = screen.getByTestId('payment-reference-input') as HTMLInputElement;
    // A sensible suggestion, not a blank field — mirrors openapi.yaml's own
    // example shape (`PAY-2026-08-18-000019`).
    expect(referenceInput.value).toMatch(/^PAY-\d{4}-\d{2}-\d{2}-000027$/);

    await fireEvent.update(referenceInput, 'PAY-OPERATOR-OVERRIDE');
    expect(referenceInput.value).toBe('PAY-OPERATOR-OVERRIDE');
  });

  it('a typed decimal amount ("19.99", a classic floating-point-error-prone amount) round-trips to exactly 1999 minor units on submit', async () => {
    mockInvoices([makeInvoice()]);
    mockCredits();
    mockRetailers();

    let capturedBody: RegisterPaymentRequest | undefined;
    registerEndpoint('/api/invoices/inv-1/payments', {
      method: 'POST',
      handler: async (event) => {
        capturedBody = await readBody(event);
        return {
          outcome: 'accepted',
          paymentReference: capturedBody!.paymentReference,
          invoiceReference: 'INV-000027',
          orderReference: 'ORD-000042',
          invoiceStatus: 'paid',
          paidAt: '2026-08-28T10:00:00.000Z',
        } satisfies RegisterPaymentResponse;
      },
    });

    await renderBilling();

    await fireEvent.click(await screen.findByTestId('register-payment-button'));
    await fireEvent.update(screen.getByTestId('payment-amount-input'), '19.99');
    await fireEvent.click(screen.getByTestId('submit-payment-button'));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedBody?.amount.amount).toBe(1999);
    expect(capturedBody?.amount.currency).toBe('EUR');
  });

  it('R47/R48/B10 — idempotency is made visible: a duplicate paymentReference renders a distinct "already recorded" outcome, not a second success', async () => {
    mockInvoices([makeInvoice()]);
    mockCredits();
    mockRetailers();

    let callCount = 0;
    registerEndpoint('/api/invoices/inv-1/payments', {
      method: 'POST',
      handler: async (event) => {
        const body = await readBody<RegisterPaymentRequest>(event);
        callCount += 1;
        // First call: a genuinely new remittance. Second call: the exact
        // same `paymentReference` replayed (B10) — the server's own
        // contract answers `outcome: 'duplicate'`, not a second `accepted`.
        return {
          outcome: callCount === 1 ? 'accepted' : 'duplicate',
          paymentReference: body.paymentReference,
          invoiceReference: 'INV-000027',
          orderReference: 'ORD-000042',
          invoiceStatus: 'paid',
          paidAt: '2026-08-28T10:00:00.000Z',
        } satisfies RegisterPaymentResponse;
      },
    });

    await renderBilling();

    // First submission — a genuinely new payment.
    await fireEvent.click(await screen.findByTestId('register-payment-button'));
    const firstReference = (screen.getByTestId('payment-reference-input') as HTMLInputElement).value;
    await fireEvent.click(screen.getByTestId('submit-payment-button'));
    await screen.findByTestId('payment-outcome-accepted');
    expect(screen.queryByTestId('payment-outcome-duplicate')).toBeNull();

    // Close and reopen on the same still-`issued`-labelled invoice (this
    // suite's own `/api/invoices` mock is static) — the suggestion is
    // deterministic, so it re-fills to the exact same reference, exactly
    // the scenario an operator double-registering the same remittance (or
    // a retried robot call) produces for real.
    await fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await fireEvent.click(screen.getByTestId('register-payment-button'));
    expect((screen.getByTestId('payment-reference-input') as HTMLInputElement).value).toBe(firstReference);

    await fireEvent.click(screen.getByTestId('submit-payment-button'));

    const duplicateOutcome = await screen.findByTestId('payment-outcome-duplicate');
    expect(duplicateOutcome.textContent).toMatch(/already recorded/i);
    expect(screen.queryByTestId('payment-outcome-accepted')).toBeNull();
    expect(callCount).toBe(2);
  });

  it('a rejected remittance (409/422) surfaces the server\'s own reason, and does NOT reappear when the form is reopened on a different invoice (Pass 6 review, non-blocking finding #1)', async () => {
    mockInvoices([makeInvoice({ invoiceId: 'inv-1', invoiceReference: 'INV-000027' }), makeInvoice({ invoiceId: 'inv-2', invoiceReference: 'INV-000028' })]);
    mockCredits();
    mockRetailers();

    registerEndpoint('/api/invoices/inv-1/payments', {
      method: 'POST',
      handler: () => {
        throw createError({
          statusCode: 422,
          statusMessage: 'Unprocessable Entity',
          data: { code: 'PAYMENT_MISMATCH', title: 'Payment amount or currency does not match the invoice', detail: 'Payment amount 100 does not match invoice total 24999' },
        });
      },
    });

    await renderBilling();

    const buttons = await screen.findAllByTestId('register-payment-button');
    await fireEvent.click(buttons[0]!);
    await fireEvent.click(screen.getByTestId('submit-payment-button'));

    const errorEl = await screen.findByTestId('payment-error');
    expect(errorEl.textContent).toMatch(/payment amount 100 does not match invoice total 24999/i);

    await fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    const buttonsAfter = await screen.findAllByTestId('register-payment-button');
    await fireEvent.click(buttonsAfter[1]!);

    expect(screen.queryByTestId('payment-error')).not.toBeInTheDocument();
  });
});

// ── Error-handling sweep (feature 29 pass 7) ────────────────────────────────
describe('billing/index.vue — invoices/credits error states', () => {
  it('a failed GET /api/invoices renders a visible, distinct error — not an empty table, not a stuck spinner', async () => {
    registerEndpoint('/api/invoices', () => {
      throw createError({
        statusCode: 503,
        statusMessage: 'Gateway request failed',
        data: { code: 'UPSTREAM_UNAVAILABLE', title: 'The owning context is unreachable', detail: 'RPC call to "billing.invoice.list" failed: no responder is subscribed to this subject' },
      });
    });
    mockCredits();
    mockRetailers();

    await renderBilling();

    const errorEl = await screen.findByTestId('invoices-error');
    expect(errorEl.textContent).toMatch(/no responder is subscribed to this subject/i);
    expect(screen.queryByText('No invoices match these filters.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoices-loading')).not.toBeInTheDocument();
  });

  it('a failed GET /api/credits renders a visible, distinct error, independent of the invoice list\'s own state', async () => {
    mockInvoices([makeInvoice()]);
    mockRetailers();
    registerEndpoint('/api/credits', () => {
      throw createError({
        statusCode: 503,
        statusMessage: 'Gateway request failed',
        data: { code: 'UPSTREAM_TIMEOUT', title: 'The owning context did not answer within the deadline', detail: 'RPC call to "billing.credit.list" timed out after 5000ms' },
      });
    });

    await renderBilling();

    const errorEl = await screen.findByTestId('credits-error');
    expect(errorEl.textContent).toMatch(/rpc call to "billing\.credit\.list" timed out/i);
    expect(screen.queryByText('No credit lines match this filter.')).not.toBeInTheDocument();
    // The invoice list itself is unaffected — this endpoint failing does not swallow or corrupt the other table's own state.
    await screen.findByTestId('invoice-row');
  });
});

describe('billing/index.vue — credit limits: pagination and filter (Pass 6 review, non-blocking finding #2)', () => {
  it('paginates rather than fetching/rendering every credit row unbounded', async () => {
    mockInvoices([]);
    mockRetailers();
    const all = Array.from({ length: 25 }, (_, i) => makeCredit({ creditCode: `CR-${String(i + 1).padStart(6, '0')}`, retailerCode: `Retailer${i}` }));
    mockCreditsPaged(all, 20);

    await renderBilling();

    const rows = await screen.findAllByTestId('credit-row');
    expect(rows.length).toBe(20);
    expect(screen.getByText(/page 1 of 2/i)).toBeTruthy();

    await fireEvent.click(screen.getByTestId('credits-next'));

    await waitFor(async () => {
      const rowsAfter = await screen.findAllByTestId('credit-row');
      expect(rowsAfter.length).toBe(5);
    });
  });

  it('the retailer filter narrows the credit list — selecting a real retailer changes the query sent to /api/credits', async () => {
    mockInvoices([]);
    registerEndpoint('/api/catalog/retailers', () => ({ items: [{ code: 'CarrefourEs', name: 'Carrefour España', country: 'ES', currency: 'EUR', enabled: true }] }));

    let lastRetailerCode: unknown;
    registerEndpoint('/api/credits', (event) => {
      lastRetailerCode = getQuery(event).retailerCode;
      return { items: [makeCredit()], page: { page: 1, pageSize: 20, total: 1 } } satisfies CreditPage;
    });

    await renderBilling();
    await screen.findByTestId('credit-row');
    expect(lastRetailerCode).toBeUndefined();

    // Same reka-ui keyboard-open + double-pointerUp interaction documented
    // in `orders/place.currency.spec.ts` (real mouse `pointerdown` opens it
    // in a real browser; happy-dom needs the keyboard path, and the first
    // `pointerup` is deliberately spent on reka-ui's own "don't let the
    // opening click also select" guard).
    await fireEvent.keyDown(await screen.findByTestId('credit-retailer-filter-trigger'), { key: 'Enter' });
    const option = await screen.findByRole('option', { name: 'Carrefour España (CarrefourEs)' });
    await fireEvent.pointerUp(option);
    await fireEvent.pointerUp(option);

    await waitFor(() => expect(lastRetailerCode).toBe('CarrefourEs'));
  });
});

// D8 regression guard (progress/review_sonarqube_quality_gates.md, second
// review) — see `orders/index.spec.ts` for the full rationale. This page has
// TWO "Retailer"-labelled filters (credit limits + invoices), hence
// `getAllByLabelText` rather than `getByLabelText`.
describe('billing/index.vue — accessible filter controls and table headers (D8 guard)', () => {
  it('the credit-limits Retailer filter and the invoices Status/Retailer filters resolve by their visible label', async () => {
    mockInvoices([]);
    mockCredits([]);
    mockRetailers();

    await renderBilling();

    expect(await screen.findAllByLabelText('Retailer')).toHaveLength(2);
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('both tables (credit limits, invoices) expose real column headers (role=columnheader, scope=col)', async () => {
    mockInvoices([makeInvoice()]);
    mockCredits([makeCredit()]);
    mockRetailers();

    await renderBilling();

    await screen.findByTestId('credit-row');
    await screen.findByTestId('invoice-row');

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(6 + 8); // credit-limits table + invoices table
    headers.forEach((header) => expect(header).toHaveAttribute('scope', 'col'));
  });
});
