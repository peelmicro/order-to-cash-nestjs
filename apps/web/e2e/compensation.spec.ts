import { expect, test } from '@playwright/test';

/**
 * Scenario 2: the `.99` compensation path. `fillCompensationDemo()`
 * (`app/pages/orders/place.vue`) constructs exactly 1 × PRD-0001 with an
 * explicit `unitPrice` of 24999 minor units — a total ending in `.99`, which
 * the credit simulator deliberately refuses (`simulated_cents_rule`),
 * triggering the saga's compensation path: stock released, then the order
 * cancelled.
 *
 * Synchronisation rule: waits only for `cancelled` — the saga's genuine
 * terminal state here — never for a mid-compensation state.
 *
 * **D4, on the ordering assertion below.** The credit simulator's `.99`
 * refusal is deterministic, but amendment A1's original defect (`bf59af9`)
 * was a *random* `eventId` tie-break — so this e2e assertion is a
 * probabilistic guard against that defect class (it catches a full,
 * deterministic inversion, as re-armed and confirmed in review, but is not
 * guaranteed to catch every instance of a random tie-break). The
 * deterministic guard for that class is feature 31's black-box
 * `assertCausalOrder` (every entry whose `causationId` names another entry,
 * cause precedes effect, checked for ALL entries, not just this one pair) —
 * treat this test as a real-browser confirmation on top of that guard, not
 * a replacement for it.
 */
test('a .99 order is cancelled with credit_rejected, and the timeline shows both compensation steps in order with the causal link rendered', async ({ page }) => {
  await page.goto('/orders/place');

  await page.getByRole('button', { name: 'Fill demo order (.99 → compensation)' }).click();

  // The demo fill sets retailer/company directly (not through the <Select>
  // components), so the running total should already reflect 24999 minor
  // units (24.999 -> "249.99") before submit — checked as a sanity guard,
  // not the test's main assertion.
  await expect(page.getByTestId('running-total')).toContainText('249.99');

  const submit = page.getByRole('button', { name: 'Place order', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();

  const success = page.getByTestId('place-order-success');
  await expect(success).toBeVisible();
  const successText = await success.innerText();
  const orderReference = successText.match(/Order (ORD-\d+) accepted/)?.[1];
  expect(orderReference, `expected the success banner to name an ORD-nnnnnn reference, got: "${successText}"`).toBeTruthy();

  await page.getByRole('link', { name: 'order list' }).click();
  await expect(page).toHaveURL(/\/orders$/);

  const orderLink = page.getByRole('link', { name: orderReference! });
  await expect(orderLink).toBeVisible({ timeout: 30_000 });
  await orderLink.click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);

  // Terminal/monotonic wait: `cancelled` is where this saga rests forever
  // once the compensation completes — never caught mid-flight at
  // `stock_reserved`/`credit_approved` (both transient here) or at the
  // intermediate `stock.released.v1` fact alone.
  await expect(page.getByTestId('order-detail-status')).toHaveText('cancelled', { timeout: 30_000 });
  await expect(page.getByText('credit_rejected', { exact: true })).toBeVisible();

  const timelineEntries = page.getByTestId('timeline-entry');
  const readEventTypes = () =>
    timelineEntries.evaluateAll((nodes) =>
      nodes.map((node) => {
        const paragraphs = Array.from(node.querySelectorAll('p'));
        // The event-type line is the second <p> inside the entry's text block
        // (first is the human summary) — see orders/[id].vue's template.
        // NOTE: deliberately not `hasText`-filtered locators here — the
        // `order.cancelled.v1` entry's OWN causal-link text also contains
        // the literal string "stock.released.v1" ("caused by
        // stock.released.v1"), so a text-filtered locator for that string
        // resolves to both entries (a real strict-mode collision, found
        // live against the container). Reading each entry's own second <p>
        // avoids the ambiguity entirely.
        return paragraphs[1]?.textContent?.trim() ?? '';
      }),
    );

  // D3: assert the RELATIONSHIP this test actually cares about — both
  // compensation facts present in the rendered timeline — rather than an
  // exact entry count. `toHaveCount(5)` would break the day a legitimate
  // new fact joins this path (a notification fact, say) for a reason
  // entirely unrelated to what this test verifies.
  await expect
    .poll(readEventTypes, { timeout: 30_000, message: 'expected the timeline to include both stock.released.v1 and order.cancelled.v1' })
    .toEqual(expect.arrayContaining(['stock.released.v1', 'order.cancelled.v1']));

  const eventTypesByEntry = await readEventTypes();

  const stockReleasedIndex = eventTypesByEntry.indexOf('stock.released.v1');
  const orderCancelledIndex = eventTypesByEntry.indexOf('order.cancelled.v1');
  expect(stockReleasedIndex, `stock.released.v1 not found among rendered timeline entries: ${JSON.stringify(eventTypesByEntry)}`).toBeGreaterThanOrEqual(0);
  expect(orderCancelledIndex, `order.cancelled.v1 not found among rendered timeline entries: ${JSON.stringify(eventTypesByEntry)}`).toBeGreaterThanOrEqual(0);
  expect(stockReleasedIndex, 'stock.released.v1 must appear BEFORE order.cancelled.v1 in the rendered timeline').toBeLessThan(orderCancelledIndex);

  // Amendment A1's causal edge, rendered: the cancellation entry names
  // "caused by stock.released.v1" — the single end-to-end proof of the
  // defect fixed in bf59af9.
  const cancelledEntry = timelineEntries.nth(orderCancelledIndex);
  const causation = cancelledEntry.getByTestId('timeline-causation');
  await expect(causation).toBeVisible();
  await expect(causation).toContainText('caused by');
  await expect(cancelledEntry.getByTestId('timeline-causation-link')).toHaveText('stock.released.v1');
});
