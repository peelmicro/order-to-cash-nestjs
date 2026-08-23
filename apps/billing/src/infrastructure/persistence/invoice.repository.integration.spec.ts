// Testcontainers integration — real MySQL (mysql:8.4.11). `BI7` — commits
// the invoice, its lines, the consume ledger entry and the outbox record
// together, and leaves none of them behind when the transaction rolls
// back. Drives BOTH aggregates through one real `UnitOfWork` — the §5.6
// two-aggregate transaction this feature's issue handler performs.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceReference, Money, OrderNumber, Quantity, UniqueId } from '@otc/shared-kernel';
import type { HoldRequest } from '../../domain/buyer-credit.js';
import { Invoice, type InvoiceContext, type IssueInvoiceInput } from '../../domain/invoice.js';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { DrizzleBuyerCreditRepository } from './buyer-credit.repository';
import { DrizzleInvoiceRepository } from './invoice.repository';
import { creditItems, credits, invoiceItems, invoices, outbox } from './schema';
import { startBillingTestFixture, type BillingTestFixture } from './test-support/billing-test-fixture';

const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };
const CURRENCY = 'EUR';

function ctx(): InvoiceContext {
  return { occurredAt: fixedClock.now(), causationId: UniqueId.generate() };
}

async function seedCreditLine(
  fixture: BillingTestFixture,
  overrides: { creditLimit?: number; retailerCode?: string; companyCode?: string; code?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const now = fixedClock.now();
  await fixture.db.insert(credits).values({
    id,
    code: overrides.code ?? `CR-${String(Math.floor(Math.random() * 900_000) + 100_000)}`,
    retailerCode: overrides.retailerCode ?? 'RET-0001',
    companyCode: overrides.companyCode ?? 'COM-0001',
    creditLimit: overrides.creditLimit ?? 500_000,
    currencyCode: CURRENCY,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function issueInputFor(orderReference: OrderNumber, invoiceReference: InvoiceReference): IssueInvoiceInput {
  return {
    id: UniqueId.generate(),
    invoiceReference,
    invoiceDate: fixedClock.now(),
    orderReference,
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    currency: CURRENCY,
    lines: [{ productCode: 'PRD-0001', units: Quantity.of(2), unitPrice: Money.of(1_000, CURRENCY) }],
    discount: Money.zero(CURRENCY),
    correlationId: UniqueId.generate(),
  };
}

describe('DrizzleInvoiceRepository — BI7 (Testcontainers: mysql:8.4.11)', () => {
  let fixture: BillingTestFixture;
  let invoiceRepository: DrizzleInvoiceRepository;
  let creditRepository: DrizzleBuyerCreditRepository;
  let unitOfWork: DrizzleUnitOfWork;

  beforeAll(async () => {
    fixture = await startBillingTestFixture();
    invoiceRepository = new DrizzleInvoiceRepository(fixture.db, fixedClock);
    creditRepository = new DrizzleBuyerCreditRepository(fixture.db, fixedClock);
    unitOfWork = new DrizzleUnitOfWork(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.db.delete(outbox);
    await fixture.db.delete(invoiceItems);
    await fixture.db.delete(invoices);
    await fixture.db.delete(creditItems);
    await fixture.db.delete(credits);
  });

  it('commits the invoice, its lines, the consume ledger entry and the outbox record together, and leaves none of them behind when the transaction rolls back', async () => {
    const retailerCode = 'RET-BI7-ROLLBACK';
    const companyCode = 'COM-BI7-ROLLBACK';
    await seedCreditLine(fixture, { retailerCode, companyCode });
    const orderReference = OrderNumber.fromSequence(1);

    // Seed an active hold for the order via a real credit-hold write, so
    // the rollback attempt below drives a GENUINE consumeHold.
    await unitOfWork.execute(async (tx) => {
      const credit = await creditRepository.lockForOrder(tx, retailerCode, companyCode, orderReference);
      const request: HoldRequest = { orderReference, amount: Money.of(2_000, CURRENCY), correlationId: UniqueId.generate() };
      credit!.approveHold(request, ctx(), () => UniqueId.generate());
      await creditRepository.save(credit!, tx);
    });

    // The outbox row count BEFORE the issue transaction — the hold placed
    // above already legitimately wrote one (credit.approved.v1), so the
    // guard below is a DELTA, not a whole-table count.
    const outboxCountBeforeIssue = (await fixture.db.select().from(outbox)).length;

    // Committed happy path first — both aggregates, one transaction.
    await unitOfWork.execute(async (tx) => {
      const credit = await creditRepository.lockForOrder(tx, retailerCode, companyCode, orderReference);
      const invoice = Invoice.issue(issueInputFor(orderReference, InvoiceReference.fromSequence(1)), ctx());
      credit!.consumeHold({ orderReference }, ctx(), () => UniqueId.generate());
      await invoiceRepository.save(invoice, tx);
      await creditRepository.save(credit!, tx);
    });

    const invoiceRows = await fixture.db.select().from(invoices).where(eq(invoices.orderReference, orderReference.value));
    expect(invoiceRows).toHaveLength(1);
    const itemRows = await fixture.db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceRows[0]!.id));
    expect(itemRows).toHaveLength(1);
    const consumeRows = await fixture.db.select().from(creditItems).where(eq(creditItems.orderReference, orderReference.value));
    expect(consumeRows.filter((row) => row.type === 'consume')).toHaveLength(1);
    const outboxRows = await fixture.db.select().from(outbox).where(eq(outbox.aggregateId, invoiceRows[0]!.id));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({ eventType: 'invoice.issued.v1' });
    // The DELTA, unfiltered by aggregateId or eventType — this is the
    // assertion the H10 armed-deletion test (progress/impl_billing_invoicing.md)
    // actually breaks: R40's `consume` deliberately emits NOTHING, so the
    // issue transaction must add EXACTLY one outbox row in total, from
    // EITHER aggregate, not just exactly one keyed to the invoice.
    const outboxCountAfterIssue = (await fixture.db.select().from(outbox)).length;
    expect(outboxCountAfterIssue - outboxCountBeforeIssue).toBe(1);

    // Now a SECOND order, forced to roll back after both `save` calls —
    // the counts above must stay exactly as they are; nothing from this
    // attempt survives.
    const secondOrder = OrderNumber.fromSequence(2);
    await unitOfWork.execute(async (tx) => {
      const credit = await creditRepository.lockForOrder(tx, retailerCode, companyCode, secondOrder);
      const request: HoldRequest = { orderReference: secondOrder, amount: Money.of(1_500, CURRENCY), correlationId: UniqueId.generate() };
      credit!.approveHold(request, ctx(), () => UniqueId.generate());
      await creditRepository.save(credit!, tx);
    });

    await expect(
      unitOfWork.execute(async (tx) => {
        const credit = await creditRepository.lockForOrder(tx, retailerCode, companyCode, secondOrder);
        const invoice = Invoice.issue(issueInputFor(secondOrder, InvoiceReference.fromSequence(2)), ctx());
        credit!.consumeHold({ orderReference: secondOrder }, ctx(), () => UniqueId.generate());
        await invoiceRepository.save(invoice, tx);
        await creditRepository.save(credit!, tx);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const secondInvoiceRows = await fixture.db.select().from(invoices).where(eq(invoices.orderReference, secondOrder.value));
    expect(secondInvoiceRows).toHaveLength(0);
    const secondConsumeRows = await fixture.db
      .select()
      .from(creditItems)
      .where(eq(creditItems.orderReference, secondOrder.value));
    expect(secondConsumeRows.filter((row) => row.type === 'consume')).toHaveLength(0);
    const secondOutboxRows = await fixture.db
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'invoice.issued.v1'));
    expect(secondOutboxRows).toHaveLength(1); // only the FIRST order's — unchanged.

    // The FIRST order's rows are still exactly as they were — the
    // rollback of the second attempt touched nothing that already
    // committed.
    const invoiceRowsAfter = await fixture.db.select().from(invoices).where(eq(invoices.orderReference, orderReference.value));
    expect(invoiceRowsAfter).toHaveLength(1);
  });

  it('findByOrderReference (the B7 fast path) round-trips a committed invoice with no lock and no transaction', async () => {
    const retailerCode = 'RET-BI7-FASTPATH';
    const companyCode = 'COM-BI7-FASTPATH';
    await seedCreditLine(fixture, { retailerCode, companyCode });
    const orderReference = OrderNumber.fromSequence(10);

    await unitOfWork.execute(async (tx) => {
      const credit = await creditRepository.lockForOrder(tx, retailerCode, companyCode, orderReference);
      const request: HoldRequest = { orderReference, amount: Money.of(2_000, CURRENCY), correlationId: UniqueId.generate() };
      credit!.approveHold(request, ctx(), () => UniqueId.generate());
      await creditRepository.save(credit!, tx);
    });
    await unitOfWork.execute(async (tx) => {
      const credit = await creditRepository.lockForOrder(tx, retailerCode, companyCode, orderReference);
      const invoice = Invoice.issue(issueInputFor(orderReference, InvoiceReference.fromSequence(10)), ctx());
      credit!.consumeHold({ orderReference }, ctx(), () => UniqueId.generate());
      await invoiceRepository.save(invoice, tx);
      await creditRepository.save(credit!, tx);
    });

    const found = await invoiceRepository.findByOrderReference(orderReference);
    expect(found).not.toBeNull();
    expect(found!.invoiceReference.value).toBe('INV-000010');
    expect(found!.lines).toHaveLength(1);

    const notFound = await invoiceRepository.findByOrderReference(OrderNumber.fromSequence(999_999));
    expect(notFound).toBeNull();
  });
});
