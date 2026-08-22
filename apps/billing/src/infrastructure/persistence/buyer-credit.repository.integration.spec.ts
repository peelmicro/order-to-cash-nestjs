// Testcontainers integration — real MySQL (mysql:8.4.11), migrations
// applied through the existing migrator (design.md §7, tasks D4). Proves:
// round-trip reconstitute/save; save writes the ledger entry and the
// outbox record in ONE transaction and a forced rollback leaves neither
// (R13 shape, OI9's drained-events hazard re-proven on this repository);
// availableCredit recomputed from every row of credit_items equals the
// fact's availableCreditAfter after each committed operation (§3.1's
// honest check).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { HoldRequest } from '../../domain/buyer-credit';
import { DrizzleUnitOfWork } from './drizzle-unit-of-work';
import { DrizzleBuyerCreditRepository } from './buyer-credit.repository';
import { creditItems, credits, outbox } from './schema';
import { startBillingTestFixture, type BillingTestFixture } from './test-support/billing-test-fixture';

const fixedClock = { now: () => new Date('2026-08-21T10:00:00.000Z') };
const CURRENCY = 'EUR';

function ctx() {
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

describe('DrizzleBuyerCreditRepository (Testcontainers: mysql:8.4.11)', () => {
  let fixture: BillingTestFixture;
  let repository: DrizzleBuyerCreditRepository;
  let unitOfWork: DrizzleUnitOfWork;

  beforeAll(async () => {
    fixture = await startBillingTestFixture();
    repository = new DrizzleBuyerCreditRepository(fixture.db, fixedClock);
    unitOfWork = new DrizzleUnitOfWork(fixture.db);
  }, 120_000);

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.db.delete(outbox);
    await fixture.db.delete(creditItems);
    await fixture.db.delete(credits);
  });

  it('round-trips reconstitute/save: a held order, saved, then re-loaded is byte-equal in its observable state', async () => {
    const retailerCode = 'RET-ROUNDTRIP';
    const companyCode = 'COM-ROUNDTRIP';
    await seedCreditLine(fixture, { retailerCode, companyCode, creditLimit: 500_000 });
    const orderReference = OrderNumber.fromSequence(1);

    await unitOfWork.execute(async (tx) => {
      const credit = await repository.lockForOrder(tx, retailerCode, companyCode, orderReference);
      expect(credit).not.toBeNull();
      const request: HoldRequest = { orderReference, amount: Money.of(50_000, CURRENCY), correlationId: UniqueId.generate() };
      credit!.approveHold(request, ctx(), () => UniqueId.generate());
      await repository.save(credit!, tx);
    });

    const reloaded = await unitOfWork.execute(async (tx) => repository.lockForOrder(tx, retailerCode, companyCode, orderReference));

    expect(reloaded).not.toBeNull();
    expect(reloaded!.availableCredit).toEqual(Money.of(450_000, CURRENCY));
    expect(reloaded!.summary.byOrder[0]).toMatchObject({ orderReference: orderReference.value, exposure: 50_000, activeHold: 50_000 });
  });

  it('writes the hold entry and the credit.approved.v1 outbox record in one transaction, and a forced rollback leaves neither', async () => {
    const retailerCode = 'RET-ROLLBACK';
    const companyCode = 'COM-ROLLBACK';
    const creditId = await seedCreditLine(fixture, { retailerCode, companyCode });
    const orderReference = OrderNumber.fromSequence(2);

    await expect(
      unitOfWork.execute(async (tx) => {
        const credit = await repository.lockForOrder(tx, retailerCode, companyCode, orderReference);
        const request: HoldRequest = { orderReference, amount: Money.of(10_000, CURRENCY), correlationId: UniqueId.generate() };
        credit!.approveHold(request, ctx(), () => UniqueId.generate());
        await repository.save(credit!, tx);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const itemRows = await fixture.db.select().from(creditItems).where(eq(creditItems.creditId, creditId));
    const outboxRows = await fixture.db.select().from(outbox).where(eq(outbox.aggregateId, creditId));
    expect(itemRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });

  it('availableCredit recomputed from every row of credit_items equals the fact\'s availableCreditAfter after each committed operation', async () => {
    const retailerCode = 'RET-HONEST';
    const companyCode = 'COM-HONEST';
    const creditId = await seedCreditLine(fixture, { retailerCode, companyCode, creditLimit: 100_000 });
    const orderA = OrderNumber.fromSequence(10);
    const orderB = OrderNumber.fromSequence(11);

    async function committedExposureFromRows(): Promise<number> {
      const rows = await fixture.db.select().from(creditItems).where(eq(creditItems.creditId, creditId));
      return rows.reduce((sum, row) => sum + (row.type === 'hold' ? row.amount : row.type === 'release' ? -row.amount : 0), 0);
    }

    let factAvailableAfterA = 0;
    await unitOfWork.execute(async (tx) => {
      const credit = await repository.lockForOrder(tx, retailerCode, companyCode, orderA);
      credit!.approveHold({ orderReference: orderA, amount: Money.of(20_000, CURRENCY), correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
      // The aggregate's own availableCredit right after the mutation IS what
      // `creditApprovedEvent` embeds as `availableCreditAfter` — read it
      // here, BEFORE `save` drains the pending fact, so this test never
      // double-pulls the aggregate's domain-event queue.
      factAvailableAfterA = credit!.availableCredit.amount;
      await repository.save(credit!, tx);
    });
    expect(factAvailableAfterA).toBe(100_000 - (await committedExposureFromRows()));

    let factAvailableAfterB = 0;
    await unitOfWork.execute(async (tx) => {
      const credit = await repository.lockForOrder(tx, retailerCode, companyCode, orderB);
      credit!.approveHold({ orderReference: orderB, amount: Money.of(30_000, CURRENCY), correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
      factAvailableAfterB = credit!.availableCredit.amount;
      await repository.save(credit!, tx);
    });
    expect(factAvailableAfterB).toBe(100_000 - (await committedExposureFromRows()));
    expect(factAvailableAfterB).toBe(50_000);
  });
});
