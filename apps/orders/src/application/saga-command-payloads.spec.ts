// BI21 (billing_invoicing design.md §12, requirements.md §2.6 — open-point
// row 5, approved at the gate). The correction carried into this feature's
// brief is explicit: the defect is reachable TODAY through the real
// `orders.create` path (`orders-create.dto.ts` already accepts
// `lineDiscount`, `orders-create.controller.ts` already passes it through,
// and `place-order.handler.spec.ts` already places an order with
// `lineDiscount: 300` on a green suite) — not merely "latent until the
// Gateway exists". A domain-only unit test that hand-builds a fake `Order`
// object does not discharge this: it would prove `buildSagaCommandPayload`
// reads a `discount` property, but not that the property it reads is the
// SAME number `credit.hold` was placed against.
//
// So this test drives the REAL construction path — `PlaceOrderHandler`,
// the exact class `apps/orders/src/presentation/orders-create.controller.ts`
// calls, with every port faked exactly as `place-order.handler.spec.ts`
// fakes them (never a hand-rolled `Order`-shaped object) — to build a
// genuinely discounted `Order`, then feeds THAT order into
// `buildSagaCommandPayload` for both `credit.hold` (already-correct today)
// and `invoice.issue` (this feature's fix), and asserts the two agree:
// `invoice.issue`'s `discount` is non-zero and equals the order's
// `initialDiscount`, and the invoice's GROSS `amount` (computed the same
// way Billing's `Invoice.issue` derives it — Σ unitPrice × units — minus
// that `discount`) equals exactly the `credit.hold` request's `amount` —
// the order's NET `totalAmount`. The saga.md §3.1 step 0/4 causal chain
// (`orders.create` → `credit.hold` → … → `invoice.issue`) is what makes
// this comparison meaningful: both requests are built from the SAME loaded
// order (design.md §6.3), so a divergence here is exactly the defect BI21
// closes.
import { GLN, Money, OrderNumber } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { CreditHoldRequestPayload, InvoiceIssueRequestPayload } from '@otc/contracts';
import type { Clock } from './ports/clock.port';
import type { OrderNumberAllocator } from './ports/order-number-allocator.port';
import type { OrderReferenceData, OrderReferenceDataPort } from './ports/order-reference-data.port';
import type { OrderRepository } from './ports/order-repository.port';
import type { StockAvailabilityPort, StockAvailabilityResult } from './ports/stock-availability.port';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port';
import { PlaceOrderHandler, type PlaceOrderCommand } from './place-order.handler';
import type { Order } from '../domain/order';
import { buildSagaCommandPayload } from './saga-command-payloads';

const FIXTURE_CURRENCY = 'EUR';
const FIXTURE_RETAILER_CODE = 'RET-0001';
const FIXTURE_COMPANY_CODE = 'COM-0001';
const FIXTURE_PRODUCT_CODE = 'PRD-0001';

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

class FakeClock implements Clock {
  now(): Date {
    return new Date('2026-08-21T10:00:00.000Z');
  }
}

function fakeReferenceData(): OrderReferenceData {
  return {
    retailer: { code: FIXTURE_RETAILER_CODE, gln: GLN.of('5412345000013') },
    company: { code: FIXTURE_COMPANY_CODE, gln: GLN.of('5412345000037') },
    currencyExists: true,
    products: new Map([
      [FIXTURE_PRODUCT_CODE, { productCode: FIXTURE_PRODUCT_CODE, description: 'Widget', price: Money.of(1_000, FIXTURE_CURRENCY) }],
    ]),
  };
}

/** Drives the REAL `orders.create` construction path — `PlaceOrderHandler.execute` — and returns the persisted `Order`, exactly the object `SagaFactHandler` later loads to build every saga command payload (design.md §6.3). */
async function placeRealOrder(command: Partial<PlaceOrderCommand>): Promise<Order> {
  let saved: Order | undefined;
  const unitOfWork: UnitOfWork = { execute: async (work) => work(fakeTx()) };
  const orders: OrderRepository = {
    save: async (order: Order) => {
      saved = order;
    },
    findById: async () => null,
    findByReference: async () => null,
  };
  const orderNumbers: OrderNumberAllocator = { next: async () => OrderNumber.fromSequence(1) };
  const referenceData: OrderReferenceDataPort = { resolve: async () => fakeReferenceData() };
  const stockAvailability: StockAvailabilityPort = {
    check: async (): Promise<StockAvailabilityResult> => ({
      available: true,
      lines: [{ productCode: FIXTURE_PRODUCT_CODE, requested: 2, available: 10, sufficient: true }],
    }),
  };
  const clock: Clock = new FakeClock();

  const handler = new PlaceOrderHandler(unitOfWork, orders, orderNumbers, referenceData, stockAvailability, clock);
  await handler.execute({
    retailerCode: FIXTURE_RETAILER_CODE,
    companyCode: FIXTURE_COMPANY_CODE,
    currency: FIXTURE_CURRENCY,
    lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 2, lineDiscount: 300 }],
    ...command,
  });

  if (!saved) {
    throw new Error('saga-command-payloads.spec: PlaceOrderHandler did not save an order');
  }
  return saved;
}

describe('buildSagaCommandPayload — BI21: carries the order\'s initial discount on the invoice.issue request so the invoice total equals the order total', () => {
  it('carries the order\'s initial discount on the invoice.issue request so the invoice total equals the order total', async () => {
    const order = await placeRealOrder({});

    // Sanity: the real orders.create path DID compute a genuine, non-zero
    // discount — this is what design §12's correction calls "reachable
    // now", not a fabricated fixture.
    expect(order.initialDiscount.amount).toBe(300);
    expect(order.initialAmount.amount).toBe(2_000);
    expect(order.totalAmount.amount).toBe(1_700);

    const holdPayload = buildSagaCommandPayload('credit.hold', order) as CreditHoldRequestPayload;
    const invoicePayload = buildSagaCommandPayload('invoice.issue', order) as InvoiceIssueRequestPayload;

    // The fix: invoice.issue's discount is non-zero and equals the order's.
    expect(invoicePayload.discount).toBe(300);
    expect(invoicePayload.discount).toBe(order.initialDiscount.amount);

    // The property BI21 exists to guarantee: gross minus discount equals
    // exactly the credit.hold amount for the SAME order — computed the same
    // way Billing's Invoice.issue derives amount/totalAmount (design.md
    // §3.3: amount = Σ unitPrice × units; totalAmount = amount − discount).
    const grossFromInvoiceLines = invoicePayload.lines.reduce((sum, line) => sum + line.unitPrice * line.units, 0);
    const totalAmountFromInvoice = grossFromInvoiceLines - (invoicePayload.discount ?? 0);

    expect(totalAmountFromInvoice).toBe(holdPayload.amount.amount);
    expect(totalAmountFromInvoice).toBe(order.totalAmount.amount);
  });

  it('carries a zero discount when the order has none — the un-discounted case stays unchanged', async () => {
    const order = await placeRealOrder({ lines: [{ productCode: FIXTURE_PRODUCT_CODE, quantity: 2 }] });

    expect(order.initialDiscount.amount).toBe(0);

    const invoicePayload = buildSagaCommandPayload('invoice.issue', order) as InvoiceIssueRequestPayload;

    expect(invoicePayload.discount).toBe(0);
  });
});
