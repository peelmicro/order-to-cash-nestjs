// `billing.payment.register` — R47, R48, R49 (feature 22). The real
// AppModule graph, real MySQL + NATS + Kafka. Synchronises only on
// terminal/monotonic evidence (design.md §10): the reply, then row counts
// and the outbox — never a transient status. A ROLLED-BACK side effect
// proves nothing about whether it was attempted (the N10 rule) — this file
// proves "nothing was written" at the DB level, which is exactly what an
// integration test CAN observe; the "nothing was even attempted" half of
// R49 is proven at the unit level (`payment-register.handler.spec.ts`).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { UniqueId } from '@otc/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditHoldReplyPayload, InvoiceIssueReplyPayload, PaymentRegisterReplyPayload, RpcError } from '@otc/contracts';
import { CREDIT_HOLD_SUBJECT } from './presentation/credit.controller';
import { INVOICE_ISSUE_SUBJECT, PAYMENT_REGISTER_SUBJECT } from './presentation/invoice.controller';
import { startBillingIntegrationHarness, type BillingIntegrationHarness } from './test-support/billing-integration-harness';
import { payments } from './infrastructure/persistence/schema';

const CURRENCY = 'EUR';
const HOLD_AMOUNT = 40_000;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`payment-register.integration: condition not met within ${timeoutMs}ms`);
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

interface IssuedFixture {
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly creditId: string;
  readonly orderReference: string;
  readonly invoiceReference: string;
  readonly invoiceId: string;
}

describe('billing.payment.register — R47, R48, R49 (Testcontainers: mysql:8.4.11 + nats:2.14.5-alpine + apache/kafka:4.3.1)', () => {
  let harness: BillingIntegrationHarness;

  beforeAll(async () => {
    harness = await startBillingIntegrationHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.teardown();
  }, 120_000);

  /** Hold + issue, via the real RPC responders — an `issued` invoice with an active hold fully consumed, exactly the state R47 requires. */
  async function issuedFixture(prefix: string): Promise<IssuedFixture> {
    const retailerCode = `RET-${prefix}-${shortId()}`;
    const companyCode = `COM-${prefix}-${shortId()}`;
    const creditId = await harness.seedCreditLine({ retailerCode, companyCode, creditLimit: 500_000, currencyCode: CURRENCY });
    const orderReference = orderRef();

    const holdReply = await harness.requestBare<CreditHoldReplyPayload>(
      CREDIT_HOLD_SUBJECT,
      harness.holdRequest({ orderReference, retailerCode, companyCode, currency: CURRENCY, amount: HOLD_AMOUNT }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(holdReply).toMatchObject({ outcome: 'approved' });

    const issueReply = await harness.requestBare<InvoiceIssueReplyPayload>(
      INVOICE_ISSUE_SUBJECT,
      harness.issueRequest({ orderReference, retailerCode, companyCode, currency: CURRENCY, lines: [{ productCode: 'PRD-0001', units: 1, unitPrice: HOLD_AMOUNT }] }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(issueReply).toMatchObject({ created: true, status: 'issued' });
    const invoiceReference = (issueReply as InvoiceIssueReplyPayload).invoiceReference;
    const invoiceId = (issueReply as InvoiceIssueReplyPayload).invoiceId;
    if (!invoiceId) {
      throw new Error('payment-register.integration: billing.invoice.issue replied without an invoiceId');
    }

    return { retailerCode, companyCode, creditId, orderReference, invoiceReference, invoiceId };
  }

  it('H1/R47 — records the payment, moves the invoice to paid with paidAt set, appends a release entry, and emits payment.received.v1 THEN credit.released.v1 in that order in the outbox, returning availableCredit to exactly where it started', async () => {
    const fixture = await issuedFixture('H1');
    const availableCreditBefore = 500_000 - (await harness.committedExposureOf(fixture.creditId));

    const correlationId = UniqueId.generate();
    const requestId = UniqueId.generate();
    const reply = await harness.requestBare<PaymentRegisterReplyPayload>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference: `PAY-${shortId()}`, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(correlationId, requestId),
    );

    expect(reply).toMatchObject({ outcome: 'accepted', invoiceReference: fixture.invoiceReference, orderReference: fixture.orderReference, invoiceStatus: 'paid' });
    const paidAt = (reply as PaymentRegisterReplyPayload).paidAt;
    expect(paidAt).toBeTruthy();

    const invoiceRows = await harness.invoicesOf(fixture.orderReference);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0]).toMatchObject({ status: 'paid' });
    expect(invoiceRows[0]!.paidAt).toBeInstanceOf(Date);

    const paymentRows = await harness.paymentsOf(fixture.invoiceId);
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]).toMatchObject({ amount: HOLD_AMOUNT, currencyCode: CURRENCY });

    const ledgerRows = await harness.ledgerOf(fixture.orderReference);
    const releaseRows = ledgerRows.filter((row) => row.type === 'release');
    expect(releaseRows).toHaveLength(1);
    expect(releaseRows[0]).toMatchObject({ amount: HOLD_AMOUNT });

    // The ledger identity: exposure = hold - release = 0, so
    // availableCredit returns to EXACTLY where it started before the hold.
    const availableCreditAfter = 500_000 - (await harness.committedExposureOf(fixture.creditId));
    expect(availableCreditAfter).toBe(500_000);
    expect(availableCreditAfter).toBeGreaterThan(availableCreditBefore);

    await waitFor(async () => {
      const rows = await harness.outboxRowsFor(correlationId.value);
      return rows.length === 2 && rows.every((row) => row.publishedAt !== null);
    });
    const outboxRows = (await harness.outboxRowsFor(correlationId.value)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.map((row) => row.eventType)).toEqual(['payment.received.v1', 'credit.released.v1']);
    expect(outboxRows[0]).toMatchObject({ correlationId: correlationId.value, causationId: requestId.value });
    // Amendment A1 (open point 2, progress/spec_projector_timeline_ordering.md)
    // — `credit.released.v1`'s `causationId` is `payment.received.v1`'s
    // OWN `eventId`, NOT `cmd.requestId`. Before this change both facts
    // carried the SAME `causationId` (`requestId.value`) and the
    // projector's causal-edge timeline rule (PR10) saw siblings, not a
    // chain, and could not order them; this assertion is the live proof
    // the edge is real in the outbox, not just in the domain layer. Fails
    // if the handler reverts to reusing `ctx.causationId` for the release.
    expect(outboxRows[1]!.causationId).toBe(outboxRows[0]!.eventId);
    expect(outboxRows[1]!.causationId).not.toBe(requestId.value);
    expect(outboxRows[1]).toMatchObject({ correlationId: correlationId.value });
  });

  it('R48 — a sequential repeat of the SAME paymentReference returns the original outcome, records no second payment and emits no second fact', async () => {
    const fixture = await issuedFixture('R48SEQ');
    const paymentReference = `PAY-${shortId()}`;

    const firstReply = await harness.requestBare<PaymentRegisterReplyPayload>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(firstReply).toMatchObject({ outcome: 'accepted' });
    // The reply's `paidAt` is built from the in-memory `Date` at accept
    // time (millisecond precision); `invoices.paid_at` is a MySQL
    // `datetime` column with NO fractional-second precision (the
    // `credit_hold.spec`/harness's own `Math.floor(Date.now() / 1000) *
    // 1000` seeding convention documents the same truncation elsewhere in
    // this schema). The persisted, ROUND-TRIPPED value — not the
    // in-memory reply — is the "original outcome" R48 promises a repeat.
    const persistedPaidAt = (await harness.invoicesOf(fixture.orderReference))[0]!.paidAt!.toISOString();

    const repeatCorrelationId = UniqueId.generate();
    const repeatReply = await harness.requestBare<PaymentRegisterReplyPayload>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(repeatCorrelationId, UniqueId.generate()),
    );

    expect(repeatReply).toMatchObject({
      outcome: 'duplicate',
      invoiceReference: fixture.invoiceReference,
      orderReference: fixture.orderReference,
      invoiceStatus: 'paid',
      paidAt: persistedPaidAt,
    });
    expect(await harness.paymentsOf(fixture.invoiceId)).toHaveLength(1);
    expect((await harness.ledgerOf(fixture.orderReference)).filter((row) => row.type === 'release')).toHaveLength(1);
    expect(await harness.outboxRowsFor(repeatCorrelationId.value)).toHaveLength(0);
  });

  it('R48 — two concurrent requests with the SAME paymentReference produce exactly one payment row and exactly one fact pair, with no deadlock', async () => {
    const fixture = await issuedFixture('R48RACE');
    const paymentReference = `PAY-${shortId()}`;
    const correlationA = UniqueId.generate();
    const correlationB = UniqueId.generate();
    const payload = harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference, amount: HOLD_AMOUNT, currency: CURRENCY });

    const [replyA, replyB] = await Promise.all([
      harness.requestBare<PaymentRegisterReplyPayload>(PAYMENT_REGISTER_SUBJECT, payload, headersOf(correlationA, UniqueId.generate())),
      harness.requestBare<PaymentRegisterReplyPayload>(PAYMENT_REGISTER_SUBJECT, payload, headersOf(correlationB, UniqueId.generate())),
    ]);

    const outcomes = [replyA, replyB].map((reply) => (reply as PaymentRegisterReplyPayload).outcome).sort();
    expect(outcomes).toEqual(['accepted', 'duplicate']);

    expect(await harness.paymentsOf(fixture.invoiceId)).toHaveLength(1);
    expect((await harness.ledgerOf(fixture.orderReference)).filter((row) => row.type === 'release')).toHaveLength(1);

    await waitFor(async () => {
      const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
      const total = rowsA.length + rowsB.length;
      return total === 2 && [...rowsA, ...rowsB].every((row) => row.publishedAt !== null);
    });
    const [rowsA, rowsB] = await Promise.all([harness.outboxRowsFor(correlationA.value), harness.outboxRowsFor(correlationB.value)]);
    const allRows = [...rowsA, ...rowsB].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    expect(allRows).toHaveLength(2);
    expect(allRows.map((row) => row.eventType)).toEqual(['payment.received.v1', 'credit.released.v1']);
  });

  it('R49 — an amount mismatch is rejected with PRECONDITION_FAILED, leaving the invoice issued and the credit ledger unchanged, emitting no fact', async () => {
    const fixture = await issuedFixture('R49AMT');
    const ledgerBefore = await harness.ledgerOf(fixture.orderReference);
    const correlationId = UniqueId.generate();

    const reply = await harness.requestBare<RpcError>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference: `PAY-${shortId()}`, amount: HOLD_AMOUNT + 1, currency: CURRENCY }),
      headersOf(correlationId, UniqueId.generate()),
    );

    expect(reply).toMatchObject({ code: 'PRECONDITION_FAILED', details: { code: 'INVOICE_PAYMENT_AMOUNT_MISMATCH' } });
    const invoiceRows = await harness.invoicesOf(fixture.orderReference);
    expect(invoiceRows[0]).toMatchObject({ status: 'issued', paidAt: null });
    expect(await harness.paymentsOf(fixture.invoiceId)).toHaveLength(0);
    expect(await harness.ledgerOf(fixture.orderReference)).toEqual(ledgerBefore);
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
  });

  it('R49 — a currency mismatch is rejected with PRECONDITION_FAILED, leaving the invoice issued and the credit ledger unchanged, emitting no fact', async () => {
    const fixture = await issuedFixture('R49CCY');
    const ledgerBefore = await harness.ledgerOf(fixture.orderReference);
    const correlationId = UniqueId.generate();

    const reply = await harness.requestBare<RpcError>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference: `PAY-${shortId()}`, amount: HOLD_AMOUNT, currency: 'GBP' }),
      headersOf(correlationId, UniqueId.generate()),
    );

    expect(reply).toMatchObject({ code: 'PRECONDITION_FAILED', details: { code: 'INVOICE_PAYMENT_CURRENCY_MISMATCH' } });
    const invoiceRows = await harness.invoicesOf(fixture.orderReference);
    expect(invoiceRows[0]).toMatchObject({ status: 'issued', paidAt: null });
    expect(await harness.paymentsOf(fixture.invoiceId)).toHaveLength(0);
    expect(await harness.ledgerOf(fixture.orderReference)).toEqual(ledgerBefore);
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
  });

  it('R49 — a DIFFERENT paymentReference against an already-paid invoice is rejected with PRECONDITION_FAILED, leaving the invoice and the credit ledger unchanged, emitting no fact', async () => {
    const fixture = await issuedFixture('R49PAID');
    const firstReply = await harness.requestBare<PaymentRegisterReplyPayload>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference: `PAY-ORIGINAL-${shortId()}`, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(firstReply).toMatchObject({ outcome: 'accepted' });
    const ledgerBefore = await harness.ledgerOf(fixture.orderReference);
    const paidRowBefore = (await harness.invoicesOf(fixture.orderReference))[0]!;
    const correlationId = UniqueId.generate();

    const reply = await harness.requestBare<RpcError>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference: `PAY-DIFFERENT-${shortId()}`, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(correlationId, UniqueId.generate()),
    );

    expect(reply).toMatchObject({ code: 'PRECONDITION_FAILED', details: { code: 'INVOICE_ALREADY_PAID' } });
    const invoiceRows = await harness.invoicesOf(fixture.orderReference);
    expect(invoiceRows[0]).toEqual(paidRowBefore);
    expect(await harness.paymentsOf(fixture.invoiceId)).toHaveLength(1); // still just the original.
    expect(await harness.ledgerOf(fixture.orderReference)).toEqual(ledgerBefore); // no second release.
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
  });

  it('replies NOT_FOUND naming the identity and writes nothing for an invoiceReference that resolves to no invoice', async () => {
    const correlationId = UniqueId.generate();

    const reply = await harness.requestBare<RpcError>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: 'INV-999999', paymentReference: `PAY-${shortId()}`, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(correlationId, UniqueId.generate()),
    );

    expect(reply).toMatchObject({ code: 'NOT_FOUND', details: { code: 'INVOICE_NOT_FOUND' } });
    expect(await harness.outboxRowsFor(correlationId.value)).toHaveLength(0);
  });

  it('answers VALIDATION_FAILED and dispatches nothing when headers or the payload are invalid', async () => {
    const fixture = await issuedFixture('WIRE');
    const validPayload = harness.paymentRequest({ invoiceReference: fixture.invoiceReference, paymentReference: `PAY-${shortId()}`, amount: HOLD_AMOUNT, currency: CURRENCY });

    const noHeaders = await harness.requestBare<RpcError>(PAYMENT_REGISTER_SUBJECT, validPayload);
    expect(noHeaders).toMatchObject({ code: 'VALIDATION_FAILED' });

    const noIdentity = await harness.requestBare<RpcError>(
      PAYMENT_REGISTER_SUBJECT,
      { ...validPayload, invoiceReference: undefined },
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(noIdentity).toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await harness.paymentsOf(fixture.invoiceId)).toHaveLength(0);
  });

  it('the belt-and-braces backstop: the SAME paymentReference reused across two DIFFERENT invoices is caught by the payments.payment_reference UNIQUE constraint, leaving exactly one payment committed', async () => {
    const fixtureA = await issuedFixture('CONFA');
    const fixtureB = await issuedFixture('CONFB');
    const paymentReference = `PAY-CONFLICT-${shortId()}`;

    const [replyA, replyB] = await Promise.all([
      harness.requestBare<PaymentRegisterReplyPayload | RpcError>(
        PAYMENT_REGISTER_SUBJECT,
        harness.paymentRequest({ invoiceReference: fixtureA.invoiceReference, paymentReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
        headersOf(UniqueId.generate(), UniqueId.generate()),
      ),
      harness.requestBare<PaymentRegisterReplyPayload | RpcError>(
        PAYMENT_REGISTER_SUBJECT,
        harness.paymentRequest({ invoiceReference: fixtureB.invoiceReference, paymentReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
        headersOf(UniqueId.generate(), UniqueId.generate()),
      ),
    ]);

    // Exactly one of the two invoices ends up with a committed payment row
    // carrying this paymentReference — the OTHER answers CONFLICT,
    // whether it lost the DB constraint race outright or (N11, fixed)
    // saw the winner already committed through its OWN fast-path
    // comparison first: since that comparison now checks the invoice
    // identity too, a duplicate-shaped success for a genuinely different
    // invoice is no longer reachable by either route. What matters, and
    // what this test asserts, is the database-level invariant the UNIQUE
    // constraint guarantees:
    const rows = await harness.db.select().from(payments).where(eq(payments.paymentReference, paymentReference));
    expect(rows).toHaveLength(1);

    const outcomes = [replyA, replyB].map((reply) => ('outcome' in reply ? reply.outcome : (reply as RpcError).code));
    expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1);
    // N11 — the loser is CONFLICT specifically, never a success-shaped
    // 'duplicate' naming the wrong invoice.
    expect(outcomes.filter((outcome) => outcome === 'CONFLICT')).toHaveLength(1);
  });

  // N11 (review_billing_remittance_intake.md) — the finding was that the
  // SAME condition (one paymentReference, two DIFFERENT invoices) answered
  // two DIFFERENT ways depending purely on whether the two requests raced
  // or were sequenced: a success-shaped 'duplicate' naming the wrong
  // invoice when sequential, a CONFLICT RpcError when concurrent. This
  // test drives BOTH forms of the identical condition and asserts they
  // now produce the SAME answer — the property that was missing, not
  // merely that the sequential form happens to return CONFLICT.
  it('N11 — the sequential and concurrent forms of the SAME cross-invoice paymentReference reuse return the SAME CONFLICT answer', async () => {
    // Sequential: the second request is awaited only after the first has
    // FULLY committed — no race, no window, a plain repeat that happens
    // to name a different invoice.
    const fixtureSeqA = await issuedFixture('SEQA');
    const fixtureSeqB = await issuedFixture('SEQB');
    const sequentialReference = `PAY-SEQ-${shortId()}`;

    const sequentialWinner = await harness.requestBare<PaymentRegisterReplyPayload>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixtureSeqA.invoiceReference, paymentReference: sequentialReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(sequentialWinner).toMatchObject({ outcome: 'accepted' });

    const sequentialLoser = await harness.requestBare<RpcError>(
      PAYMENT_REGISTER_SUBJECT,
      harness.paymentRequest({ invoiceReference: fixtureSeqB.invoiceReference, paymentReference: sequentialReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
      headersOf(UniqueId.generate(), UniqueId.generate()),
    );
    expect(sequentialLoser).toMatchObject({ code: 'CONFLICT', details: { code: 'PAYMENT_REFERENCE_CONFLICT' } });
    // The fast path refused before opening a transaction — invoice B is
    // untouched, not merely "rolled back".
    expect((await harness.invoicesOf(fixtureSeqB.orderReference))[0]).toMatchObject({ status: 'issued', paidAt: null });
    expect(await harness.paymentsOf(fixtureSeqB.invoiceId)).toHaveLength(0);

    // Concurrent: the IDENTICAL logical condition, raced instead of
    // sequenced.
    const fixtureConcA = await issuedFixture('CONCA');
    const fixtureConcB = await issuedFixture('CONCB');
    const concurrentReference = `PAY-CONC-${shortId()}`;

    const [replyC, replyD] = await Promise.all([
      harness.requestBare<PaymentRegisterReplyPayload | RpcError>(
        PAYMENT_REGISTER_SUBJECT,
        harness.paymentRequest({ invoiceReference: fixtureConcA.invoiceReference, paymentReference: concurrentReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
        headersOf(UniqueId.generate(), UniqueId.generate()),
      ),
      harness.requestBare<PaymentRegisterReplyPayload | RpcError>(
        PAYMENT_REGISTER_SUBJECT,
        harness.paymentRequest({ invoiceReference: fixtureConcB.invoiceReference, paymentReference: concurrentReference, amount: HOLD_AMOUNT, currency: CURRENCY }),
        headersOf(UniqueId.generate(), UniqueId.generate()),
      ),
    ]);
    const concurrentReplies = [replyC, replyD];
    const concurrentLoser = concurrentReplies.find((reply) => !('outcome' in reply) || reply.outcome !== 'accepted') as RpcError | undefined;
    const concurrentWinnerCount = concurrentReplies.filter((reply) => 'outcome' in reply && reply.outcome === 'accepted').length;
    expect(concurrentWinnerCount).toBe(1);
    expect(concurrentLoser).toBeDefined();

    // THE EQUIVALENCE PROPERTY (N11): the sequential loser and the
    // concurrent loser carry the SAME code and the SAME details.code for
    // the SAME logical condition.
    expect(concurrentLoser!.code).toBe(sequentialLoser.code);
    expect((concurrentLoser!.details as { code?: string } | undefined)?.code).toBe((sequentialLoser.details as { code?: string } | undefined)?.code);
  });
});
