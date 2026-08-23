// The `InvoiceReadPort` adapter (design.md §7.2) — the `QueryBus` side: no
// lock, no transaction, no mutation. Two queries: the page of `invoices`
// with the four optional equality filters plus
// `invoice_date <= now − issuedBeforeMinutes` when supplied, and a
// `COUNT(*)` over the same filter for `PageInfo.total`. Lines are NOT
// joined — `InvoiceView` does not carry them (`asyncapi.yaml`), and the
// demo robot pages over hundreds of rows.
import { and, count, desc, eq, lte } from 'drizzle-orm';
import type { InvoiceListReplyPayload, InvoiceListRequestPayload, InvoiceView } from '@otc/contracts';
import type { InvoiceReadPort } from '../../application/ports/invoice-read.port';
import type { BillingDb } from './client';
import { invoices } from './schema';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

export class DrizzleInvoiceReadRepository implements InvoiceReadPort {
  constructor(private readonly db: BillingDb) {}

  async list(query: InvoiceListRequestPayload, now: Date): Promise<InvoiceListReplyPayload> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const conditions = [];
    if (query.status !== undefined) {
      conditions.push(eq(invoices.status, query.status));
    }
    if (query.retailerCode !== undefined) {
      conditions.push(eq(invoices.retailerCode, query.retailerCode));
    }
    if (query.companyCode !== undefined) {
      conditions.push(eq(invoices.companyCode, query.companyCode));
    }
    if (query.orderReference !== undefined) {
      conditions.push(eq(invoices.orderReference, query.orderReference));
    }
    if (query.issuedBeforeMinutes !== undefined) {
      const threshold = new Date(now.getTime() - query.issuedBeforeMinutes * 60_000);
      conditions.push(lte(invoices.invoiceDate, threshold));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(invoices)
        .where(where)
        .orderBy(desc(invoices.invoiceDate), desc(invoices.invoiceReference))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(invoices).where(where),
    ]);

    const items: InvoiceView[] = rows.map((row) => ({
      invoiceId: row.id,
      invoiceReference: row.invoiceReference,
      invoiceDate: row.invoiceDate.toISOString(),
      orderReference: row.orderReference,
      retailerCode: row.retailerCode,
      companyCode: row.companyCode,
      currency: row.currencyCode,
      amount: row.amount,
      discount: row.discount,
      totalAmount: row.totalAmount,
      status: row.status,
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    }));

    return { items, page: { page, pageSize, total: totalRows[0]?.total ?? 0 } };
  }
}
