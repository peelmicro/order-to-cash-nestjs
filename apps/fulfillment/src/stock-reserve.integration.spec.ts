// R32/R33 integration halves, FS3, FS5 — the real AppModule graph, real
// MySQL + NATS + Kafka. Synchronises only on terminal/monotonic evidence
// (design.md §13, the binding reviewer ruling): an outbox row's
// `publishedAt`, never a transient counter mid-flight.
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StockReserveReplyPayload } from '@otc/contracts';
import { STOCK_RESERVE_SUBJECT } from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`stock-reserve.integration: condition not met within ${timeoutMs}ms`);
}

describe('stock.reserve — R32/R33, FS3, FS5 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('accepted reply + one reserved row per line + reserved_units raised + exactly one stock.reserved.v1 whose correlationId/causationId equal the headers (FS3)', async () => {
    const productCode = `PRD-RES-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 4 }] },
      { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value },
    );

    expect(reply).toMatchObject({ outcome: 'accepted', orderReference });
    const reservedRows = await harness.reservationsOf(orderReference);
    expect(reservedRows).toHaveLength(1);
    expect(reservedRows[0]).toMatchObject({ status: 'reserved', productCode, units: 4 });

    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.reservedUnits).toBe(4);

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      eventType: 'stock.reserved.v1',
      correlationId: correlationId.value,
      causationId: requestId.value,
    });
  });

  it('rejected reply + zero rows + one stock.rejected.v1 naming requested/available (R33 integration shape)', async () => {
    const productCode = `PRD-REJ-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 2, reservedUnits: 0 }]);
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 5 }] },
      { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value },
    );

    expect(reply).toMatchObject({ outcome: 'rejected', orderReference });
    expect((reply as StockReserveReplyPayload).shortages).toEqual([{ productCode, requested: 5, available: 2 }]);

    const reservedRows = await harness.reservationsOf(orderReference);
    expect(reservedRows).toHaveLength(0);
    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.reservedUnits).toBe(0);

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows[0]).toMatchObject({ eventType: 'stock.rejected.v1' });
    expect((outboxRows[0]?.payload as { shortages: unknown }).shortages).toEqual([{ productCode, requested: 5, available: 2 }]);
  });

  it('answers already_reserved with the existing reservations, changes no counter and emits no second fact when stock.reserve is re-issued for the same order', async () => {
    const productCode = `PRD-DUP-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();
    const request = { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 3 }] };
    const headers = { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value };

    const first = await harness.requestBare<StockReserveReplyPayload>(STOCK_RESERVE_SUBJECT, request, headers);
    expect(first).toMatchObject({ outcome: 'accepted' });

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });

    const second = await harness.requestBare<StockReserveReplyPayload>(STOCK_RESERVE_SUBJECT, request, headers);
    expect(second).toMatchObject({ outcome: 'already_reserved' });
    expect((second as StockReserveReplyPayload).reservations).toHaveLength(1);

    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.reservedUnits).toBe(3);

    // Outbox count stays 1 — no second fact for the re-issue.
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(1);
  });

  it('FS5 — answers already_reserved for an order whose only existing reservation is already released (the saga-compensated case), reserving nothing new', async () => {
    const productCode = `PRD-RELEASED-${Date.now()}`;
    const stockIds = await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
    await harness.seedReservation({
      stockId: stockIds.get(productCode)!,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode,
      orderReference,
      units: 3,
      status: 'released',
    });
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();
    const headers = { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value };

    const reply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 3 }] },
      headers,
    );

    expect(reply).toMatchObject({ outcome: 'already_reserved', orderReference });
    expect((reply as StockReserveReplyPayload).reservations).toHaveLength(1);
    expect((reply as StockReserveReplyPayload).reservations?.[0]).toMatchObject({ productCode, units: 3 });

    // reserved_units never moved — the mutant that filters existing
    // reservations to only `status === 'reserved'` would instead RE-RESERVE
    // here, driving reservedUnits to 3 and accepting the reply.
    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.reservedUnits).toBe(0);

    const reservationRows = await harness.reservationsOf(orderReference);
    expect(reservationRows).toHaveLength(1);
    expect(reservationRows[0]?.status).toBe('released');

    // No new fact for this request's correlationId — nothing was persisted.
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(0);
  });
});
