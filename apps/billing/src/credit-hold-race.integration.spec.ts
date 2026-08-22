// BC9 — the concurrent-hold race against one nearly exhausted credit line
// (design.md §5.5, §13). Synchronises ONLY on replies + final Σhold−Σrelease
// + outbox contents (the binding reviewer ruling) — never a transient
// state. Repeated 10× on a FRESH credit line each time so a scheduling
// fluke is visible rather than lucky.
import { randomUUID } from 'node:crypto';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditHoldReplyPayload } from '@otc/contracts';
import { CREDIT_HOLD_SUBJECT } from './presentation/credit.controller';
import { startCreditIntegrationHarness, type CreditIntegrationHarness } from './test-support/credit-integration-harness';

const CURRENCY = 'EUR';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`credit-hold-race.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

/** `retailer_code`/`company_code` are varchar(20) — a short random suffix, not a timestamp. */
function shortId(): string {
  return randomUUID().slice(0, 6);
}

describe('billing.credit.hold — BC9, the concurrent-hold race (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: CreditIntegrationHarness;

  beforeAll(async () => {
    harness = await startCreditIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('two concurrent holds against a line with room for exactly one: exactly one credit.approved.v1, exactly one credit.rejected.v1, committed holds never exceed the limit, no deadlock', async () => {
    for (let i = 0; i < 10; i += 1) {
      const retailerCode = `RET-${shortId()}`;
      const companyCode = `COM-${shortId()}`;
      const creditId = await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 10_000, currencyCode: CURRENCY });
      const orderA = orderRef();
      const orderB = orderRef();
      const correlationA = UniqueId.generate();
      const correlationB = UniqueId.generate();

      const [replyA, replyB] = await Promise.all([
        harness.requestBare<CreditHoldReplyPayload>(
          CREDIT_HOLD_SUBJECT,
          { orderReference: orderA, retailerCode, companyCode, amount: { amount: 10_000, currency: CURRENCY } },
          { 'x-correlation-id': correlationA.value, 'x-request-id': UniqueId.generate().value },
        ),
        harness.requestBare<CreditHoldReplyPayload>(
          CREDIT_HOLD_SUBJECT,
          { orderReference: orderB, retailerCode, companyCode, amount: { amount: 10_000, currency: CURRENCY } },
          { 'x-correlation-id': correlationB.value, 'x-request-id': UniqueId.generate().value },
        ),
      ]);

      const outcomes = [replyA, replyB].map((r) => (r as CreditHoldReplyPayload).outcome).sort();
      expect(outcomes).toEqual(['approved', 'rejected']);

      const committed = await harness.committedExposureOf(creditId);
      expect(committed).toBeLessThanOrEqual(10_000);
      expect(committed).toBe(10_000); // exactly the winner's hold, never both

      await waitFor(async () => {
        const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
        return rowsA.length === 1 && rowsA[0]?.publishedAt !== null && rowsB.length === 1 && rowsB[0]?.publishedAt !== null;
      });
      const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
      const eventTypes = [rowsA[0]?.eventType, rowsB[0]?.eventType].sort();
      expect(eventTypes).toEqual(['credit.approved.v1', 'credit.rejected.v1']);
    }
  }, 120_000);
});
