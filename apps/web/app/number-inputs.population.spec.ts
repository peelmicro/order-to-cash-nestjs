// @vitest-environment nuxt
//
// Population guard for number-like boxes (progress/impl_web_number_inputs.md,
// Round 2). A `type="number"` box reports "" for text Chromium cannot parse,
// so a page that reads it loses what the user typed.
//
// The instrument is RENDER-BASED. Round 1's guard scanned `<template>` source
// text for tags and lost three times to forms it did not recognise (an unquoted
// `type=number`, `<component is="input">`, a render function `h('input', …)`),
// so the guard now inspects what actually runs: it mounts every page file
// under `app/pages/**` (the list is derived from the files, by glob), opens
// each form that holds a box, and asks the rendered DOM for
//   - `input[type="number"]` and `[role="spinbutton"]`: there must be none;
//   - every `input[inputmode]`: the set must equal the literal EXPECTED below
//     (five boxes), and each of those must refuse malformed text through the
//     page, with nothing sent, aria-invalid and aria-describedby set.
//
// Premises of this instrument (each is armed; see the record, Round 2):
//   P1 every page file (any extension Nuxt routes: .vue .ts .tsx .js .jsx) is classified here: a new page fails the first test
//      until it has a mounter (and, if it holds boxes, a driver);
//   P2 every page actually mounts: each mounter waits for a literal anchor
//      (the page's h1) and fails, naming the page, if it never appears;
//   P3 every form actually opens: a driver waits for the form's own controls
//      and fails if they never appear;
//   P4 the DOM query really sees number-like boxes however they were built
//      (sentinels below render them through a render function and a dynamic
//      component, the forms that beat the source scanner);
//   P5 only states the drivers reach are seen: the order page is driven in
//      its catalogue-fallback state (text code fields), not with a loaded
//      catalogue, and layouts and `app.vue` are not mounted. This is the
//      instrument's stated limit; `number-inputs.source.spec.ts` (a source
//      pre-check over every .vue under app/) covers a literal number box in
//      any state or layout, and the record demonstrates both limits armed.
import { readBody } from 'h3';
import { describe, expect, it } from 'vitest';
import { registerEndpoint, renderSuspended } from '@nuxt/test-utils/runtime';
import { screen, fireEvent, waitFor } from '@testing-library/vue';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { h, resolveDynamicComponent, type Component } from 'vue';
import type { EventSourceLike } from '@/lib/order-stream-client';

/**
 * Every page file, derived from the files (not a literal), with every extension Nuxt routes under
 * `app/pages` (its default ignore excludes only spec and test files, which are excluded here at the
 * glob, with the same pattern, never by filtering the result).
 */
const PAGE_MODULES = import.meta.glob([
  './pages/**/*.{vue,ts,tsx,js,jsx}',
  '!./pages/**/*.{spec,test}.{js,cts,mts,ts,jsx,tsx}',
]);

const posts = { orders: 0, payments: 0, replenish: 0 };

function stubApi(): void {
  posts.orders = 0;
  posts.payments = 0;
  posts.replenish = 0;
  const page = (items: unknown[]) => ({ items, page: { page: 1, pageSize: 20, total: items.length } });
  registerEndpoint('/api/catalog/retailers', () => ({ items: [] }));
  registerEndpoint('/api/catalog/companies', () => ({ items: [] }));
  registerEndpoint('/api/catalog/products', () => ({ items: [] }));
  registerEndpoint('/api/credits', () => page([]));
  registerEndpoint('/api/orders', async (event) => {
    if (event.method === 'POST') {
      await readBody(event);
      posts.orders += 1;
      return { orderId: 'order-1', orderReference: 'ORD-000001', status: 'placed', currency: 'EUR', orderDate: new Date().toISOString() };
    }
    return page([]);
  });
  registerEndpoint('/api/orders/order-1', () => ({
    orderId: 'order-1', orderReference: 'ORD-000001', status: 'placed', cancellationReason: null, currency: 'EUR',
    totals: { initialAmount: 24999, initialDiscount: 0, totalAmount: 24999 },
    retailer: { code: 'CarrefourEs', gln: '1234567890123', name: 'Carrefour Spain' }, company: { code: 'IBERFOODS', gln: '9876543210987', name: 'Iberfoods' },
    events: [], references: {}, headerComplete: true, updatedAt: '2026-08-27T10:00:00.000Z',
  }));
  registerEndpoint('/api/invoices', () =>
    page([{ invoiceId: 'inv-1', invoiceReference: 'INV-000027', invoiceDate: '2026-08-18T10:00:00.000Z', orderReference: 'ORD-000042', retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', currency: 'EUR', amount: 24999, discount: 0, totalAmount: 24999, status: 'issued', paidAt: null }]),
  );
  registerEndpoint('/api/invoices/inv-1/payments', {
    method: 'POST',
    handler: async (event) => {
      const body = await readBody<{ paymentReference: string }>(event);
      posts.payments += 1;
      return { outcome: 'accepted', paymentReference: body.paymentReference, invoiceReference: 'INV-000027', orderReference: 'ORD-000042', invoiceStatus: 'paid', paidAt: '2026-08-28T10:00:00.000Z' };
    },
  });
  registerEndpoint('/api/stock', () => page([{ companyCode: 'IBERFOODS', productCode: 'PRD-0001', productName: 'Widget', units: 40, reservedUnits: 10, availableUnits: 30, lowStockThreshold: 20 }]));
  registerEndpoint('/api/stock/replenish', {
    method: 'POST',
    handler: async (event) => {
      await readBody(event);
      posts.replenish += 1;
      return { items: [] };
    },
  });
}

async function mountPage(key: string, props: Record<string, unknown> = {}, route?: string): Promise<void> {
  const loader = PAGE_MODULES[key];
  if (!loader) throw new Error(`${key}: not a page file`);
  const component = ((await loader()) as { default: Component }).default;
  await renderSuspended(component, {
    props,
    ...(route ? { route } : {}),
    global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] },
  });
}

/** P2: the page is really on screen, shown by its own heading. */
async function expectAnchor(heading: string): Promise<void> {
  await screen.findByRole('heading', { name: heading }, { timeout: 4000 });
}

const fakeStream = (): EventSourceLike => Object.assign(new EventTarget(), { readyState: 1, close: () => undefined }) as unknown as EventSourceLike;

interface Member {
  testId: string;
  /** The sentence prefix the refusal must carry, naming the field. */
  label: string;
}

interface BoxPage {
  /** Mounts the page and opens the form that holds the boxes (P2, P3). */
  mount: () => Promise<void>;
  members: Member[];
  /** Types `text` into the box and triggers the page's own submit path. */
  refuse: (member: Member, text: string) => Promise<void>;
  posted: () => number;
}

const PLACE = './pages/orders/place.vue';
const BILLING = './pages/billing/index.vue';
const STOCK = './pages/stock/index.vue';

/** Pages that hold number-like boxes: the literal expected set of five lives in `members`. */
const BOX_PAGES: Record<string, BoxPage> = {
  [PLACE]: {
    async mount() {
      stubApi();
      await mountPage(PLACE);
      await expectAnchor('Place order');
      await fireEvent.update(screen.getByPlaceholderText('e.g. CarrefourEs'), 'CarrefourEs');
      await fireEvent.update(screen.getByPlaceholderText('e.g. IBERFOODS'), 'IBERFOODS');
      await fireEvent.update(screen.getByPlaceholderText('e.g. PRD-0001'), 'PRD-0001');
      await screen.findByTestId('quantity-input'); // P3: the line's boxes are on screen
    },
    members: [
      { testId: 'quantity-input', label: 'Line 1 quantity' },
      { testId: 'unit-price-input', label: 'Line 1 unit price override' },
      { testId: 'line-discount-input', label: 'Line 1 line discount' },
    ],
    async refuse(member, text) {
      await fireEvent.update(screen.getByTestId(member.testId), text);
      await fireEvent.submit(screen.getByRole('button', { name: /place order/i }).closest('form')!);
    },
    posted: () => posts.orders,
  },
  [BILLING]: {
    async mount() {
      stubApi();
      await mountPage(BILLING);
      await expectAnchor('Billing');
      await fireEvent.click(await screen.findByTestId('register-payment-button'));
      await screen.findByTestId('payment-amount-input'); // P3: the payment form opened
    },
    members: [{ testId: 'payment-amount-input', label: 'Amount' }],
    async refuse(_member, text) {
      await fireEvent.update(screen.getByTestId('payment-amount-input'), text);
      await fireEvent.click(screen.getByTestId('submit-payment-button'));
    },
    posted: () => posts.payments,
  },
  [STOCK]: {
    async mount() {
      stubApi();
      await mountPage(STOCK);
      await expectAnchor('Stock');
      await fireEvent.click(await screen.findByTestId('replenish-button'));
      await screen.findByTestId('replenish-units-input'); // P3: the replenish form opened
    },
    members: [{ testId: 'replenish-units-input', label: 'Units to add' }],
    async refuse(_member, text) {
      await fireEvent.update(screen.getByTestId('replenish-units-input'), text);
      await fireEvent.click(screen.getByTestId('submit-replenish-button'));
    },
    posted: () => posts.replenish,
  },
};

/** Pages with no number-like box: mounted all the same, and the DOM asked the same question (P1, P2). */
const PLAIN_PAGES: Record<string, () => Promise<void>> = {
  './pages/index.vue': async () => {
    stubApi();
    await mountPage('./pages/index.vue'); // a redirect page: it renders an empty div, so there is no heading to wait for
  },
  './pages/login.vue': async () => {
    stubApi();
    await mountPage('./pages/login.vue');
    await screen.findByText('Order-To-Cash');
  },
  './pages/orders/index.vue': async () => {
    stubApi();
    await mountPage('./pages/orders/index.vue');
    await expectAnchor('Orders');
  },
  './pages/orders/[id].vue': async () => {
    stubApi();
    await mountPage('./pages/orders/[id].vue', { orderId: 'order-1', streamFactory: fakeStream }, '/orders/order-1');
    await expectAnchor('Order detail');
  },
};

/** What the rendered DOM holds: number boxes (must be none) and every `inputmode` box. */
function renderedBoxes(): { numberLike: string[]; inputmode: string[] } {
  const describe = (e: Element) => e.getAttribute('data-testid') ?? `(no data-testid) ${e.outerHTML.slice(0, 80)}`;
  return {
    numberLike: [...document.body.querySelectorAll('input[type="number"], [role="spinbutton"]')].map(describe),
    inputmode: [...document.body.querySelectorAll('input[inputmode]')].map(describe).sort(),
  };
}

const PAGE_FILES = Object.keys(PAGE_MODULES).sort();
const CLASSIFIED = [...Object.keys(BOX_PAGES), ...Object.keys(PLAIN_PAGES)].sort();

describe('number-like boxes — population (render-based)', () => {
  it('P1: every page file under app/pages is classified here, and every classified page still exists', () => {
    expect(PAGE_FILES.filter((f) => !CLASSIFIED.includes(f)).join(' | '), 'page files with no mounter or driver').toBe('');
    expect(CLASSIFIED.filter((f) => !PAGE_FILES.includes(f)).join(' | '), 'classified pages that no longer exist').toBe('');
  });

  it('the expected set is the literal five boxes', () => {
    expect(Object.values(BOX_PAGES).flatMap((p) => p.members.map((m) => m.testId)).sort()).toEqual(
      ['line-discount-input', 'payment-amount-input', 'quantity-input', 'replenish-units-input', 'unit-price-input'],
    );
  });

  describe.each(Object.keys(BOX_PAGES))('%s (holds boxes)', (key) => {
    const driver = BOX_PAGES[key]!;

    it('renders no number box, and exactly its expected inputmode boxes', async () => {
      await driver.mount();
      const { numberLike, inputmode } = renderedBoxes();
      expect(numberLike.join(' | '), 'type="number" or spinbutton boxes in the rendered DOM').toBe('');
      expect(inputmode).toEqual(driver.members.map((m) => m.testId).sort());
    });

    it.each(BOX_PAGES[key]!.members.map((m) => [m.testId, m] as const))('%s refuses "1e3" in words, sends nothing, and is marked invalid', async (_testId, member) => {
      await driver.mount();
      await driver.refuse(member, '1e3');
      const box = screen.getByTestId(member.testId) as HTMLInputElement;
      await waitFor(() => expect(box.getAttribute('aria-invalid')).toBe('true'));
      const problem = document.getElementById(box.getAttribute('aria-describedby') ?? '');
      expect(problem?.textContent, 'the element aria-describedby points at').toContain(member.label);
      expect(problem?.textContent).toContain('"1e3"');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(driver.posted()).toBe(0);
      expect(box.value).toBe('1e3');
    });
  });

  it.each(Object.keys(PLAIN_PAGES))('%s (no boxes) renders no number box and no inputmode box', async (key) => {
    await PLAIN_PAGES[key]!();
    const { numberLike, inputmode } = renderedBoxes();
    expect(numberLike.join(' | '), 'type="number" or spinbutton boxes in the rendered DOM').toBe('');
    expect(inputmode.join(' | '), 'inputmode boxes on a page listed as having none').toBe('');
  });
});

describe('the instrument — sentinels (P4): the DOM query must see these, however they were built', () => {
  const render = async (child: () => ReturnType<typeof h>) => renderSuspended({ render: () => h('div', [child()]) });

  it('sees an input built by a render function with type number', async () => {
    await render(() => h('input', { type: 'number', 'data-testid': 'sentinel-render-fn' }));
    expect(renderedBoxes().numberLike).toEqual(['sentinel-render-fn']);
  });
  it('sees an input built through a dynamic component', async () => {
    await render(() => h(resolveDynamicComponent('input') as string, { type: 'number', 'data-testid': 'sentinel-dynamic' }));
    expect(renderedBoxes().numberLike).toEqual(['sentinel-dynamic']);
  });
  it('sees a spinbutton role', async () => {
    await render(() => h('div', { role: 'spinbutton', 'data-testid': 'sentinel-role' }));
    expect(renderedBoxes().numberLike).toEqual(['sentinel-role']);
  });
  it('lists an inputmode box and ignores a plain text box', async () => {
    await render(() => h('div', [h('input', { type: 'text', inputmode: 'decimal', 'data-testid': 'sentinel-mode' }), h('input', { type: 'text', 'data-testid': 'sentinel-plain' })]));
    expect(renderedBoxes()).toEqual({ numberLike: [], inputmode: ['sentinel-mode'] });
  });
});
