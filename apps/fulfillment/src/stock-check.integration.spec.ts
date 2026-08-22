// R31 — the real AppModule graph, real MySQL + NATS + Kafka (Testcontainers).
// `stock.check` is a non-locking read: no mutation, no outbox row, ever.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StockCheckReplyPayload } from '@otc/contracts';
import * as schema from './infrastructure/persistence/schema';
import { STOCK_CHECK_SUBJECT } from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

describe('stock.check — R31 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('answers per line without mutating a stock item and without emitting a fact', async () => {
    const productCode = `PRD-CHK-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 3 }]);
    const before = await harness.stockRowOf('COM-0001', productCode);

    const reply = await harness.requestBare<StockCheckReplyPayload>(STOCK_CHECK_SUBJECT, {
      companyCode: 'COM-0001',
      lines: [
        { productCode, quantity: 5 },
        { productCode: 'PRD-UNKNOWN', quantity: 1 },
      ],
    });

    expect(reply).toEqual({
      available: false,
      lines: [
        { productCode, requested: 5, available: 7, sufficient: true },
        { productCode: 'PRD-UNKNOWN', requested: 1, available: 0, sufficient: false },
      ],
    });

    const after = await harness.stockRowOf('COM-0001', productCode);
    expect(after).toEqual(before);

    const outboxRows = await harness.db.select().from(schema.outbox);
    expect(outboxRows).toHaveLength(0);
  });
});
