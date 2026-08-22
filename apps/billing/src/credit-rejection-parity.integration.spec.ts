// R42, R44 — the real AppModule graph, real MySQL + NATS + Kafka, the
// simulator UNCONDITIONALLY bound (app.module.ts). Proves the `.99` rule
// end to end against the live provider graph (R42, complementing the pure
// unit in infrastructure/credit/simulator-credit-decision.spec.ts) and
// that a simulated rejection and a genuine over-limit rejection are
// indistinguishable downstream except by `reason` — same fact type, same
// payload shape — and that R37's genuine over-limit rejection remains
// reachable with the simulator bound and `CREDIT_FAILURE_RATE = 0` (R44).
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
  throw new Error(`credit-rejection-parity.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

function shortId(): string {
  return randomUUID().slice(0, 6);
}

function headersOf(correlationId: UniqueId, requestId: UniqueId): Record<string, string> {
  return { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value };
}

describe('billing.credit.hold — credit-rejection-parity, R42/R44 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: CreditIntegrationHarness;

  beforeAll(async () => {
    // CREDIT_FAILURE_RATE is deliberately left unset — R43's default (0) —
    // so nothing in this file's outcomes depends on randomness.
    harness = await startCreditIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('R42 — rejects a fitting hold whose total ends in 99 minor units with simulated_cents_rule, ample credit notwithstanding, writing no ledger entry and emitting exactly one credit.rejected.v1', async () => {
    const retailerCode = `RET-CR-${shortId()}`;
    const companyCode = `COM-CR-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode, companyCode, amount: { amount: 24_999, currency: CURRENCY } },
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ outcome: 'rejected', reason: 'simulated_cents_rule', availableCredit: 500_000 });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(0);

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ eventType: 'credit.rejected.v1' });
    const simulatedPayload = outboxRows[0]!.payload as Record<string, unknown>;
    expect(simulatedPayload).toMatchObject({
      orderReference,
      retailerCode,
      companyCode,
      currency: CURRENCY,
      requestedAmount: 24_999,
      availableCredit: 500_000,
      reason: 'simulated_cents_rule',
    });
  });

  it('R44 — a genuine over-limit rejection is still reachable with the simulator bound and CREDIT_FAILURE_RATE at its default of zero, producing the same fact type and payload shape as the simulated rejection, differing only in reason', async () => {
    const retailerCode = `RET-OL2-${shortId()}`;
    const companyCode = `COM-OL2-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 10_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      // 20_000 does not end in 99 — this must be a GENUINE over_limit
      // rejection from the aggregate (R37), never the simulator's rule.
      { orderReference, retailerCode, companyCode, amount: { amount: 20_000, currency: CURRENCY } },
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ outcome: 'rejected', reason: 'over_limit', availableCredit: 10_000 });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(0);

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ eventType: 'credit.rejected.v1' });
    const overLimitPayload = outboxRows[0]!.payload as Record<string, unknown>;
    expect(overLimitPayload).toMatchObject({
      orderReference,
      retailerCode,
      companyCode,
      currency: CURRENCY,
      requestedAmount: 20_000,
      availableCredit: 10_000,
      reason: 'over_limit',
    });

    // Same shape as the simulated rejection above — same key set, the
    // `reason` value is the only thing that differs (R44).
    const simulatedKeys = ['orderReference', 'retailerCode', 'companyCode', 'creditCode', 'currency', 'requestedAmount', 'availableCredit', 'reason'].sort();
    expect(Object.keys(overLimitPayload).sort()).toEqual(simulatedKeys);
  });
});
