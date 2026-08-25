import { describe, expect, it } from 'vitest';
import { INVOICE_LIST_SUBJECT, ListInvoicesHandler, ListInvoicesQuery } from './list-invoices.query';
import { FakeRpcClient } from '../../test-support/fake-rpc-client';

describe('ListInvoicesHandler', () => {
  it('translates to billing.invoice.list and passes the page through, defaulting paidAt to null', async () => {
    const rpc = new FakeRpcClient();
    rpc.respondWith(INVOICE_LIST_SUBJECT, {
      items: [
        {
          invoiceId: 'invoice-1',
          invoiceReference: 'INV-000027',
          invoiceDate: '2026-08-18T09:00:00.000Z',
          orderReference: 'ORD-000042',
          retailerCode: 'CarrefourEs',
          companyCode: 'IBERFOODS',
          currency: 'EUR',
          amount: 124250,
          discount: 0,
          totalAmount: 124250,
          status: 'issued',
        },
      ],
      page: { page: 1, pageSize: 25, total: 1 },
    });
    const handler = new ListInvoicesHandler(rpc);

    const result = await handler.execute(new ListInvoicesQuery({ page: 1, pageSize: 25 }));

    expect(rpc.calls[0]?.subject).toBe(INVOICE_LIST_SUBJECT);
    expect(result.items[0]?.paidAt).toBeNull();
    expect(result.items[0]?.orderReference).toBe('ORD-000042');
  });
});
