// FS14 — the real AppModule graph, real MySQL + NATS + Kafka.
import type { RpcError, StockReplenishReplyPayload } from '@otc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from './infrastructure/persistence/schema';
import { STOCK_REPLENISH_SUBJECT } from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

describe('stock.replenish — FS14 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('happy path: units up, reserved_units and reservations untouched, outbox empty (R61)', async () => {
    const productCode = `PRD-TOPUP-${Date.now()}`;
    const ids = await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 4 }]);
    await harness.seedReservation({
      stockId: ids.get(productCode)!,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode,
      orderReference: 'ORD-000123',
      units: 4,
      status: 'reserved',
    });

    const reply = await harness.requestBare<StockReplenishReplyPayload>(STOCK_REPLENISH_SUBJECT, {
      companyCode: 'COM-0001',
      lines: [{ productCode, units: 6 }],
    });

    expect((reply as StockReplenishReplyPayload).items).toEqual([
      { companyCode: 'COM-0001', productCode, units: 16, reservedUnits: 4, availableUnits: 12, lowStockThreshold: 2 },
    ]);

    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.units).toBe(16);
    expect(stockRow?.reservedUnits).toBe(4);

    const reservationRows = await harness.reservationsOf('ORD-000123');
    expect(reservationRows).toHaveLength(1);
    expect(reservationRows[0]?.status).toBe('reserved');

    // R61 appends no domain event — no fact for this replenishment.
    const outboxRows = await harness.db.select().from(schema.outbox);
    const relevant = outboxRows.filter((row) => row.aggregateId === ids.get(productCode));
    expect(relevant).toHaveLength(0);
  });

  it('replies NOT_FOUND and replenishes no line when any line names an unknown product', async () => {
    const productCode = `PRD-KNOWN-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);

    const reply = await harness.requestBare<StockReplenishReplyPayload | RpcError>(STOCK_REPLENISH_SUBJECT, {
      companyCode: 'COM-0001',
      lines: [
        { productCode, units: 5 },
        { productCode: 'PRD-UNKNOWN-XYZ', units: 1 },
      ],
    });

    expect((reply as RpcError).code).toBe('NOT_FOUND');

    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.units).toBe(10); // unchanged — all-or-nothing
  });
});
