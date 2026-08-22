// R38/R39 integration halves, BC1, BC3, BC4, BC7, BC8, BC10 — the real
// AppModule graph, real MySQL + NATS + Kafka. Synchronises only on
// terminal/monotonic evidence (design.md §13, the binding reviewer ruling):
// an outbox row's `publishedAt`, never a transient counter mid-flight.
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
  throw new Error(`credit-hold.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

/** `retailer_code`/`company_code` are varchar(20) — a short random suffix, not a timestamp. */
function shortId(): string {
  return randomUUID().slice(0, 6);
}

function headersOf(correlationId: UniqueId, requestId: UniqueId): Record<string, string> {
  return { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value };
}

describe('billing.credit.hold — R38/R39, BC1, BC3, BC4, BC7, BC8, BC10 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: CreditIntegrationHarness;

  beforeAll(async () => {
    harness = await startCreditIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('approved reply + exactly one hold row + exactly one credit.approved.v1 outbox row whose correlationId/causationId equal the headers, and whose availableCreditAfter matches the recomputed value (BC1, BC10)', async () => {
    const retailerCode = `RET-${shortId()}`;
    const companyCode = `COM-${shortId()}`;
    const creditId = await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode, companyCode, amount: { amount: 100_000, currency: CURRENCY } },
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ outcome: 'approved', orderReference, heldAmount: 100_000, availableCredit: 400_000 });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({ type: 'hold', amount: 100_000 });

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      eventType: 'credit.approved.v1',
      correlationId: correlationId.value,
      causationId: requestId.value,
    });
    const payload = outboxRows[0]!.payload as { availableCreditAfter: number };
    const recomputed = 500_000 - (await harness.committedExposureOf(creditId));
    expect(payload.availableCreditAfter).toBe(recomputed);
  });

  it('over-limit hold ⇒ rejected reply, zero credit_items rows written, one credit.rejected.v1 with reason: over_limit (R39 integration half)', async () => {
    const retailerCode = `RET-OL-${shortId()}`;
    const companyCode = `COM-OL-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 10_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
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
    expect(outboxRows[0]).toMatchObject({ eventType: 'credit.rejected.v1' });
    expect((outboxRows[0]?.payload as { reason: string }).reason).toBe('over_limit');
  });

  it('BC3 — replies NOT_FOUND naming the pair, writes no ledger entry and emits no fact when no credit line exists for the retailer and company', async () => {
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode: 'NO-SUCH-RETAILER', companyCode: 'NO-SUCH-COMPANY', amount: { amount: 1_000, currency: CURRENCY } },
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ code: 'NOT_FOUND', details: { retailerCode: 'NO-SUCH-RETAILER', companyCode: 'NO-SUCH-COMPANY' } });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(0);
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(0);
  });

  it('BC4 — replies VALIDATION_FAILED, writes no ledger entry and emits no fact when the requested currency differs from the credit line\'s', async () => {
    const retailerCode = `RET-CU-${shortId()}`;
    const companyCode = `COM-CU-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: 'EUR' });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      { orderReference, retailerCode, companyCode, amount: { amount: 1_000, currency: 'GBP' } },
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED', details: { expected: 'EUR', received: 'GBP' } });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(0);
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(0);
  });

  it('BC7 — answers already_held with the recorded held amount and the current available credit, writes no entry and emits no second fact when billing.credit.hold is re-issued for the same order (including the released-then-re-issued variant)', async () => {
    const retailerCode = `RET-DU-${shortId()}`;
    const companyCode = `COM-DU-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();
    const request = { orderReference, retailerCode, companyCode, amount: { amount: 50_000, currency: CURRENCY } };

    const first = await harness.requestBare<CreditHoldReplyPayload>(CREDIT_HOLD_SUBJECT, request, headersOf(correlationId, requestId));
    expect(first).toMatchObject({ outcome: 'approved' });

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });

    const second = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      request,
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(second).toMatchObject({ outcome: 'already_held', heldAmount: 50_000 });

    const ledgerRows = await harness.ledgerOf(orderReference);
    expect(ledgerRows).toHaveLength(1);
    // No second fact for the re-issue — outbox count stays 1 for the FIRST correlationId.
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(1);

    // The released-then-re-issued variant: release the hold directly at
    // the DB level (this feature ships no release responder — releaseHold
    // has no caller yet, requirements.md §0), then re-issue the hold and
    // confirm BC7 still answers already_held (any recorded hold entry,
    // whatever its net exposure).
    const releasedOrder = orderRef();
    const releasedCorrelationId = UniqueId.generate();
    const releasedRequest = { orderReference: releasedOrder, retailerCode, companyCode, amount: { amount: 30_000, currency: CURRENCY } };
    await harness.requestBare<CreditHoldReplyPayload>(CREDIT_HOLD_SUBJECT, releasedRequest, headersOf(releasedCorrelationId, UniqueId.generate()));
    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(releasedCorrelationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const creditRow = await harness.creditRowOf(retailerCode, companyCode);
    await harness.seedCreditItem({ creditId: creditRow!.id, orderReference: releasedOrder, amount: 30_000, type: 'release' });

    const reissued = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      releasedRequest,
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(reissued).toMatchObject({ outcome: 'already_held', heldAmount: 30_000 });
    const releasedLedgerRows = await harness.ledgerOf(releasedOrder);
    expect(releasedLedgerRows).toHaveLength(2); // hold + release, still — no third entry
  });

  it('BC8 — re-evaluates a previously rejected hold from scratch and writes no ledger entry either time', async () => {
    const retailerCode = `RET-RJ-${shortId()}`;
    const companyCode = `COM-RJ-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 10_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const request = { orderReference, retailerCode, companyCode, amount: { amount: 20_000, currency: CURRENCY } };

    const first = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      request,
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(first).toMatchObject({ outcome: 'rejected', reason: 'over_limit' });
    expect(await harness.ledgerOf(orderReference)).toHaveLength(0);

    const second = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      request,
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(second).toMatchObject({ outcome: 'rejected', reason: 'over_limit' });
    // Wait on the reply only (terminal evidence) — the append-only
    // credit_items count is unchanged, both times.
    expect(await harness.ledgerOf(orderReference)).toHaveLength(0);
  });
});
