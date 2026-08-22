// R36 (matrix case), F6/F7/F8 — the real AppModule graph, real MySQL + NATS
// + Kafka. Synchronises on terminal/monotonic evidence only (outbox
// published_at, terminal reservation status, final row counts — never a
// transient state, per the binding reviewer ruling feature 16 established).
import { UniqueId } from '@otc/shared-kernel';
import type {
  DespatchCreateReplyPayload,
  RpcError,
  StockReleaseReplyPayload,
  StockReserveReplyPayload,
} from '@otc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESPATCH_CREATE_SUBJECT } from './presentation/despatch.controller';
import { STOCK_RELEASE_SUBJECT, STOCK_RESERVE_SUBJECT } from './presentation/stock.controller';
import {
  startStockIntegrationHarness,
  type StockIntegrationHarness,
} from './test-support/stock-integration-harness';

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`despatch-create.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

function meta() {
  return {
    'x-correlation-id': UniqueId.generate().value,
    'x-request-id': UniqueId.generate().value,
  };
}

describe('despatch.create — R36, F6/F7/F8 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('happy path: reservations move to consumed, one despatch + its lines are created, exactly one order.despatched.v1 is published', async () => {
    const productCode = `PRD-DESHAPPY-${Date.now()}`;
    await harness.seedStock([
      { companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 },
    ]);
    const orderReference = orderRef();

    const reserveReply = await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      {
        orderReference,
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        lines: [{ productCode, units: 4 }],
      },
      meta(),
    );
    expect(reserveReply).toMatchObject({ outcome: 'accepted' });

    const despatchCorrelation = UniqueId.generate();
    const despatchRequestId = UniqueId.generate();
    const despatchReply = await harness.requestBare<DespatchCreateReplyPayload>(
      DESPATCH_CREATE_SUBJECT,
      { orderReference },
      { 'x-correlation-id': despatchCorrelation.value, 'x-request-id': despatchRequestId.value },
    );

    expect(despatchReply).toMatchObject({ orderReference, created: true });
    const created = despatchReply as DespatchCreateReplyPayload;
    expect(created.despatchReference).toMatch(/^DES-\d{6}$/);
    expect(created.lines).toEqual([{ productCode, units: 4 }]);

    // Terminal evidence: reservation status and stock counters.
    const reservationRows = await harness.reservationsOf(orderReference);
    expect(reservationRows[0]?.status).toBe('consumed');
    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow?.units).toBe(6); // 10 - 4 consumed
    expect(stockRow?.reservedUnits).toBe(0);

    // Terminal evidence: the despatch row and its one line.
    const persisted = await harness.despatchOf(orderReference);
    expect(persisted?.despatch.despatchReference).toBe(created.despatchReference);
    expect(persisted?.items).toHaveLength(1);
    expect(persisted?.items[0]).toMatchObject({ productCode, units: 4 });

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(despatchCorrelation.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(despatchCorrelation.value);
    expect(outboxRows[0]).toMatchObject({
      eventType: 'order.despatched.v1',
      causationId: despatchRequestId.value,
    });
    expect(outboxRows[0]?.payload).toMatchObject({
      orderReference,
      despatchReference: created.despatchReference,
      companyCode: 'COM-0001',
      retailerCode: 'RET-0001',
      lines: [{ productCode, units: 4 }],
    });
  });

  it('F8 — a re-issued despatch.create for an order that already has one returns the existing reference, changes nothing, emits no second fact', async () => {
    const productCode = `PRD-DESIDEM-${Date.now()}`;
    await harness.seedStock([
      { companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 },
    ]);
    const orderReference = orderRef();

    await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      {
        orderReference,
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        lines: [{ productCode, units: 3 }],
      },
      meta(),
    );

    const firstMeta = meta();
    const first = await harness.requestBare<DespatchCreateReplyPayload>(
      DESPATCH_CREATE_SUBJECT,
      { orderReference },
      firstMeta,
    );
    expect(first).toMatchObject({ created: true });
    const firstReply = first as DespatchCreateReplyPayload;
    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(firstMeta['x-correlation-id']);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });

    const secondMeta = meta();
    const second = await harness.requestBare<DespatchCreateReplyPayload>(
      DESPATCH_CREATE_SUBJECT,
      { orderReference },
      secondMeta,
    );

    // `despatches.despatch_date` is a second-precision `datetime` column
    // (unchanged since phase 6) — the repeat's reply is built from the
    // stored row, so it necessarily loses the millisecond component the
    // in-memory first reply carried (MySQL rounds, doesn't truncate). Same
    // second (within 1000ms), not the same string.
    const secondReply = second as DespatchCreateReplyPayload;
    expect(
      Math.abs(
        new Date(secondReply.despatchDate).getTime() - new Date(firstReply.despatchDate).getTime(),
      ),
    ).toBeLessThan(1000);
    expect(second).toEqual({
      orderReference,
      despatchReference: firstReply.despatchReference,
      despatchDate: secondReply.despatchDate,
      created: false,
      lines: firstReply.lines,
    });

    // Nothing changed: exactly one despatch row/line, no second fact.
    const persisted = await harness.despatchOf(orderReference);
    expect(persisted?.items).toHaveLength(1);
    const secondOutboxRows = await harness.outboxRowsFor(secondMeta['x-correlation-id']);
    expect(secondOutboxRows).toHaveLength(0);
  });

  it('R36 precondition — never reserved: replies PRECONDITION_FAILED, creates no despatch, emits nothing', async () => {
    const orderReference = orderRef();
    const headers = meta();

    const reply = await harness.requestBare<DespatchCreateReplyPayload | RpcError>(
      DESPATCH_CREATE_SUBJECT,
      { orderReference },
      headers,
    );

    expect((reply as RpcError).code).toBe('PRECONDITION_FAILED');
    expect(await harness.despatchOf(orderReference)).toBeUndefined();
    const outboxRows = await harness.outboxRowsFor(headers['x-correlation-id']);
    expect(outboxRows).toHaveLength(0);
  });

  it('R36 precondition — every reservation already released: replies PRECONDITION_FAILED, creates no despatch, emits nothing', async () => {
    const productCode = `PRD-DESRELEASED-${Date.now()}`;
    await harness.seedStock([
      { companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 },
    ]);
    const orderReference = orderRef();

    await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      {
        orderReference,
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        lines: [{ productCode, units: 2 }],
      },
      meta(),
    );
    const releaseReply = await harness.requestBare<StockReleaseReplyPayload>(
      STOCK_RELEASE_SUBJECT,
      { orderReference, reason: 'credit_rejected' },
      meta(),
    );
    expect(releaseReply).toMatchObject({ outcome: 'released' });

    const headers = meta();
    const reply = await harness.requestBare<DespatchCreateReplyPayload | RpcError>(
      DESPATCH_CREATE_SUBJECT,
      { orderReference },
      headers,
    );

    expect((reply as RpcError).code).toBe('PRECONDITION_FAILED');
    expect(await harness.despatchOf(orderReference)).toBeUndefined();
    const outboxRows = await harness.outboxRowsFor(headers['x-correlation-id']);
    expect(outboxRows).toHaveLength(0);
  });

  it('concurrency against a simultaneous stock.release: exactly one of despatch.create/stock.release wins, and the final state is consistent either way', async () => {
    const productCode = `PRD-DESRACE-${Date.now()}`;
    await harness.seedStock([
      { companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 },
    ]);
    const orderReference = orderRef();

    await harness.requestBare<StockReserveReplyPayload>(
      STOCK_RESERVE_SUBJECT,
      {
        orderReference,
        retailerCode: 'RET-0001',
        companyCode: 'COM-0001',
        lines: [{ productCode, units: 5 }],
      },
      meta(),
    );

    const [despatchReply, releaseReply] = await Promise.all([
      harness.requestBare<DespatchCreateReplyPayload | RpcError>(
        DESPATCH_CREATE_SUBJECT,
        { orderReference },
        meta(),
      ),
      harness.requestBare<StockReleaseReplyPayload | RpcError>(
        STOCK_RELEASE_SUBJECT,
        { orderReference, reason: 'credit_rejected' },
        meta(),
      ),
    ]);

    const despatchWon = 'created' in despatchReply && despatchReply.created === true;
    const releaseWon = 'outcome' in releaseReply && releaseReply.outcome === 'released';

    // The lock protocol serialises on the same stock rows (design.md §4.3/
    // §4.4, reused unchanged) — exactly one of the two racing operations
    // observes the reservation still `reserved`; the loser observes it
    // already moved to a terminal status and fails its OWN precondition.
    expect(despatchWon).not.toBe(releaseWon);

    const reservationRows = await harness.reservationsOf(orderReference);
    if (despatchWon) {
      expect(reservationRows[0]?.status).toBe('consumed');
      expect((releaseReply as RpcError).code).toBe('PRECONDITION_FAILED');
      expect(await harness.despatchOf(orderReference)).toBeDefined();
    } else {
      expect(reservationRows[0]?.status).toBe('released');
      expect((despatchReply as RpcError).code).toBe('PRECONDITION_FAILED');
      expect(await harness.despatchOf(orderReference)).toBeUndefined();
    }

    // Whichever won, F1 still holds: reservedUnits never exceeds units.
    const stockRow = await harness.stockRowOf('COM-0001', productCode);
    expect(stockRow!.reservedUnits).toBeLessThanOrEqual(stockRow!.units);
    expect(stockRow?.reservedUnits).toBe(0);
  });
});
