// The `QueryBus` side (design.md §5.1) — `billing.invoice.list`, never
// locking, never mutating.
import { Query } from '@nestjs/cqrs';
import type { InvoiceListReplyPayload, InvoiceListRequestPayload } from '@otc/contracts';

export class ListInvoicesQuery extends Query<InvoiceListReplyPayload> {
  constructor(readonly request: InvoiceListRequestPayload) {
    super();
  }
}
