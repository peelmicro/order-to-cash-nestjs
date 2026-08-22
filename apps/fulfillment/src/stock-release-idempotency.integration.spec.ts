// R34 (matrix case), FS9, FS10 — the real AppModule graph, real MySQL +
// NATS + Kafka. Synchronises on terminal/monotonic evidence only.
import { UniqueId } from '@otc/shared-kernel';
import type { RpcError, StockReleaseReplyPayload, StockReserveReplyPayload } from '@otc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STOCK_RELEASE_SUBJECT, STOCK_RESERVE_SUBJECT } from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`stock-release-idempotency.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

function releaseHeaders() {
  return { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value };
}

describe('stock.release — R34, FS9, FS10 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('happy path: released reply, rows released, counter down, exactly one stock.released.v1 with the request\'s reason', async () => {
    const productCode = `PRD-RELHAPPY-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = orderRef();
    const reserveCorrelation = UniqueId.generate();

    const reserveReply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 4 }] },
      { 'x-correlation-id': reserveCorrelation.value, 'x-request-id': UniqueId.generate().value },
    );
    expect(reserveReply).toMatchObject({ outcome: 'accepted' });

    const releaseCorrelation = UniqueId.generate();
    const releaseRequestId = UniqueId.generate();
    const releaseReply = await harness.requestBare<StockReleaseReplyPayload>(
      STOCK_RELEASE_SUBJECT,
      { orderReference, reason: 'credit_rejected' },
      { 'x-correlation-id': releaseCorrelation.value, 'x-request-id': releaseRequestId.value },
    );

    expect(releaseReply).toMatchObject({ outcome: 'released' });
    expect((releaseReply as StockReleaseReplyPayload).released).toHaveLength(1);

    const reservationRows = await harness.reservationsOf(orderReference);
    expect(reservationRows[0]?.status).toBe('released');
    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.reservedUnits).toBe(0);

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(releaseCorrelation.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(releaseCorrelation.value);
    expect(outboxRows[0]).toMatchObject({ eventType: 'stock.released.v1', causationId: releaseRequestId.value });
    expect((outboxRows[0]?.payload as { reason: string }).reason).toBe('credit_rejected');
  });

  it('answers success and emits no second fact when every reservation is already released', async () => {
    const productCode = `PRD-RELIDEM-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = orderRef();

    const reserveReply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 2 }] },
      { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
    );
    expect(reserveReply).toMatchObject({ outcome: 'accepted' });

    const firstReleaseHeaders = releaseHeaders();
    const first = await harness.requestBare<StockReleaseReplyPayload>(
      STOCK_RELEASE_SUBJECT,
      { orderReference, reason: 'order_cancelled' },
      firstReleaseHeaders,
    );
    expect(first).toMatchObject({ outcome: 'released' });
    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(firstReleaseHeaders['x-correlation-id']);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });

    const secondReleaseHeaders = releaseHeaders();
    const second = await harness.requestBare<StockReleaseReplyPayload>(
      STOCK_RELEASE_SUBJECT,
      { orderReference, reason: 'order_cancelled' },
      secondReleaseHeaders,
    );
    expect(second).toEqual({ outcome: 'already_released', orderReference, released: [] });

    // No fact for the SECOND release's correlationId.
    const secondOutboxRows = await harness.outboxRowsFor(secondReleaseHeaders['x-correlation-id']);
    expect(secondOutboxRows).toHaveLength(0);
  });

  it('answers already_released with an empty list and emits nothing for an order that never held a reservation', async () => {
    const orderReference = orderRef();
    const headers = releaseHeaders();

    const reply = await harness.requestBare<StockReleaseReplyPayload>(
      STOCK_RELEASE_SUBJECT,
      { orderReference, reason: 'order_cancelled' },
      headers,
    );

    expect(reply).toEqual({ outcome: 'already_released', orderReference, released: [] });
    const outboxRows = await harness.outboxRowsFor(headers['x-correlation-id']);
    expect(outboxRows).toHaveLength(0);
  });

  it('replies PRECONDITION_FAILED and emits nothing when the order\'s reservations are consumed', async () => {
    const productCode = `PRD-CONSUMED-${Date.now()}`;
    const ids = await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 3 }]);
    const orderReference = orderRef();
    await harness.seedReservation({
      stockId: ids.get(productCode)!,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      productCode,
      orderReference,
      units: 3,
      status: 'consumed',
    });
    const headers = releaseHeaders();

    const reply = await harness.requestBare<StockReleaseReplyPayload | RpcError>(
      STOCK_RELEASE_SUBJECT,
      { orderReference, reason: 'order_cancelled' },
      headers,
    );

    expect((reply as RpcError).code).toBe('PRECONDITION_FAILED');
    const outboxRows = await harness.outboxRowsFor(headers['x-correlation-id']);
    expect(outboxRows).toHaveLength(0);
    const reservationRows = await harness.reservationsOf(orderReference);
    expect(reservationRows[0]?.status).toBe('consumed');
  });
});
