// Shared R45's integration half, BI2–BI6, BI9 — the real AppModule graph,
// real MySQL + NATS + Kafka. Synchronises only on terminal/monotonic
// evidence (design.md §10): the reply, then row counts and the outbox —
// never a transient status.
import { randomUUID } from 'node:crypto';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditHoldReplyPayload, InvoiceIssueReplyPayload } from '@otc/contracts';
import { CREDIT_HOLD_SUBJECT } from './presentation/credit.controller';
import { INVOICE_ISSUE_SUBJECT } from './presentation/invoice.controller';
import { startBillingIntegrationHarness, type BillingIntegrationHarness } from './test-support/billing-integration-harness';
import { invoiceNumberSequences, outbox } from './infrastructure/persistence/schema';

const CURRENCY = 'EUR';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`invoice-issue.integration: condition not met within ${timeoutMs}ms`);
}

function orderRef(): string {
  return `ORD-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

function invoiceRef(): string {
  return `INV-${String(Math.floor(Math.random() * 900_000) + 100_000)}`;
}

/** `retailer_code`/`company_code` are varchar(20) — a short random suffix, not a timestamp. */
function shortId(): string {
  return randomUUID().slice(0, 6);
}

function headersOf(correlationId: UniqueId, requestId: UniqueId): Record<string, string> {
  return { 'x-correlation-id': correlationId.value, 'x-request-id': requestId.value };
}

describe('billing.invoice.issue — R45 integration half, BI2–BI6, BI9 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: BillingIntegrationHarness;

  beforeAll(async () => {
    harness = await startBillingIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  it('H1/R45 — one invoices row, its invoice_items, one consume entry of exactly the hold amount, one invoice.issued.v1 outbox record whose envelope carries the order as correlationId and the request as causationId, and a reply with created: true', async () => {
    const retailerCode = `RET-H1-${shortId()}`;
    const companyCode = `COM-H1-${shortId()}`;
    const creditId = await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();

    // Place a real hold first — the saga's step 4 precondition.
    const holdReply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      harness.holdRequest({ orderReference, retailerCode, companyCode, currency: CURRENCY, amount: 100_000 }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(holdReply).toMatchObject({ outcome: 'approved' });

    // H2 — R40's neutrality: availableCredit before the issue.
    const availableCreditBefore = 500_000 - (await harness.committedExposureOf(creditId));
    // N7 (review_billing_invoicing.md) — the WHOLE-TABLE outbox count
    // before the issue, unfiltered by correlationId. A correlationId-scoped
    // assertion alone cannot see a stray fact written under a DIFFERENT
    // correlationId (e.g. a regression on the consume path emitting under
    // the credit line's own id, as BI7's armed H10 deletion simulated) —
    // mirroring BI7's repository-level delta guard at the responder level
    // closes that last hole in R40's suppression guard.
    const outboxCountBefore = (await harness.db.select().from(outbox)).length;

    const correlationId = UniqueId.generate(); // the order id
    const requestId = UniqueId.generate();
    const issuePayload = harness.issueRequest({
      orderReference,
      retailerCode,
      companyCode,
      currency: CURRENCY,
      lines: [{ productCode: 'PRD-0001', units: 2, unitPrice: 50_000 }],
    });

    const reply = await harness.requestBare<InvoiceIssueReplyPayload>(INVOICE_ISSUE_SUBJECT, issuePayload, headersOf(correlationId, requestId));

    expect(reply).toMatchObject({ created: true, orderReference, currency: CURRENCY, totalAmount: 100_000, status: 'issued' });

    const invoiceRows = await harness.invoicesOf(orderReference);
    expect(invoiceRows).toHaveLength(1);
    const itemRows = await harness.invoiceItemsOf(invoiceRows[0]!.id);
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]).toMatchObject({ productCode: 'PRD-0001', units: 2, price: 50_000 });

    const ledgerRows = await harness.ledgerOf(orderReference);
    const consumeRows = ledgerRows.filter((row) => row.type === 'consume');
    expect(consumeRows).toHaveLength(1);
    expect(consumeRows[0]).toMatchObject({ amount: 100_000 });

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 1 && rows[0]?.publishedAt !== null;
    });
    const outboxRows = await harness.outboxRowsFor(correlationId.value);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ eventType: 'invoice.issued.v1', correlationId: correlationId.value, causationId: requestId.value });

    // N7 — the WHOLE-TABLE delta must be exactly 1: the issue AND its
    // consume together add exactly one outbox row, from EITHER aggregate,
    // not just exactly one keyed to this correlationId.
    const outboxCountAfter = (await harness.db.select().from(outbox)).length;
    expect(outboxCountAfter - outboxCountBefore).toBe(1);

    // H2 — availableCredit is NUMERICALLY UNCHANGED by the whole exercise
    // (R40's neutrality, now visible against a live consume call).
    const availableCreditAfter = 500_000 - (await harness.committedExposureOf(creditId));
    expect(availableCreditAfter).toBe(availableCreditBefore);
  });

  it('BI3 — replies NOT_FOUND naming the pair, creates no invoice, appends no ledger entry and emits no fact when no credit line exists', async () => {
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({
        orderReference,
        retailerCode: 'NO-SUCH-RETAILER',
        companyCode: 'NO-SUCH-COMPANY',
        currency: CURRENCY,
        lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1_000 }],
      }),
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ code: 'NOT_FOUND', details: { retailerCode: 'NO-SUCH-RETAILER', companyCode: 'NO-SUCH-COMPANY' } });
    expect(await harness.invoicesOf(orderReference)).toHaveLength(0);
    expect(await harness.ledgerOf(orderReference)).toHaveLength(0);
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
  });

  it('BI4 — replies VALIDATION_FAILED, creates no invoice, appends no ledger entry and emits no fact when the requested currency differs from the credit line\'s', async () => {
    const retailerCode = `RET-BI4-${shortId()}`;
    const companyCode = `COM-BI4-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: 'EUR' });
    const orderReference = orderRef();
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({
        orderReference,
        retailerCode,
        companyCode,
        currency: 'GBP',
        lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1_000 }],
      }),
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ code: 'VALIDATION_FAILED', details: { expected: 'EUR', received: 'GBP' } });
    expect(await harness.invoicesOf(orderReference)).toHaveLength(0);
    expect(await harness.ledgerOf(orderReference)).toHaveLength(0);
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
  });

  it('BI5 — replies PRECONDITION_FAILED with code NO_ACTIVE_HOLD, creates no invoice and emits no fact for an order whose hold was released', async () => {
    const retailerCode = `RET-BI5-${shortId()}`;
    const companyCode = `COM-BI5-${shortId()}`;
    const creditId = await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    await harness.seedCreditItem({ creditId, orderReference, amount: 40_000, type: 'hold' });
    await harness.seedCreditItem({ creditId, orderReference, amount: 40_000, type: 'release' });
    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();

    const reply = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({
        orderReference,
        retailerCode,
        companyCode,
        currency: CURRENCY,
        lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1_000 }],
      }),
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ code: 'PRECONDITION_FAILED', details: { code: 'NO_ACTIVE_HOLD' } });
    expect(await harness.invoicesOf(orderReference)).toHaveLength(0);
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
    // N3 (review_billing_invoicing.md) — BI5's third clause, "SHALL append
    // no ledger entry", was previously unasserted: the order's two
    // pre-seeded rows (hold + release) were never re-read. Exactly 2,
    // never 3 — no consume was appended on this refusal path.
    expect(await harness.ledgerOf(orderReference)).toHaveLength(2);
  });

  it('BI2 — answers VALIDATION_FAILED and writes nothing when the headers or the payload are invalid', async () => {
    const retailerCode = `RET-BI2-${shortId()}`;
    const companyCode = `COM-BI2-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();
    const validPayload = harness.issueRequest({
      orderReference,
      retailerCode,
      companyCode,
      currency: CURRENCY,
      lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1_000 }],
    });

    // Missing headers.
    const noHeaders = await harness.requestBare<InvoiceIssueReplyPayload>(INVOICE_ISSUE_SUBJECT, validPayload);
    expect(noHeaders).toMatchObject({ code: 'VALIDATION_FAILED' });

    // Malformed payload — empty lines.
    const badPayload = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      { ...validPayload, lines: [] },
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(badPayload).toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await harness.invoicesOf(orderReference)).toHaveLength(0);

    // N2 (review_billing_invoicing.md) — "a discount that exceeds the
    // computed amount" must be refused BEFORE any transaction is opened.
    // The property under test is NOT the error code (a correct code would
    // still pass with the check sitting uselessly inside the transaction)
    // but that nothing was written: no invoice, no ledger entry, no fact,
    // and the service's HOTTEST lock — invoice_number_sequences, taken last
    // inside the transaction by design (§5.4) — was never touched. The counter
    // is a plain table row that rolls back with everything else, so
    // byte-identical before/after proves only that nothing was written,
    // not that the transaction was never opened. The proof that rejection
    // happens before dispatch comes from the unit case in
    // presentation/invoice.controller.spec.ts, which asserts the command
    // bus was never called.
    const counterBefore = await harness.db.select().from(invoiceNumberSequences);
    const discountOrder = orderRef();
    const excessiveDiscountPayload = harness.issueRequest({
      orderReference: discountOrder,
      retailerCode,
      companyCode,
      currency: CURRENCY,
      lines: [{ productCode: 'PRD-0001', units: 2, unitPrice: 1_000 }],
      discount: 2_001, // exceeds the computed amount (2 × 1_000 = 2_000)
    });
    const discountCorrelationId = UniqueId.generate();
    const discountReply = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      excessiveDiscountPayload,
      headersOf(discountCorrelationId, UniqueId.generate()),
    );

    expect(discountReply).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await harness.invoicesOf(discountOrder)).toHaveLength(0);
    expect(await harness.ledgerOf(discountOrder)).toHaveLength(0);
    expect(await harness.outboxRowsFor(discountCorrelationId.value)).toHaveLength(0);

    const counterAfter = await harness.db.select().from(invoiceNumberSequences);
    expect(counterAfter).toEqual(counterBefore);
  });

  it('H4/BI6 — emits no fact of any type on every refusal path of billing.invoice.issue', async () => {
    const retailerCode = `RET-BI6-${shortId()}`;
    const companyCode = `COM-BI6-${shortId()}`;
    const creditId = await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });

    // BI3 — no credit line.
    const orderA = orderRef();
    const correlationA = UniqueId.generate();
    await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({ orderReference: orderA, retailerCode: 'NO-SUCH', companyCode: 'NO-SUCH', currency: CURRENCY, lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1_000 }] }),
      headersOf(correlationA, UniqueId.generate()),
    );

    // BI4 — currency mismatch.
    const orderB = orderRef();
    const correlationB = UniqueId.generate();
    await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({ orderReference: orderB, retailerCode, companyCode, currency: 'GBP', lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1_000 }] }),
      headersOf(correlationB, UniqueId.generate()),
    );

    // BI5 — no active hold.
    const orderC = orderRef();
    const correlationC = UniqueId.generate();
    await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({ orderReference: orderC, retailerCode, companyCode, currency: CURRENCY, lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 1_000 }] }),
      headersOf(correlationC, UniqueId.generate()),
    );

    // BI2 — malformed payload.
    const orderD = orderRef();
    const correlationD = UniqueId.generate();
    await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      { orderReference: orderD, retailerCode, companyCode, currency: CURRENCY, lines: [] },
      headersOf(correlationD, UniqueId.generate()),
    );

    const [rowsA, rowsB, rowsC, rowsD] = await Promise.all([
      harness.outboxRowsFor(correlationA.value),
      harness.outboxRowsFor(correlationB.value),
      harness.outboxRowsFor(correlationC.value),
      harness.outboxRowsFor(correlationD.value),
    ]);
    expect(rowsA).toHaveLength(0);
    expect(rowsB).toHaveLength(0);
    expect(rowsC).toHaveLength(0);
    expect(rowsD).toHaveLength(0);
    void creditId;
  });

  it('H5/BI9 — returns the existing reference with created false, writes no row and emits no second fact when re-issued for the same order, whether the invoice is issued or paid', async () => {
    const retailerCode = `RET-BI9-${shortId()}`;
    const companyCode = `COM-BI9-${shortId()}`;
    await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });

    // The ISSUED variant — a genuine issue, then a repeat.
    const orderReference = orderRef();
    await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      harness.holdRequest({ orderReference, retailerCode, companyCode, currency: CURRENCY, amount: 40_000 }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    const issuePayload = harness.issueRequest({
      orderReference,
      retailerCode,
      companyCode,
      currency: CURRENCY,
      lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 40_000 }],
    });
    const firstReply = await harness.requestBare<InvoiceIssueReplyPayload>(INVOICE_ISSUE_SUBJECT, issuePayload, headersOf(UniqueId.generate(), UniqueId.generate()));
    expect(firstReply).toMatchObject({ created: true });
    const firstInvoiceReference = (firstReply as InvoiceIssueReplyPayload).invoiceReference;

    const repeatCorrelationId = UniqueId.generate();
    const repeatReply = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      issuePayload,
      headersOf(repeatCorrelationId, UniqueId.generate()),
    );
    expect(repeatReply).toMatchObject({ created: false, invoiceReference: firstInvoiceReference, status: 'issued' });
    expect(await harness.invoicesOf(orderReference)).toHaveLength(1);
    expect(await harness.ledgerOf(orderReference)).toHaveLength(2); // hold + consume, no second consume.
    expect(await harness.outboxRowsFor(repeatCorrelationId.value)).toHaveLength(0);

    // The PAID variant — seeded directly (feature 22 has no responder).
    const paidOrder = orderRef();
    const paidInvoiceReference = invoiceRef();
    await harness.seedInvoice({
      orderReference: paidOrder,
      invoiceReference: paidInvoiceReference,
      retailerCode,
      companyCode,
      currencyCode: CURRENCY,
      amount: 15_000,
      discount: 0,
      totalAmount: 15_000,
      status: 'paid',
      paidAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    const paidCorrelationId = UniqueId.generate();
    const paidReply = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({
        orderReference: paidOrder,
        retailerCode,
        companyCode,
        currency: CURRENCY,
        lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: 15_000 }],
      }),
      headersOf(paidCorrelationId, UniqueId.generate()),
    );
    expect(paidReply).toMatchObject({ created: false, invoiceReference: paidInvoiceReference, status: 'paid' });
    expect(await harness.invoicesOf(paidOrder)).toHaveLength(1);
    expect(await harness.outboxRowsFor(paidCorrelationId.value)).toHaveLength(0);
  });
});
