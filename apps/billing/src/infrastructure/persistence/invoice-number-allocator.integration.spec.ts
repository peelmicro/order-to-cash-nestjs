// Real MySQL (Testcontainers, mysql:8.4.11). `BI12`'s concurrency half —
// never yields the same reference to two concurrent allocations and
// continues past the highest seeded reference. Synchronises ONLY on
// terminal evidence (design.md §10): the returned values themselves and the
// final counter row, never a transient state.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { DrizzleInvoiceNumberAllocator } from './invoice-number-allocator';
import { invoiceNumberSequences, invoices } from './schema';
import { startBillingTestFixture, type BillingTestFixture } from './test-support/billing-test-fixture';

const CURRENCY = 'EUR';

async function seedInvoiceRow(fixture: BillingTestFixture, invoiceReference: string): Promise<void> {
  const now = new Date('2026-08-21T10:00:00.000Z');
  await fixture.db.insert(invoices).values({
    id: randomUUID(),
    invoiceReference,
    invoiceDate: now,
    companyCode: 'COM-0001',
    retailerCode: 'RET-0001',
    orderReference: `ORD-${invoiceReference.slice(4)}`,
    amount: 1_000,
    discount: 0,
    totalAmount: 1_000,
    currencyCode: CURRENCY,
    status: 'issued',
    paidAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('DrizzleInvoiceNumberAllocator — BI12 concurrency half (Testcontainers: mysql:8.4.11)', () => {
  let fixture: BillingTestFixture;
  let unitOfWork: DrizzleUnitOfWork;

  beforeAll(async () => {
    fixture = await startBillingTestFixture();
    unitOfWork = new DrizzleUnitOfWork(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.db.delete(invoices);
    await fixture.db.delete(invoiceNumberSequences);
  });

  it('continues past the highest seeded reference: seed INV-000005, and the first allocation is INV-000006', async () => {
    await seedInvoiceRow(fixture, 'INV-000005');

    const allocator = new DrizzleInvoiceNumberAllocator();
    const allocated = await unitOfWork.execute((tx) => allocator.next(tx));

    expect(allocated.value).toBe('INV-000006');
  });

  it('starts at INV-000001 on an empty database', async () => {
    const allocator = new DrizzleInvoiceNumberAllocator();
    const allocated = await unitOfWork.execute((tx) => allocator.next(tx));

    expect(allocated.value).toBe('INV-000001');
  });

  it('never yields the same reference to two concurrent allocations — N callers racing next() inside N transactions never collide and leave no gap', async () => {
    const allocator = new DrizzleInvoiceNumberAllocator();
    const concurrency = 10;

    const results = await Promise.all(
      Array.from({ length: concurrency }, () => unitOfWork.execute((tx) => allocator.next(tx))),
    );

    const distinct = new Set(results.map((reference) => reference.value));
    expect(distinct.size).toBe(concurrency);

    const sequences = results.map((reference) => Number(reference.value.slice(4))).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: concurrency }, (_, index) => index + 1));

    const [row] = await fixture.db.select().from(invoiceNumberSequences).where(eq(invoiceNumberSequences.id, 1));
    expect(row?.nextValue).toBe(concurrency + 1);
  });
});
