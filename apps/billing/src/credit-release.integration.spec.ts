// BC11, B5, BC3, BC1 — the real AppModule graph, real MySQL + NATS + Kafka.
// The follow-up pass closing feature 41's `credit_approved`/`confirmed`
// gap: `billing.credit.release` — mirrors `credit-hold.integration.spec.ts`'s
// own shape and synchronisation discipline (design.md §13: an outbox row's
// `publishedAt`, never a transient counter mid-flight).
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditHoldReplyPayload, CreditReleaseReplyPayload } from '@otc/contracts';
import { CREDIT_HOLD_SUBJECT, CREDIT_RELEASE_SUBJECT } from './presentation/credit.controller';
import { startBillingIntegrationHarness, type BillingIntegrationHarness } from './test-support/billing-integration-harness';

const CURRENCY = 'EUR';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`credit-release.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function headersOf(correlationId: UniqueId, requestId: UniqueId): Record<string, string> {
  return { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value };
}

describe('billing.credit.release — BC1, BC3, BC11/B5 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: BillingIntegrationHarness;

  beforeAll(async () => {
    harness = await startBillingIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('releases a genuine outstanding hold: released reply, one release ledger row, one credit.released.v1 outbox row with reason order_cancelled, and — the idempotency proof — a SECOND call afterwards finds zero outstanding exposure, writes no second entry and emits no second fact', async () => {
    const retailerCode = `RET-${shortId()}`;
    const companyCode = `COM-${shortId()}`;
    const creditId = await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const holdCorrelationId = UniqueId.generate();

    const holdReply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode, companyCode, amount: { amount: 100_000, currency: CURRENCY } },
      headersOf(holdCorrelationId, UniqueId.generate()),
    );
    expect(holdReply).toMatchObject({ outcome: 'approved', heldAmount: 100_000 });
    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(holdCorrelationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });

    const releaseCorrelationId = UniqueId.generate();
    const releaseRequestId = UniqueId.generate();
    const releaseReply = await harness.requestBare<CreditReleaseReplyPayload>(
      CREDIT_RELEASE_SUBJECT,
      { orderReference, retailerCode, companyCode },
      headersOf(releaseCorrelationId, releaseRequestId),
    );

    expect(releaseReply).toMatchObject({ released: true, orderReference, releasedAmount: 100_000, availableCreditAfter: 500_000 });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows.find((row) => row.type === 'release')).toMatchObject({ amount: 100_000 });

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(releaseCorrelationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const releaseOutboxRows = await harness.outboxRowsFor(releaseCorrelationId.value);
    expect(releaseOutboxRows).toHaveLength(1);
    expect(releaseOutboxRows[0]).toMatchObject({
      eventType: 'credit.released.v1',
      correlationId: releaseCorrelationId.value,
      causationId: releaseRequestId.value,
    });
    const payload = releaseOutboxRows[0]!.payload as { reason: string; releasedAmount: number; availableCreditAfter: number };
    expect(payload).toMatchObject({ reason: 'order_cancelled', releasedAmount: 100_000 });
    const recomputed = 500_000 - (await harness.committedExposureOf(creditId));
    expect(payload.availableCreditAfter).toBe(recomputed);

    // BC11/B5 — the idempotent repeat: a SECOND release RPC for the SAME
    // order finds zero outstanding exposure (Σhold − Σrelease = 0),
    // appends no THIRD ledger row and emits no second fact under this new
    // correlationId.
    const secondCorrelationId = UniqueId.generate();
    const secondReply = await harness.requestBare<CreditReleaseReplyPayload>(
      CREDIT_RELEASE_SUBJECT,
      { orderReference, retailerCode, companyCode },
      headersOf(secondCorrelationId, UniqueId.generate()),
    );

    expect(secondReply).toMatchObject({ released: false, orderReference, availableCreditAfter: 500_000 });
    expect(secondReply).not.toHaveProperty('releasedAmount');

    const ledgerRowsAfterSecondCall = await harness.ledgerOf(orderReference);
    expect(ledgerRowsAfterSecondCall).toHaveLength(2); // still hold + release, no third entry

    const secondOutboxRows = await harness.outboxRowsFor(secondCorrelationId.value);
    expect(secondOutboxRows).toHaveLength(0); // no fact under the second call's own correlationId
  });

  it('BC3 — replies NOT_FOUND naming the pair, writes no ledger entry and emits no fact when no credit line exists for the retailer and company', async () => {
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditReleaseReplyPayload>(
      CREDIT_RELEASE_SUBJECT,
      { orderReference, retailerCode: 'NO-SUCH-RETAILER-2', companyCode: 'NO-SUCH-COMPANY-2' },
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ code: 'NOT_FOUND', details: { retailerCode: 'NO-SUCH-RETAILER-2', companyCode: 'NO-SUCH-COMPANY-2' } });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(0);
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(0);
  });

  it('BC1 — replies VALIDATION_FAILED and dispatches nothing when x-correlation-id/x-request-id is missing', async () => {
    const orderReference = orderRef();

    const reply = await harness.requestBare<CreditReleaseReplyPayload>(CREDIT_RELEASE_SUBJECT, {
      orderReference,
      retailerCode: 'RET-0001',
      companyCode: 'COM-0001',
    });

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('an order that was never held at all replies released: false, writes nothing, emits nothing', async () => {
    const retailerCode = `RET-NH-${shortId()}`;
    const companyCode = `COM-NH-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditReleaseReplyPayload>(
      CREDIT_RELEASE_SUBJECT,
      { orderReference, retailerCode, companyCode },
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ released: false, orderReference });
    expect(await harness.ledgerOf(orderReference)).toHaveLength(0);
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
  });
});
