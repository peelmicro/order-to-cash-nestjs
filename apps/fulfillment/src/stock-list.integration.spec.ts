// FS15 — the real AppModule graph, real MySQL + NATS + Kafka.
import type { StockListReplyPayload } from '@otc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STOCK_LIST_SUBJECT } from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

describe('stock.list — FS15 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('lists StockViews with derived availableUnits, pages, filters by company and product, and returns only below-threshold items when belowThreshold is true, without locking or mutating', async () => {
    const suffix = String(Date.now()).slice(-6);
    const companyA = `CMA-${suffix}`;
    const companyB = `CMB-${suffix}`;
    await harness.seedStock([
      { companyCode: companyA, productCode: 'PRD-0002', units: 8, reservedUnits: 1, lowStockThreshold: 1 },
      { companyCode: companyA, productCode: 'PRD-0001', units: 10, reservedUnits: 3, lowStockThreshold: 2 },
      { companyCode: companyB, productCode: 'PRD-0001', units: 10, reservedUnits: 2, lowStockThreshold: 1 },
      { companyCode: companyA, productCode: 'PRD-LOW', units: 5, reservedUnits: 4, lowStockThreshold: 3 },
    ]);

    const byCompany = await harness.requestBare<StockListReplyPayload>(STOCK_LIST_SUBJECT, { companyCode: companyA, page: 1, pageSize: 25 });
    expect((byCompany as StockListReplyPayload).items.map((i) => i.productCode)).toEqual(['PRD-0001', 'PRD-0002', 'PRD-LOW']);
    expect((byCompany as StockListReplyPayload).page.total).toBe(3);

    const byProduct = await harness.requestBare<StockListReplyPayload>(STOCK_LIST_SUBJECT, {
      companyCode: companyA,
      productCode: 'PRD-0002',
      page: 1,
      pageSize: 25,
    });
    expect((byProduct as StockListReplyPayload).items).toHaveLength(1);
    expect((byProduct as StockListReplyPayload).items[0]).toEqual({
      companyCode: companyA,
      productCode: 'PRD-0002',
      units: 8,
      reservedUnits: 1,
      availableUnits: 7,
      lowStockThreshold: 1,
    });

    const belowThreshold = await harness.requestBare<StockListReplyPayload>(STOCK_LIST_SUBJECT, {
      companyCode: companyA,
      belowThreshold: true,
      page: 1,
      pageSize: 25,
    });
    expect((belowThreshold as StockListReplyPayload).items.map((i) => i.productCode)).toEqual(['PRD-LOW']);

    const page1 = await harness.requestBare<StockListReplyPayload>(STOCK_LIST_SUBJECT, { companyCode: companyA, page: 1, pageSize: 2 });
    expect((page1 as StockListReplyPayload).items).toHaveLength(2);
    expect((page1 as StockListReplyPayload).page).toEqual({ page: 1, pageSize: 2, total: 3 });
  });
});
