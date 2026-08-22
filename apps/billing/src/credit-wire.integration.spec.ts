// BC2 — the wire finding of design.md §4.3, proven against the real
// AppModule graph with the real bare-JSON (de)serializer pair: a raw
// `nats` client gets a bare-JSON reply on both subjects, and a bare JSON
// `RpcError` on a validation failure — never a Nest packet
// (`{response, isDisposed, id}`).
import { randomUUID } from 'node:crypto';
import { JSONCodec, headers as natsHeaders } from 'nats';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREDIT_HOLD_SUBJECT, CREDIT_LIST_SUBJECT } from './presentation/credit.controller';
import { startCreditIntegrationHarness, type CreditIntegrationHarness } from './test-support/credit-integration-harness';

const codec = JSONCodec();
const FRAMEWORK_PACKET_KEYS = ['response', 'isDisposed', 'id'];
const CURRENCY = 'EUR';

/** `retailer_code`/`company_code` are varchar(20) — a short random suffix, not a timestamp. */
function shortId(): string {
  return randomUUID().slice(0, 6);
}

function assertBareShape(decoded: unknown): void {
  expect(typeof decoded).toBe('object');
  const keys = Object.keys(decoded as Record<string, unknown>);
  for (const forbidden of FRAMEWORK_PACKET_KEYS) {
    expect(keys).not.toContain(forbidden);
  }
}

describe('billing.credit.* — BC2, the bare-JSON wire (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: CreditIntegrationHarness;

  beforeAll(async () => {
    harness = await startCreditIntegrationHarness();
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

  it('answers a bare-JSON request from a raw nats client with a bare-JSON reply on billing.credit.hold', async () => {
    const suffix = shortId();
    const retailerCode = `RET-W-${suffix}`;
    const companyCode = `COM-W-${suffix}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 100_000, currencyCode: CURRENCY });
    const orderReference = `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;

    const decoded = await rawRequest(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode, companyCode, amount: { amount: 1_000, currency: CURRENCY } },
      { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
    );

    assertBareShape(decoded);
    expect(decoded).toMatchObject({ outcome: 'approved', orderReference });
  });

  it('answers a bare-JSON request from a raw nats client with a bare-JSON reply on billing.credit.list', async () => {
    const decoded = await rawRequest(CREDIT_LIST_SUBJECT, { page: 1, pageSize: 5 });

    assertBareShape(decoded);
    expect(decoded).toHaveProperty('items');
    expect(decoded).toHaveProperty('page');
  });

  it('answers a bare-JSON RpcError on a validation failure', async () => {
    const decoded = await rawRequest(CREDIT_HOLD_SUBJECT, { orderReference: 'not-valid' });

    assertBareShape(decoded);
    expect(decoded).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
