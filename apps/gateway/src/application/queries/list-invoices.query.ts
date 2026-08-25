// `GET /invoices` (openapi.yaml `listInvoices`) → NATS RPC `billing.invoice.list`.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import type { InvoiceListReplyPayload, InvoiceListRequestPayload } from '@otc/contracts';
import type { InvoicePage } from '../contracts-aliases';
import { RPC_CLIENT, type RpcClient } from '../ports/rpc-client.port';

export const INVOICE_LIST_SUBJECT = 'billing.invoice.list';

export class ListInvoicesQuery {
  constructor(readonly request: InvoiceListRequestPayload) {}
}

@QueryHandler(ListInvoicesQuery)
export class ListInvoicesHandler implements IQueryHandler<ListInvoicesQuery, InvoicePage> {
  constructor(@Inject(RPC_CLIENT) private readonly rpc: RpcClient) {}

  async execute(query: ListInvoicesQuery): Promise<InvoicePage> {
    const requestId = UniqueId.generate().value;
    const reply = await this.rpc.call<InvoiceListRequestPayload, InvoiceListReplyPayload>(INVOICE_LIST_SUBJECT, query.request, {
      correlationId: requestId,
      requestId,
    });
    return {
      items: reply.items.map((item) => ({
        invoiceId: item.invoiceId,
        invoiceReference: item.invoiceReference,
        invoiceDate: item.invoiceDate,
        orderReference: item.orderReference,
        retailerCode: item.retailerCode,
        companyCode: item.companyCode,
        currency: item.currency,
        amount: item.amount,
        discount: item.discount,
        totalAmount: item.totalAmount,
        status: item.status,
        paidAt: item.paidAt ?? null,
      })),
      page: reply.page,
    };
  }
}
