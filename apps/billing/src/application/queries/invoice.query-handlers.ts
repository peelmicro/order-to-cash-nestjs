// One thin `@QueryHandler` class (design.md §5.1) — no logic beyond
// delegation, every dependency through `@Inject(TOKEN)`, registered as a
// class provider in `app.module.ts`.
import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { InvoiceListReplyPayload } from '@otc/contracts';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { INVOICE_READ, type InvoiceReadPort } from '../ports/invoice-read.port.js';
import { ListInvoicesQuery } from './invoice.queries.js';

@QueryHandler(ListInvoicesQuery)
export class ListInvoicesHandler implements IQueryHandler<ListInvoicesQuery, InvoiceListReplyPayload> {
  constructor(
    @Inject(INVOICE_READ) private readonly invoiceRead: InvoiceReadPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(query: ListInvoicesQuery): Promise<InvoiceListReplyPayload> {
    return this.invoiceRead.list(query.request, this.clock.now());
  }
}

/** Every `@QueryHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const INVOICE_QUERY_HANDLERS = [ListInvoicesHandler] as const;
