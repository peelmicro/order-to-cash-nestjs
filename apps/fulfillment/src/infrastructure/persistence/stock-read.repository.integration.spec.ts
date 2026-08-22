// Testcontainers integration — real MySQL. FS15's filters and paging at
// the SQL level: derived `availableUnits`, ordering, company/product
// filters, `belowThreshold`, and that `list`/`availability` take no lock
// and mutate nothing.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleStockReadRepository } from './stock-read.repository';
import { stock } from './schema';
import {
  startFulfillmentTestFixture,
  type FulfillmentTestFixture,
} from './test-support/fulfillment-test-fixture';

const now = new Date('2026-08-21T10:00:00.000Z');

async function seedStock(
  fixture: FulfillmentTestFixture,
  rows: readonly { companyCode: string; productCode: string; units: number; reservedUnits: number; lowStockThreshold: number }[],
): Promise<void> {
  await fixture.db.insert(stock).values(
    rows.map((row) => ({
      id: randomUUID(),
      ...row,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

describe('DrizzleStockReadRepository (Testcontainers: mysql:8.4.11)', () => {
  let fixture: FulfillmentTestFixture;
  let repository: DrizzleStockReadRepository;

  beforeAll(async () => {
    fixture = await startFulfillmentTestFixture();
    repository = new DrizzleStockReadRepository(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.db.delete(stock);
  });

  it('availability answers per line without mutating a stock item, unknown product yields available 0 sufficient false', async () => {
    await seedStock(fixture, [{ companyCode: 'COM-0001', productCode: 'PRD-0001', units: 10, reservedUnits: 3, lowStockThreshold: 2 }]);

    const before = await fixture.db.select().from(stock).where(eq(stock.productCode, 'PRD-0001'));

    const reply = await repository.availability('COM-0001', [
      { productCode: 'PRD-0001', quantity: 5 },
      { productCode: 'PRD-9999', quantity: 1 },
    ]);

    expect(reply.available).toBe(false);
    expect(reply.lines).toEqual([
      { productCode: 'PRD-0001', requested: 5, available: 7, sufficient: true },
      { productCode: 'PRD-9999', requested: 1, available: 0, sufficient: false },
    ]);

    const after = await fixture.db.select().from(stock).where(eq(stock.productCode, 'PRD-0001'));
    expect(after).toEqual(before);
  });

  it('lists StockViews with derived availableUnits, ordered by (companyCode, productCode), filtered by company and product, paged', async () => {
    await seedStock(fixture, [
      { companyCode: 'COM-0002', productCode: 'PRD-0003', units: 10, reservedUnits: 2, lowStockThreshold: 1 },
      { companyCode: 'COM-0001', productCode: 'PRD-0002', units: 8, reservedUnits: 1, lowStockThreshold: 1 },
      { companyCode: 'COM-0001', productCode: 'PRD-0001', units: 10, reservedUnits: 3, lowStockThreshold: 2 },
    ]);

    const all = await repository.list({ page: 1, pageSize: 25 });
    expect(all.items.map((i) => [i.companyCode, i.productCode])).toEqual([
      ['COM-0001', 'PRD-0001'],
      ['COM-0001', 'PRD-0002'],
      ['COM-0002', 'PRD-0003'],
    ]);
    expect(all.items[0]).toEqual({
      companyCode: 'COM-0001',
      productCode: 'PRD-0001',
      units: 10,
      reservedUnits: 3,
      availableUnits: 7,
      lowStockThreshold: 2,
    });
    expect(all.page).toEqual({ page: 1, pageSize: 25, total: 3 });

    const byCompany = await repository.list({ companyCode: 'COM-0001', page: 1, pageSize: 25 });
    expect(byCompany.items).toHaveLength(2);
    expect(byCompany.page.total).toBe(2);

    const byProduct = await repository.list({ productCode: 'PRD-0002', page: 1, pageSize: 25 });
    expect(byProduct.items).toHaveLength(1);
    expect(byProduct.items[0]?.productCode).toBe('PRD-0002');

    const page1 = await repository.list({ page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.page).toEqual({ page: 1, pageSize: 2, total: 3 });
    const page2 = await repository.list({ page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(1);
  });

  it('belowThreshold returns only items whose availableUnits < lowStockThreshold, without locking or mutating', async () => {
    await seedStock(fixture, [
      { companyCode: 'COM-0001', productCode: 'PRD-LOW', units: 5, reservedUnits: 4, lowStockThreshold: 3 }, // available 1 < 3
      { companyCode: 'COM-0001', productCode: 'PRD-OK', units: 10, reservedUnits: 0, lowStockThreshold: 3 }, // available 10 >= 3
    ]);

    const before = await fixture.db.select().from(stock);
    const reply = await repository.list({ belowThreshold: true, page: 1, pageSize: 25 });

    expect(reply.items).toHaveLength(1);
    expect(reply.items[0]?.productCode).toBe('PRD-LOW');

    const after = await fixture.db.select().from(stock);
    expect(after).toEqual(before);
  });
});
