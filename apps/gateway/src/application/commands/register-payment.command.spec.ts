import { describe, expect, it } from 'vitest';
import {
  INVOICE_LIST_SUBJECT,
  InvoiceNotFoundError,
  InvoiceScanBudgetExceededError,
  OrderNotYetProjectedError,
  PAYMENT_REGISTER_SUBJECT,
  RegisterPaymentCommand,
  RegisterPaymentHandler,
} from './register-payment.command';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';
import { FakeOrderReadModel } from '../../test-support/fake-order-read-model';
import type { OrderTimelineDocumentLike } from '../../domain/projection/order-read-model-mapper';

function invoiceListPage(items: { invoiceId: string; orderReference: string }[]) {
  return {
    items: items.map((item) => ({
      invoiceId: item.invoiceId,
      invoiceReference: 'INV-000027',
      invoiceDate: '2026-08-18T09:00:00.000Z',
      orderReference: item.orderReference,
      retailerCode: 'CarrefourEs',
      companyCode: 'IBERFOODS',
      currency: 'EUR',
      amount: 124250,
      discount: 0,
      totalAmount: 124250,
      status: 'issued',
      paidAt: null,
    })),
    page: { page: 1, pageSize: 200, total: items.length },
  };
}

/** A FULL page (`count` items — pass 200 for a genuinely full page, fewer to simulate the last page of a real result set) of synthetic invoices, none of which match `invoice-1` unless `matchInvoiceId` is supplied. */
function fullInvoiceListPage(count: number, matchInvoiceId?: string) {
  const items = Array.from({ length: count }, (_, i) => ({ invoiceId: `synthetic-invoice-${i}`, orderReference: 'ORD-000042' }));
  if (matchInvoiceId) {
    items[items.length - 1] = { invoiceId: matchInvoiceId, orderReference: 'ORD-000042' };
  }
  return invoiceListPage(items);
}

function projectedOrder(overrides: Partial<OrderTimelineDocumentLike> = {}): OrderTimelineDocumentLike {
  return {
    _id: 'order-1',
    orderId: 'order-1',
    orderReference: 'ORD-000042',
    orderDate: '2026-08-18T09:00:00.000Z',
    retailer: { code: 'CarrefourEs', name: null, gln: null },
    company: { code: 'IBERFOODS', name: null, gln: null },
    status: 'invoiced',
    cancellationReason: null,
    currency: 'EUR',
    totals: { initialAmount: 124250, initialDiscount: 0, totalAmount: 124250 },
    items: [],
    references: { despatchReference: null, invoiceReference: 'INV-000027', paymentReference: null },
    events: [],
    headerComplete: true,
    updatedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

const body = {
  paymentReference: 'PAY-2026-08-18-000019',
  amount: { amount: 124250, currency: 'EUR' },
  valueDate: '2026-08-18T11:02:00.000Z',
  source: 'robot' as const,
};

describe('RegisterPaymentHandler — R47-R49 correlationId=orderId resolution', () => {
  it('resolves invoiceId -> orderReference (billing.invoice.list) -> orderId (read model _id), and sends THAT as x-correlation-id', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(INVOICE_LIST_SUBJECT, invoiceListPage([{ invoiceId: 'invoice-1', orderReference: 'ORD-000042' }]));
    rpc.respondWith(PAYMENT_REGISTER_SUBJECT, {
      outcome: 'accepted',
      paymentReference: body.paymentReference,
      invoiceReference: 'INV-000027',
      orderReference: 'ORD-000042',
      invoiceStatus: 'paid',
      paidAt: '2026-08-18T11:02:00.000Z',
    });
    const readModel = new FakeOrderReadModel();
    readModel.documents.push(projectedOrder());
    const handler = new RegisterPaymentHandler(rpc, readModel);

    const result = await handler.execute(new RegisterPaymentCommand('invoice-1', body));

    expect(result.correlationId).toBe('order-1');
    const paymentCall = rpc.calls.find((call) => call.subject === PAYMENT_REGISTER_SUBJECT);
    expect(paymentCall?.meta.correlationId).toBe('order-1');
    expect((paymentCall?.payload as { invoiceId: string }).invoiceId).toBe('invoice-1');
    expect(result.reply.outcome).toBe('accepted');
  });

  it('never touches a write database — the invoiceId->orderReference step is an RPC call, the orderReference->orderId step reads the Mongo read model only', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(INVOICE_LIST_SUBJECT, invoiceListPage([{ invoiceId: 'invoice-1', orderReference: 'ORD-000042' }]));
    rpc.respondWith(PAYMENT_REGISTER_SUBJECT, {
      outcome: 'accepted',
      paymentReference: body.paymentReference,
      invoiceReference: 'INV-000027',
      invoiceStatus: 'paid',
    });
    const readModel = new FakeOrderReadModel();
    readModel.documents.push(projectedOrder());
    const handler = new RegisterPaymentHandler(rpc, readModel);

    await handler.execute(new RegisterPaymentCommand('invoice-1', body));

    // Every collaborator used is either the scripted RPC fake or the fake
    // read model — no other I/O surface exists for this handler to reach.
    expect(rpc.calls.map((call) => call.subject)).toEqual([INVOICE_LIST_SUBJECT, PAYMENT_REGISTER_SUBJECT]);
  });

  it('throws InvoiceNotFoundError when no invoice in the scanned pages matches the given invoiceId', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(INVOICE_LIST_SUBJECT, invoiceListPage([{ invoiceId: 'some-other-invoice', orderReference: 'ORD-000042' }]));
    const readModel = new FakeOrderReadModel();
    const handler = new RegisterPaymentHandler(rpc, readModel);

    await expect(handler.execute(new RegisterPaymentCommand('invoice-1', body))).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });

  it('F4 — walks PAST the first page: page 1 full (200, no match), page 2 (partial, has match) — resolves correctly and stops paging once found', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(INVOICE_LIST_SUBJECT, fullInvoiceListPage(200)); // page 1: full, no match
    rpc.respondWith(INVOICE_LIST_SUBJECT, fullInvoiceListPage(37, 'invoice-1')); // page 2: partial, has match
    rpc.respondWith(PAYMENT_REGISTER_SUBJECT, {
      outcome: 'accepted',
      paymentReference: body.paymentReference,
      invoiceReference: 'INV-000027',
      orderReference: 'ORD-000042',
      invoiceStatus: 'paid',
    });
    const readModel = new FakeOrderReadModel();
    readModel.documents.push(projectedOrder());
    const handler = new RegisterPaymentHandler(rpc, readModel);

    const result = await handler.execute(new RegisterPaymentCommand('invoice-1', body));

    const listCalls = rpc.calls.filter((call) => call.subject === INVOICE_LIST_SUBJECT);
    expect(listCalls).toHaveLength(2);
    expect((listCalls[0]?.payload as { page: number }).page).toBe(1);
    expect((listCalls[1]?.payload as { page: number }).page).toBe(2);
    expect(result.correlationId).toBe('order-1');
  });

  it('F4 — a page shorter than INVOICE_SCAN_PAGE_SIZE with no match throws InvoiceNotFoundError immediately, without scanning further pages', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(INVOICE_LIST_SUBJECT, fullInvoiceListPage(3)); // shorter than 200 — genuinely the last page
    const readModel = new FakeOrderReadModel();
    const handler = new RegisterPaymentHandler(rpc, readModel);

    await expect(handler.execute(new RegisterPaymentCommand('invoice-1', body))).rejects.toBeInstanceOf(InvoiceNotFoundError);
    expect(rpc.calls.filter((call) => call.subject === INVOICE_LIST_SUBJECT)).toHaveLength(1);
  });

  it('F4 — exhausting INVOICE_SCAN_MAX_PAGES with every page still FULL throws InvoiceScanBudgetExceededError, never InvoiceNotFoundError (the invoice may still exist beyond the search window)', async () => {
    const rpc = new FakeRpcClient();
    for (let i = 0; i < 5; i += 1) {
      rpc.respondWith(INVOICE_LIST_SUBJECT, fullInvoiceListPage(200)); // every one of the 5 allowed pages comes back FULL
    }
    const readModel = new FakeOrderReadModel();
    const handler = new RegisterPaymentHandler(rpc, readModel);

    const error = await handler.execute(new RegisterPaymentCommand('invoice-1', body)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvoiceScanBudgetExceededError);
    expect((error as InvoiceScanBudgetExceededError).scannedCount).toBe(1000);
    expect(rpc.calls.filter((call) => call.subject === INVOICE_LIST_SUBJECT)).toHaveLength(5);
    // billing.payment.register must never be called once the scan budget is exhausted.
    expect(rpc.calls.some((call) => call.subject === PAYMENT_REGISTER_SUBJECT)).toBe(false);
  });

  it('throws OrderNotYetProjectedError when the resolved order has no read-model document yet — never falls back to a made-up correlationId', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(INVOICE_LIST_SUBJECT, invoiceListPage([{ invoiceId: 'invoice-1', orderReference: 'ORD-000042' }]));
    const readModel = new FakeOrderReadModel(); // empty — order not projected yet
    const handler = new RegisterPaymentHandler(rpc, readModel);

    await expect(handler.execute(new RegisterPaymentCommand('invoice-1', body))).rejects.toBeInstanceOf(OrderNotYetProjectedError);
    // billing.payment.register must never be called without a resolved correlationId.
    expect(rpc.calls.map((call) => call.subject)).toEqual([INVOICE_LIST_SUBJECT]);
  });
});
