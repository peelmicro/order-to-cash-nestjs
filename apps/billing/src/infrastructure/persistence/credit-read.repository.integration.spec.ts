// Testcontainers integration — real MySQL (mysql:8.4.11). BC6's filters,
// paging and reconciliation at SQL level: every listed line's
// `activeHolds + openExposure` reconciles to `creditLimit − availableCredit`,
// across all four ledger shapes (never held, held, held+consumed,
// held+released).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleCreditReadRepository } from './credit-read.repository';
import { creditItems, credits, outbox } from './schema';
import { startBillingTestFixture, type BillingTestFixture } from './test-support/billing-test-fixture';

const NOW = new Date('2026-08-21T10:00:00.000Z');
const CURRENCY = 'EUR';

async function seedLine(
  fixture: BillingTestFixture,
  input: { retailerCode: string; companyCode: string; creditLimit: number; code: string },
): Promise<string> {
  const id = randomUUID();
  await fixture.db.insert(credits).values({
    id,
    code: input.code,
    retailerCode: input.retailerCode,
    companyCode: input.companyCode,
    creditLimit: input.creditLimit,
    currencyCode: CURRENCY,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function seedItem(
  fixture: BillingTestFixture,
  input: { creditId: string; orderReference: string; amount: number; type: 'hold' | 'consume' | 'release' },
): Promise<void> {
  await fixture.db.insert(creditItems).values({
    id: randomUUID(),
    creditId: input.creditId,
    orderReference: input.orderReference,
    amount: input.amount,
    type: input.type,
    creditDate: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('DrizzleCreditReadRepository (Testcontainers: mysql:8.4.11)', () => {
  let fixture: BillingTestFixture;
  let repository: DrizzleCreditReadRepository;

  beforeAll(async () => {
    fixture = await startBillingTestFixture();
    repository = new DrizzleCreditReadRepository(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.db.delete(outbox);
    await fixture.db.delete(creditItems);
    await fixture.db.delete(credits);
  });

  it('reports activeHolds, openExposure and availableCredit that reconcile to the credit limit for every listed line', async () => {
    // Four ledger shapes: never held, held, held+consumed, held+released.
    const neverHeld = await seedLine(fixture, { retailerCode: 'RET-A', companyCode: 'COM-A', creditLimit: 100_000, code: 'CR-100001' });

    const held = await seedLine(fixture, { retailerCode: 'RET-B', companyCode: 'COM-B', creditLimit: 100_000, code: 'CR-100002' });
    await seedItem(fixture, { creditId: held, orderReference: 'ORD-100001', amount: 20_000, type: 'hold' });

    const heldConsumed = await seedLine(fixture, { retailerCode: 'RET-C', companyCode: 'COM-C', creditLimit: 100_000, code: 'CR-100003' });
    await seedItem(fixture, { creditId: heldConsumed, orderReference: 'ORD-100002', amount: 30_000, type: 'hold' });
    await seedItem(fixture, { creditId: heldConsumed, orderReference: 'ORD-100002', amount: 30_000, type: 'consume' });

    const heldReleased = await seedLine(fixture, { retailerCode: 'RET-D', companyCode: 'COM-D', creditLimit: 100_000, code: 'CR-100004' });
    await seedItem(fixture, { creditId: heldReleased, orderReference: 'ORD-100003', amount: 40_000, type: 'hold' });
    await seedItem(fixture, { creditId: heldReleased, orderReference: 'ORD-100003', amount: 40_000, type: 'release' });

    const reply = await repository.list({ page: 1, pageSize: 50 });
    const byCode = new Map(reply.items.map((item) => [item.creditCode, item]));

    for (const item of reply.items) {
      expect(item.activeHolds + item.openExposure).toBe(item.creditLimit - item.availableCredit);
    }

    expect(byCode.get('CR-100001')).toMatchObject({ activeHolds: 0, openExposure: 0, availableCredit: 100_000 });
    expect(byCode.get('CR-100002')).toMatchObject({ activeHolds: 20_000, openExposure: 0, availableCredit: 80_000 });
    expect(byCode.get('CR-100003')).toMatchObject({ activeHolds: 0, openExposure: 30_000, availableCredit: 70_000 });
    expect(byCode.get('CR-100004')).toMatchObject({ activeHolds: 0, openExposure: 0, availableCredit: 100_000 });

    void neverHeld;
  });

  it('filters by retailerCode and companyCode, and pages with an accurate PageInfo.total', async () => {
    await seedLine(fixture, { retailerCode: 'RET-X', companyCode: 'COM-X', creditLimit: 10_000, code: 'CR-200001' });
    await seedLine(fixture, { retailerCode: 'RET-X', companyCode: 'COM-Y', creditLimit: 10_000, code: 'CR-200002' });
    await seedLine(fixture, { retailerCode: 'RET-Y', companyCode: 'COM-X', creditLimit: 10_000, code: 'CR-200003' });

    const byRetailer = await repository.list({ retailerCode: 'RET-X', page: 1, pageSize: 50 });
    expect(byRetailer.items.map((item) => item.creditCode).sort()).toEqual(['CR-200001', 'CR-200002']);
    expect(byRetailer.page.total).toBe(2);

    const byCompany = await repository.list({ companyCode: 'COM-X', page: 1, pageSize: 50 });
    expect(byCompany.items.map((item) => item.creditCode).sort()).toEqual(['CR-200001', 'CR-200003']);

    const firstPage = await repository.list({ page: 1, pageSize: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.page.total).toBe(3);
    const secondPage = await repository.list({ page: 2, pageSize: 2 });
    expect(secondPage.items).toHaveLength(1);
  });
});
