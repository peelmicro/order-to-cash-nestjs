// FS4 — the wire finding of design.md §6.3, proven against the real
// AppModule graph with the real bare-JSON (de)serializer pair: a raw
// `nats` client gets a bare-JSON reply on all five subjects, and a bare
// JSON `RpcError` on a validation failure — never a Nest packet
// (`{response, isDisposed, id}`).
import { JSONCodec, headers as natsHeaders } from 'nats';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STOCK_CHECK_SUBJECT,
  STOCK_LIST_SUBJECT,
  STOCK_RELEASE_SUBJECT,
  STOCK_REPLENISH_SUBJECT,
  STOCK_RESERVE_SUBJECT,
} from './presentation/stock.controller';
import { startStockIntegrationHarness, type StockIntegrationHarness } from './test-support/stock-integration-harness';

const codec = JSONCodec();
const FRAMEWORK_PACKET_KEYS = ['response', 'isDisposed', 'id'];

function assertBareShape(decoded: unknown): void {
  expect(typeof decoded).toBe('object');
  const keys = Object.keys(decoded as Record<string, unknown>);
  for (const forbidden of FRAMEWORK_PACKET_KEYS) {
    expect(keys).not.toContain(forbidden);
  }
}

describe('stock.* — FS4, the bare-JSON wire (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: StockIntegrationHarness;

  beforeAll(async () => {
    harness = await startStockIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  async function rawRequest(subject: string, payload: unknown, headerRecord?: Record<string, string>): Promise<unknown> {
    let h: ReturnType<typeof natsHeaders> | undefined;
    if (headerRecord) {
      h = natsHeaders();
      for (const [key, value] of Object.entries(headerRecord)) h.set(key, value);
    }
    const reply = await harness.testNatsConnection.request(subject, codec.encode(payload), { timeout: 5000, headers: h });
    return codec.decode(reply.data);
  }

  it('answers a bare-JSON request with a bare-JSON reply on stock.check', async () => {
    const productCode = `PRD-WIRE-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);

    const decoded = await rawRequest(STOCK_CHECK_SUBJECT, { companyCode: 'COM-0001', lines: [{ productCode, quantity: 1 }] });

    assertBareShape(decoded);
    expect(decoded).toMatchObject({ available: true });
  });

  it('answers a bare-JSON request with a bare-JSON reply on stock.reserve', async () => {
    const productCode = `PRD-WIRE-RES-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 10, reservedUnits: 0 }]);
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;

    const decoded = await rawRequest(
      STOCK_RESERVE_SUBJECT,
      { orderReference, retailerCode: 'RET-0001', companyCode: 'COM-0001', lines: [{ productCode, units: 1 }] },
      { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
    );

    assertBareShape(decoded);
    expect(decoded).toMatchObject({ outcome: 'accepted', orderReference });
  });

  it('answers a bare-JSON request with a bare-JSON reply on stock.release', async () => {
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;

    const decoded = await rawRequest(
      STOCK_RELEASE_SUBJECT,
      { orderReference, reason: 'order_cancelled' },
      { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
    );

    assertBareShape(decoded);
    expect(decoded).toMatchObject({ outcome: 'already_released' });
  });

  it('answers a bare-JSON request with a bare-JSON reply on stock.list', async () => {
    const decoded = await rawRequest(STOCK_LIST_SUBJECT, { page: 1, pageSize: 5 });

    assertBareShape(decoded);
    expect(decoded).toHaveProperty('items');
    expect(decoded).toHaveProperty('page');
  });

  it('answers a bare-JSON request with a bare-JSON reply on stock.replenish', async () => {
    const productCode = `PRD-WIRE-REP-${Date.now()}`;
    await harness.seedStock([{ companyCode: 'COM-0001', productCode, units: 5, reservedUnits: 0 }]);

    const decoded = await rawRequest(STOCK_REPLENISH_SUBJECT, { companyCode: 'COM-0001', lines: [{ productCode, units: 1 }] });

    assertBareShape(decoded);
    expect(decoded).toHaveProperty('items');
  });

  it('answers a bare-JSON RpcError on a validation failure', async () => {
    const decoded = await rawRequest(STOCK_CHECK_SUBJECT, { companyCode: 'COM-0001', lines: [] });

    assertBareShape(decoded);
    expect(decoded).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
