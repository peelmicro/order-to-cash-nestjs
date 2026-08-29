import { expect, test } from '@playwright/test';

/**
 * Scenario 1 (happy path to `completed`) + Scenario 3 (payment flips the
 * invoice to `paid`), deliberately combined into one order/one test — per
 * the brief, these overlap, so this places exactly one order rather than
 * two where one will do, while still asserting each fact explicitly.
 *
 * Synchronisation rule (binding, CLAUDE.md / feature 16's review): every
 * wait below is for a TERMINAL or MONOTONIC fact — `invoiced` (the saga's
 * own resting point until a human registers a payment), `paid` on the
 * invoice (never reverts), `completed` on the order (terminal). Nothing
 * here ever polls for a transient mid-saga status
 * (`stock_reserved`/`credit_approved`/`confirmed`/`despatched`), which the
 * correct saga leaves within a single poll interval by construction.
 */
test('an order with a non-.99 total reaches completed, and the invoice explicitly flips to paid', async ({ page }) => {
  await page.goto('/orders/place');

  // Retailer: CarrefourEs. Company: ALBIONFOODS. Neither pairing is enforced
  // server-side (confirmed live against the real Gateway before writing this
  // test — an arbitrary valid retailer/company pair is accepted). ALBIONFOODS
  // is used specifically because it (unlike e.g. IBERFOODS) carries real
  // seeded stock for PRD-0006 (`GET /stock`, confirmed live) — a company
  // with zero stock for the chosen product would fail the acceptance-time
  // availability check (409/STOCK_UNAVAILABLE), an unrelated failure this
  // test does not exist to cover.
  await page.getByTestId('retailer-select-trigger').click();
  await page.getByRole('option', { name: /CarrefourEs/ }).click();

  await page.getByTestId('company-select-trigger').click();
  await page.getByRole('option', { name: /ALBIONFOODS/ }).click();

  // PRD-0006 (Paint Roller Kit) is 645 minor units (6.45) — 2 units is 1290
  // (12.90), a total that does NOT end in .99, so this order must NOT
  // trigger the credit-rejection compensation path (that is Scenario 2's
  // job, in compensation.spec.ts).
  await page.getByTestId('product-select-trigger').click();
  await page.getByRole('option', { name: /PRD-0006/ }).click();
  await page.getByTestId('quantity-input').fill('2');

  const submit = page.getByRole('button', { name: 'Place order', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();

  const success = page.getByTestId('place-order-success');
  await expect(success).toBeVisible();
  const successText = await success.innerText();
  const orderReference = successText.match(/Order (ORD-\d+) accepted/)?.[1];
  expect(orderReference, `expected the success banner to name an ORD-nnnnnn reference, got: "${successText}"`).toBeTruthy();

  // Real navigation through the app's own "order list" link, not a direct
  // page.goto — proves the success banner's link genuinely works.
  await page.getByRole('link', { name: 'order list' }).click();
  await expect(page).toHaveURL(/\/orders$/);

  const orderLink = page.getByRole('link', { name: orderReference! });
  await expect(orderLink).toBeVisible({ timeout: 30_000 });
  await orderLink.click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);

  // Terminal/monotonic wait #1: `invoiced` is where the automatic part of
  // the saga rests until a human registers a payment — not a state the
  // correct saga leaves on its own within a poll interval.
  await expect(page.getByTestId('order-detail-status')).toHaveText('invoiced', { timeout: 30_000 });

  await page.goto('/billing');

  const invoiceRow = page.locator('[data-testid="invoice-row"]').filter({ hasText: orderReference! });
  await expect(invoiceRow).toBeVisible({ timeout: 30_000 });

  await invoiceRow.getByTestId('register-payment-button').click();

  const paymentForm = page.getByTestId('payment-form');
  await expect(paymentForm).toBeVisible();

  // Pre-filled by the page itself (paymentReference from the invoice
  // reference, amount from the invoice's own totalAmount) — submitted as-is,
  // exactly the "register payment through the billing UI button" step the
  // brief names.
  const submitPayment = paymentForm.getByTestId('submit-payment-button');
  await expect(submitPayment).toBeEnabled();
  await submitPayment.click();

  await expect(paymentForm.getByTestId('payment-outcome-accepted')).toBeVisible({ timeout: 30_000 });

  // Scenario 3, explicit: the invoice ROW's own status badge (not merely
  // inferred from the order later reaching `completed`) flips to `paid`.
  // `paid` is itself terminal for an invoice (openapi.yaml: invoices only
  // ever go issued -> paid, never back), so this is monotonic evidence too.
  await expect(invoiceRow.getByText('paid', { exact: true })).toBeVisible({ timeout: 30_000 });

  const viewOrderLink = paymentForm.getByTestId('view-order-link');
  await expect(viewOrderLink).toBeVisible({ timeout: 30_000 });
  await viewOrderLink.click();

  // Terminal/monotonic wait #2: `completed`, the saga's genuine terminal
  // state on the happy path — never caught mid-flight at `paid` on the order
  // itself (which the saga leaves immediately for `completed`).
  await expect(page.getByTestId('order-detail-status')).toHaveText('completed', { timeout: 30_000 });
});
