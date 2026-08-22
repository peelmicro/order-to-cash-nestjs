// BC6 integration half — the real AppModule graph, real MySQL + NATS.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditListReplyPayload } from '@otc/contracts';
import { CREDIT_LIST_SUBJECT } from './presentation/credit.controller';
import { startCreditIntegrationHarness, type CreditIntegrationHarness } from './test-support/credit-integration-harness';

const CURRENCY = 'EUR';

/** `retailer_code`/`company_code` are varchar(20) — a short random suffix, not a timestamp. */
function shortId(): string {
  return randomUUID().slice(0, 6);
}

describe('billing.credit.list — BC6 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: CreditIntegrationHarness;

  beforeAll(async () => {
    harness = await startCreditIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('reports activeHolds, openExposure and availableCredit that reconcile to the credit limit for every listed line', async () => {
    const suffix = shortId();

    const neverHeld = await harness.seedCreditLine({
      retailerCode: `RET-N-${suffix}`,
      companyCode: `COM-N-${suffix}`,
      creditLimit: 100_000,
      currencyCode: CURRENCY,
      code: `CR-${suffix}1`,
    });

    const held = await harness.seedCreditLine({
      retailerCode: `RET-H-${suffix}`,
      companyCode: `COM-H-${suffix}`,
      creditLimit: 100_000,
      currencyCode: CURRENCY,
      code: `CR-${suffix}2`,
    });
    await harness.seedCreditItem({ creditId: held, orderReference: 'ORD-500001', amount: 25_000, type: 'hold' });

    const heldConsumed = await harness.seedCreditLine({
      retailerCode: `RET-C-${suffix}`,
      companyCode: `COM-C-${suffix}`,
      creditLimit: 100_000,
      currencyCode: CURRENCY,
      code: `CR-${suffix}3`,
    });
    await harness.seedCreditItem({ creditId: heldConsumed, orderReference: 'ORD-500002', amount: 35_000, type: 'hold' });
    await harness.seedCreditItem({ creditId: heldConsumed, orderReference: 'ORD-500002', amount: 35_000, type: 'consume' });

    const heldReleased = await harness.seedCreditLine({
      retailerCode: `RET-R-${suffix}`,
      companyCode: `COM-R-${suffix}`,
      creditLimit: 100_000,
      currencyCode: CURRENCY,
      code: `CR-${suffix}4`,
    });
    await harness.seedCreditItem({ creditId: heldReleased, orderReference: 'ORD-500003', amount: 45_000, type: 'hold' });
    await harness.seedCreditItem({ creditId: heldReleased, orderReference: 'ORD-500003', amount: 45_000, type: 'release' });

    const reply = await harness.requestBare<CreditListReplyPayload>(CREDIT_LIST_SUBJECT, { page: 1, pageSize: 200 });
    const items = (reply as CreditListReplyPayload).items;

    for (const item of items) {
      expect(item.activeHolds + item.openExposure).toBe(item.creditLimit - item.availableCredit);
    }

    const byCode = new Map(items.map((item) => [item.creditCode, item]));
    expect(byCode.get(`CR-${suffix}1`)).toMatchObject({ activeHolds: 0, openExposure: 0, availableCredit: 100_000 });
    expect(byCode.get(`CR-${suffix}2`)).toMatchObject({ activeHolds: 25_000, openExposure: 0, availableCredit: 75_000 });
    expect(byCode.get(`CR-${suffix}3`)).toMatchObject({ activeHolds: 0, openExposure: 35_000, availableCredit: 65_000 });
    expect(byCode.get(`CR-${suffix}4`)).toMatchObject({ activeHolds: 0, openExposure: 0, availableCredit: 100_000 });

    void neverHeld;
  });
});
