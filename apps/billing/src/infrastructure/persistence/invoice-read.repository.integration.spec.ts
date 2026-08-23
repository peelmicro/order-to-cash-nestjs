// Testcontainers integration — real MySQL (mysql:8.4.11). `BI15`'s SQL
// half: filters by status, party codes and order reference, pages the
// result, and returns only invoices older than `issuedBeforeMinutes`
// against the injected `now` (never the ambient system clock).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InvoiceListReplyPayload } from '@otc/contracts';
import { DrizzleInvoiceReadRepository } from './invoice-read.repository';
import { invoices } from './schema';
import { startBillingTestFixture, type BillingTestFixture } from './test-support/billing-test-fixture';

const CURRENCY = 'EUR';
const NOW = new Date('2026-08-21T12:00:00.000Z');

async function seedInvoice(
  fixture: BillingTestFixture,
  overrides: {
    invoiceReference: string;
    orderReference: string;
    retailerCode?: string;
    companyCode?: string;
    status?: 'issued' | 'paid';
    invoiceDate?: Date;
    paidAt?: Date | null;
  },
): Promise<void> {
  const now = new Date('2026-08-21T09:00:00.000Z');
  await fixture.db.insert(invoices).values({
    id: randomUUID(),
    invoiceReference: overrides.invoiceReference,
    invoiceDate: overrides.invoiceDate ?? now,
    companyCode: overrides.companyCode ?? 'COM-0001',
    retailerCode: overrides.retailerCode ?? 'RET-0001',
    orderReference: overrides.orderReference,
    amount: 2_000,
    discount: 0,
    totalAmount: 2_000,
    currencyCode: CURRENCY,
    status: overrides.status ?? 'issued',
    paidAt: overrides.paidAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('DrizzleInvoiceReadRepository — BI15 SQL half (Testcontainers: mysql:8.4.11)', () => {
  let fixture: BillingTestFixture;
  let repository: DrizzleInvoiceReadRepository;

  beforeAll(async () => {
    fixture = await startBillingTestFixture();
    repository = new DrizzleInvoiceReadRepository(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.db.delete(invoices);
  });

  it('filters by status, retailerCode, companyCode and orderReference', async () => {
    await seedInvoice(fixture, { invoiceReference: 'INV-000001', orderReference: 'ORD-000001', retailerCode: 'RET-A', companyCode: 'COM-A', status: 'issued' });
    await seedInvoice(fixture, { invoiceReference: 'INV-000002', orderReference: 'ORD-000002', retailerCode: 'RET-A', companyCode: 'COM-A', status: 'paid', paidAt: NOW });
    await seedInvoice(fixture, { invoiceReference: 'INV-000003', orderReference: 'ORD-000003', retailerCode: 'RET-B', companyCode: 'COM-B', status: 'issued' });

    const byStatus = await repository.list({ status: 'paid', page: 1, pageSize: 25 }, NOW);
    expect(byStatus.items.map((item) => item.invoiceReference)).toEqual(['INV-000002']);
    expect(byStatus.items[0]!.paidAt).toBe(NOW.toISOString());

    const byRetailer = await repository.list({ retailerCode: 'RET-B', page: 1, pageSize: 25 }, NOW);
    expect(byRetailer.items.map((item) => item.invoiceReference)).toEqual(['INV-000003']);

    const byCompany = await repository.list({ companyCode: 'COM-A', page: 1, pageSize: 25 }, NOW);
    expect(byCompany.items.map((item) => item.invoiceReference).sort()).toEqual(['INV-000001', 'INV-000002']);

    const byOrder = await repository.list({ orderReference: 'ORD-000001', page: 1, pageSize: 25 }, NOW);
    expect(byOrder.items.map((item) => item.invoiceReference)).toEqual(['INV-000001']);
  });

  it('pages the result and reports PageInfo.total', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedInvoice(fixture, { invoiceReference: `INV-00000${i}`, orderReference: `ORD-00000${i}`, invoiceDate: new Date(NOW.getTime() - i * 60_000) });
    }

    const page1 = await repository.list({ page: 1, pageSize: 2 }, NOW);
    expect(page1.items).toHaveLength(2);
    expect(page1.page).toEqual({ page: 1, pageSize: 2, total: 5 });

    const page3 = await repository.list({ page: 3, pageSize: 2 }, NOW);
    expect(page3.items).toHaveLength(1);
    expect(page3.page.total).toBe(5);
  });

  it('returns only invoices whose invoiceDate is at least issuedBeforeMinutes minutes before the injected now', async () => {
    await seedInvoice(fixture, { invoiceReference: 'INV-000010', orderReference: 'ORD-000010', invoiceDate: new Date(NOW.getTime() - 120 * 60_000) });
    await seedInvoice(fixture, { invoiceReference: 'INV-000011', orderReference: 'ORD-000011', invoiceDate: new Date(NOW.getTime() - 10 * 60_000) });

    const reply: InvoiceListReplyPayload = await repository.list({ issuedBeforeMinutes: 60, page: 1, pageSize: 25 }, NOW);

    expect(reply.items.map((item) => item.invoiceReference)).toEqual(['INV-000010']);
  });

  it('reads the current time from the injected now, not the ambient system clock', async () => {
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    await seedInvoice(fixture, { invoiceReference: 'INV-000020', orderReference: 'ORD-000020', invoiceDate: NOW });

    // With `now` fixed to the real present, a 60-minute-old threshold
    // excludes a just-seeded invoice — proving `now` came from the
    // PARAMETER, not from a real ambient clock reading "today" in 2026/2099.
    const withRealNow = await repository.list({ issuedBeforeMinutes: 60, page: 1, pageSize: 25 }, NOW);
    expect(withRealNow.items.map((item) => item.invoiceReference)).not.toContain('INV-000020');

    const withFarFutureNow = await repository.list({ issuedBeforeMinutes: 60, page: 1, pageSize: 25 }, farFuture);
    expect(withFarFutureNow.items.map((item) => item.invoiceReference)).toContain('INV-000020');
  });
});
