// `BI8` — the concurrent-issue race for one order. Synchronises ONLY on
// replies + final row counts + outbox contents (design.md §10) — never a
// transient state. Repeated on ten fresh orders each time so a scheduling
// fluke is visible rather than lucky.
import { randomUUID } from 'node:crypto';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditHoldReplyPayload, InvoiceIssueReplyPayload } from '@otc/contracts';
import { CREDIT_HOLD_SUBJECT } from './presentation/credit.controller';
import { INVOICE_ISSUE_SUBJECT } from './presentation/invoice.controller';
import { startBillingIntegrationHarness, type BillingIntegrationHarness } from './test-support/billing-integration-harness';

const CURRENCY = 'EUR';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`invoice-issue-race.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

function shortId(): string {
  return randomUUID().slice(0, 6);
}

describe('billing.invoice.issue — BI8, the concurrent-issue race (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: BillingIntegrationHarness;

  beforeAll(async () => {
    harness = await startBillingIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('two concurrent issue requests for one order produce exactly one invoice, one consume entry and one invoice.issued.v1, with no deadlock', async () => {
    const retailerCode = `RET-RACE-${shortId()}`;
    const companyCode = `COM-RACE-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 100_000_000, currencyCode: CURRENCY });

    for (let i = 0; i < 10; i += 1) {
      const orderReference = orderRef();
      await harness.requestBare<CreditHoldReplyPayload>(
        CREDIT_HOLD_SUBJECT,
        harness.holdRequest({ orderReference, retailerCode, companyCode, currency: CURRENCY, amount: 40_000 }),
        { 'x-correlation-id': UniqueId.generate().value, 'x-request-id': UniqueId.generate().value },
      );

      const issuePayload = harness.issueRequest({
        orderReference,
        retailerCode,
        companyCode,
        currency: CURRENCY,
        lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 40_000 }],
      });
      const correlationA = UniqueId.generate();
      const correlationB = UniqueId.generate();

      const [replyA, replyB] = await Promise.all([
        harness.requestBare<InvoiceIssueReplyPayload>(INVOICE_ISSUE_SUBJECT, issuePayload, {
          'x-correlation-id': correlationA.value,
          'x-request-id': UniqueId.generate().value,
        }),
        harness.requestBare<InvoiceIssueReplyPayload>(INVOICE_ISSUE_SUBJECT, issuePayload, {
          'x-correlation-id': correlationB.value,
          'x-request-id': UniqueId.generate().value,
        }),
      ]);

      const createdFlags = [replyA, replyB].map((reply) => (reply as InvoiceIssueReplyPayload).created).sort();
      expect(createdFlags).toEqual([false, true]);
      const invoiceReferences = new Set([replyA, replyB].map((reply) => (reply as InvoiceIssueReplyPayload).invoiceReference));
      expect(invoiceReferences.size).toBe(1); // both name the SAME reference.

      const invoiceRows = await harness.invoicesOf(orderReference);
      expect(invoiceRows).toHaveLength(1);
      const ledgerRows = await harness.ledgerOf(orderReference);
      expect(ledgerRows.filter((row) => row.type === 'consume')).toHaveLength(1);

      await waitFor(async () => {
        const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
        const total = rowsA.length + rowsB.length;
        return total === 1 && [...rowsA, ...rowsB].every((row) => row.publishedAt !== null);
      });
      const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
      expect(rowsA.length + rowsB.length).toBe(1);
      expect([...rowsA, ...rowsB][0]).toMatchObject({ eventType: 'invoice.issued.v1' });
    }
  }, 120_000);
});
