// FS6, FS7 — the check-then-reserve race, and the multi-line deadlock shape
// (design.md §4.3). Synchronises ONLY on replies + final counters + outbox
// contents (the binding reviewer ruling, design.md §13) — never a
// transient state.
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StockCheckReplyPayload, StockReserveReplyPayload } from '@otc/contracts';
import { STOCK_CHECK_SUBJECT, STOCK_RESERVE_SUBJECT } from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`stock-reserve-race.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

describe('stock.reserve — FS6, FS7, the deadlock shape (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('two concurrent reserves for the last units: exactly one stock.reserved.v1, exactly one stock.rejected.v1, reservedUnits never exceeds units', async () => {
    for (let i = 0; i < 10; i += 1) {
      const productCode = `PRD-RACE-${Date.now()}-${i}`;
      await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 5, reservedUnits: 0 }]);
      const orderA = orderRef();
      const orderB = orderRef();
      const correlationA = UniqueId.generate();
      const correlationB = UniqueId.generate();

      const [replyA, replyB] = await Promise.all([
        harness.requestBare<StockReserveReplyPayload>(
          STOCK_RESERVE_SUBJECT,
          { orderReference: orderA, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 5 }] },
          { 'x-correlation-id': correlationA.value, 'x-request-id': UniqueId.generate().value },
        ),
        harness.requestBare<StockReserveReplyPayload>(
          STOCK_RESERVE_SUBJECT,
          { orderReference: orderB, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 5 }] },
          { 'x-correlation-id': correlationB.value, 'x-request-id': UniqueId.generate().value },
        ),
      ]);

      const outcomes = [replyA, replyB].map((r) => (r as StockReserveReplyPayload).outcome).sort();
      expect(outcomes).toEqual(['accepted', 'rejected']);

      const stockRow = await harness.stockRowOf('COM-0001', productCode);
      expect(stockRow?.reservedUnits).toBeLessThanOrEqual(5);
      expect(stockRow?.reservedUnits).toBe(5); // exactly the winner's units, never both

      await waitFor(async () => {
        const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
        return rowsA.length === 1 && rowsA[0]?.publishedAt !== null && rowsB.length === 1 && rowsB[0]?.publishedAt !== null;
      });
      const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
      const eventTypes = [rowsA[0]?.eventType, rowsB[0]?.eventType].sort();
      expect(eventTypes).toEqual(['stock.rejected.v1', 'stock.reserved.v1']);
    }
  }, 120_000);

  it("a line reported sufficient by stock.check is rejected by a later stock.reserve once another order took the units — the check held nothing", async () => {
    const productCode = `PRD-CHECKED-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 5, reservedUnits: 0 }]);

    const checkReply = await harness.requestBare<StockCheckReplyPayload>(STOCK_CHECK_SUBJECT, {
      companyCode: 'COM-0001',
      lines: [{ productCode, quantity: 5 }],
    });
    expect(checkReply).toMatchObject({ available: true });

    // Another order takes all the units BEFORE the checked order's reserve runs.
    const firstOrder = orderRef();
    const firstReply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference: firstOrder, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 5 }] },
      { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
    );
    expect(firstReply).toMatchObject({ outcome: 'accepted' });

    const checkedOrder = orderRef();
    const secondReply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      { orderReference: checkedOrder, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 5 }] },
      { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
    );

    expect(secondReply).toMatchObject({ outcome: 'rejected' });
    expect((secondReply as StockReserveReplyPayload).shortages).toEqual([{ productCode, requested: 5, available: 0 }]);
  });

  it('the multi-line deadlock shape: order A [P1,P2] vs order B [P2,P1], both satisfiable, run concurrently 10x — both accepted, never a deadlock error', async () => {
    for (let i = 0; i < 10; i += 1) {
      const p1 = `PRD-DLK1-${Date.now()}-${i}`;
      const p2 = `PRD-DLK2-${Date.now()}-${i}`;
      await harness.seedStock([
        { companyCode: 'COM-0001', productCode: p1, units: 10, reservedUnits: 0 },
        { companyCode: 'COM-0001', productCode: p2, units: 10, reservedUnits: 0 },
      ]);
      const orderA = orderRef();
      const orderB = orderRef();

      const [replyA, replyB] = await Promise.all([
        harness.requestBare<StockReserveReplyPayload>(
          STOCK_RESERVE_SUBJECT,
          {
            orderReference: orderA,
            retailerCode: 'RET-0001',
            companyCode: 'COM-0001',
            lines: [
              { productCode: p1, units: 3 },
              { productCode: p2, units: 3 },
            ],
          },
          { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
        ),
        harness.requestBare<StockReserveReplyPayload>(
          STOCK_RESERVE_SUBJECT,
          {
            orderReference: orderB,
            retailerCode: 'RET-0001',
            companyCode: 'COM-0001',
            lines: [
              { productCode: p2, units: 3 },
              { productCode: p1, units: 3 },
            ],
          },
          { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
        ),
      ]);

      expect((replyA as StockReserveReplyPayload).outcome).toBe('accepted');
      expect((replyB as StockReserveReplyPayload).outcome).toBe('accepted');
    }
  }, 120_000);
});
