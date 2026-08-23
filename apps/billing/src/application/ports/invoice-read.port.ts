// The `QueryBus` side (design.md §5.2, §7.2) — `billing.invoice.list`,
// never locking, never mutating.
//
// `now` is a PARAMETER rather than a clock injected into the adapter: the
// handler reads `clock.now()` once and passes it, so the SQL adapter stays
// a pure translation of a query into statements and `BI15`'s
// `issuedBeforeMinutes` case can be driven by a fixed clock without a
// container-level fake.
import type { InvoiceListReplyPayload, InvoiceListRequestPayload } from '@otc/contracts';

export const INVOICE_READ = Symbol('InvoiceRead');

export interface InvoiceReadPort {
  list(query: InvoiceListRequestPayload, now: Date): Promise<InvoiceListReplyPayload>;
}
