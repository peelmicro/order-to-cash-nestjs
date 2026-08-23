// `BI15` — the real AppModule graph, real MySQL + NATS. Filters by status,
// party codes and order reference, pages the result, and returns only
// invoices older than `issuedBeforeMinutes` against the running clock (the
// SQL half against a fixed, injected `now` is
// `infrastructure/persistence/invoice-read.repository.integration.spec.ts`'s
// job — this file proves the full RPC round trip).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvoiceListReplyPayload } from '@otc/contracts';
import { INVOICE_LIST_SUBJECT } from './presentation/invoice.controller';
import { startBillingIntegrationHarness, type BillingIntegrationHarness } from './test-support/billing-integration-harness';

const CURRENCY = 'EUR';

function shortId(): string {
  return randomUUID().slice(0, 6);
}

describe('billing.invoice.list — BI15 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: BillingIntegrationHarness;

  beforeAll(async () => {
    harness = await startBillingIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('filters by status, party codes and order reference, pages the result, and returns only invoices older than issuedBeforeMinutes', async () => {
    const suffix = shortId();
    const retailerA = `RET-LST-A-${suffix}`;
    const companyA = `COM-LST-A-${suffix}`;
    const retailerB = `RET-LST-B-${suffix}`;
    const companyB = `COM-LST-B-${suffix}`;

    await harness.seedInvoice({
      orderReference: `ORD-100001`,
      invoiceReference: `INV-${suffix}01`,
      retailerCode: retailerA,
      companyCode: companyA,
      currencyCode: CURRENCY,
      amount: 10_000,
      discount: 0,
      totalAmount: 10_000,
      status: 'issued',
      invoiceDate: new Date(Date.now() - 2 * 60 * 60_000), // 2 hours ago
    });
    await harness.seedInvoice({
      orderReference: `ORD-100002`,
      invoiceReference: `INV-${suffix}02`,
      retailerCode: retailerA,
      companyCode: companyA,
      currencyCode: CURRENCY,
      amount: 20_000,
      discount: 0,
      totalAmount: 20_000,
      status: 'paid',
      paidAt: new Date(),
      invoiceDate: new Date(Date.now() - 5 * 60_000), // 5 minutes ago
    });
    await harness.seedInvoice({
      orderReference: `ORD-100003`,
      invoiceReference: `INV-${suffix}03`,
      retailerCode: retailerB,
      companyCode: companyB,
      currencyCode: CURRENCY,
      amount: 30_000,
      discount: 0,
      totalAmount: 30_000,
      status: 'issued',
      invoiceDate: new Date(Date.now() - 5 * 60_000),
    });
    const byStatus = await harness.requestBare<InvoiceListReplyPayload>(INVOICE_LIST_SUBJECT, { status: 'paid', retailerCode: retailerA, companyCode: companyA, page: 1, pageSize: 25 });
    expect((byStatus as InvoiceListReplyPayload).items.map((item) => item.invoiceReference)).toEqual([`INV-${suffix}02`]);

    const byRetailer = await harness.requestBare<InvoiceListReplyPayload>(INVOICE_LIST_SUBJECT, { retailerCode: retailerB, page: 1, pageSize: 25 });
    expect((byRetailer as InvoiceListReplyPayload).items.map((item) => item.invoiceReference)).toEqual([`INV-${suffix}03`]);

    const byOrder = await harness.requestBare<InvoiceListReplyPayload>(INVOICE_LIST_SUBJECT, { orderReference: 'ORD-100001', page: 1, pageSize: 25 });
    expect((byOrder as InvoiceListReplyPayload).items.map((item) => item.invoiceReference)).toEqual([`INV-${suffix}01`]);

    const olderThan60Minutes = await harness.requestBare<InvoiceListReplyPayload>(INVOICE_LIST_SUBJECT, {
      retailerCode: retailerA,
      companyCode: companyA,
      issuedBeforeMinutes: 60,
      page: 1,
      pageSize: 25,
    });
    expect((olderThan60Minutes as InvoiceListReplyPayload).items.map((item) => item.invoiceReference)).toEqual([`INV-${suffix}01`]);

    const page1 = await harness.requestBare<InvoiceListReplyPayload>(INVOICE_LIST_SUBJECT, { retailerCode: retailerA, companyCode: companyA, page: 1, pageSize: 1 });
    expect((page1 as InvoiceListReplyPayload).items).toHaveLength(1);
    expect((page1 as InvoiceListReplyPayload).page).toMatchObject({ page: 1, pageSize: 1, total: 2 });
  });
});
