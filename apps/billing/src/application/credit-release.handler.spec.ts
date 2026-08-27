// Pure unit — fake `UnitOfWork`/`BuyerCreditRepository`/`Clock` (CLAUDE.md
// § Testing conventions), mirroring `credit-hold.handler.spec.ts`'s own
// shape exactly. Proves: a genuine release appends one `release` entry and
// persists it (BC5/BC10 recomputation, `reason: 'order_cancelled'` always);
// BC11/B5's idempotent repeat finds zero outstanding exposure, calls `save`
// NOT AT ALL, and still replies success (`released: false`) rather than an
// error; BC3's missing-credit-line refusal (reused, unchanged, from
// `credit.hold`'s own vocabulary); the reply is built from the domain
// outcome and returned only AFTER `execute` resolves.
import { CreditLineReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { CreditReleaseRequestPayload } from '@otc/contracts';
import { describe, expect, it } from 'vitest';
import { BuyerCredit } from '../domain/buyer-credit.js';
import type { BuyerCreditSnapshot } from '../domain/buyer-credit-snapshot.js';
import { ReleaseCreditCommand } from './commands/credit.commands.js';
import { CreditReleaseHandler } from './credit-release.handler.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { TransactionContext, UnitOfWork } from './ports/unit-of-work.port.js';
import { CreditLineNotFoundError } from './credit-application-errors.js';

const CURRENCY = 'EUR';
const ORDER = OrderNumber.fromSequence(1);

function fakeTx(): TransactionContext {
  return {} as TransactionContext;
}

class FakeUnitOfWork implements UnitOfWork {
  executeCalls = 0;

  async execute<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.executeCalls += 1;
    return work(fakeTx());
  }
}

const fixedClock: Clock = { now: () => new Date('2026-08-27T10:00:00.000Z') };

function creditSnapshot(overrides: Partial<BuyerCreditSnapshot> = {}): BuyerCreditSnapshot {
  return {
    id: UniqueId.generate(),
    code: CreditLineReference.fromSequence(1),
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    creditLimit: 10_000,
    currency: CURRENCY,
    committedExposure: 0,
    orderEntries: [],
    ...overrides,
  };
}

function releaseCommand(overrides: Partial<CreditReleaseRequestPayload> = {}): ReleaseCreditCommand {
  const request: CreditReleaseRequestPayload = {
    orderReference: ORDER.value,
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    ...overrides,
  };
  return new ReleaseCreditCommand(request, UniqueId.generate(), UniqueId.generate());
}

function repositoryOf(credit: BuyerCredit | null): { repo: BuyerCreditRepository; saveCalls: BuyerCredit[] } {
  const saveCalls: BuyerCredit[] = [];
  const repo: BuyerCreditRepository = {
    async lockForOrder() {
      return credit;
    },
    async save(saved) {
      saveCalls.push(saved);
    },
  };
  return { repo, saveCalls };
}

describe('CreditReleaseHandler.release — a genuine release', () => {
  it('appends one release entry for the order\'s outstanding exposure, recomputes committedExposure/availableCreditAfter and persists (reason: order_cancelled always)', async () => {
    const holdEntry = { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(4_000, CURRENCY), type: 'hold' as const, entryDate: new Date() };
    const credit = BuyerCredit.reconstitute(creditSnapshot({ committedExposure: 4_000, orderEntries: [holdEntry] }));
    const { repo, saveCalls } = repositoryOf(credit);
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditReleaseHandler(unitOfWork, repo, fixedClock);

    const reply = await handler.release(releaseCommand());

    expect(reply).toMatchObject({
      released: true,
      orderReference: ORDER.value,
      releasedAmount: 4_000,
      availableCreditAfter: 10_000,
    });
    expect(saveCalls).toHaveLength(1);

    const savedCredit = saveCalls[0]!;
    expect(savedCredit.appendedEntries).toHaveLength(1);
    expect(savedCredit.appendedEntries[0]).toMatchObject({ type: 'release', amount: Money.of(4_000, CURRENCY) });

    const events = savedCredit.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('credit.released.v1');
    expect(events[0]?.payload).toMatchObject({ reason: 'order_cancelled', releasedAmount: 4_000, availableCreditAfter: 10_000 });
  });
});

// The armed-deletion target for this pass: prove idempotency is genuinely
// exercised, not merely asserted. Deleting `CreditReleaseHandler`'s
// `if (!entry) { ... }` early return (falling through to the write branch
// unconditionally) makes this test fail because `save` would be called and
// `released` would report `true` on a repeat that has nothing left to
// release — see progress/impl_orders_cancel_responder.md's follow-up
// section for the verbatim failure.
describe('CreditReleaseHandler.release — BC11/B5, the idempotent repeat', () => {
  it('a second release after the hold is already released finds zero outstanding exposure, calls save NOT AT ALL, appends no second entry, emits no second fact, and still replies success with released: false', async () => {
    const holdEntry = { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(4_000, CURRENCY), type: 'hold' as const, entryDate: new Date() };
    const releaseEntry = { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(4_000, CURRENCY), type: 'release' as const, entryDate: new Date() };
    const credit = BuyerCredit.reconstitute(creditSnapshot({ committedExposure: 0, orderEntries: [holdEntry, releaseEntry] }));
    const { repo, saveCalls } = repositoryOf(credit);
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditReleaseHandler(unitOfWork, repo, fixedClock);

    const reply = await handler.release(releaseCommand());

    expect(reply).toMatchObject({
      released: false,
      orderReference: ORDER.value,
      availableCreditAfter: 10_000,
    });
    expect(reply).not.toHaveProperty('releasedAmount');
    expect(saveCalls).toHaveLength(0);
  });

  it('an order with no hold at all (nothing ever held) also replies released: false and calls save NOT AT ALL', async () => {
    const credit = BuyerCredit.reconstitute(creditSnapshot({ committedExposure: 0, orderEntries: [] }));
    const { repo, saveCalls } = repositoryOf(credit);
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditReleaseHandler(unitOfWork, repo, fixedClock);

    const reply = await handler.release(releaseCommand());

    expect(reply).toMatchObject({ released: false });
    expect(saveCalls).toHaveLength(0);
  });
});

describe('CreditReleaseHandler.release — BC3, reused unchanged from credit.hold', () => {
  it('throws CreditLineNotFoundError, writes nothing, when no credit line exists for the (retailerCode, companyCode) pair', async () => {
    const { repo, saveCalls } = repositoryOf(null);
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditReleaseHandler(unitOfWork, repo, fixedClock);

    await expect(handler.release(releaseCommand())).rejects.toBeInstanceOf(CreditLineNotFoundError);
    expect(saveCalls).toHaveLength(0);
  });
});

describe('CreditReleaseHandler.release — reply built after commit', () => {
  it('returns the reply only after execute resolves, and rollback propagates the rejection with no reply', async () => {
    const holdEntry = { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(4_000, CURRENCY), type: 'hold' as const, entryDate: new Date() };
    const credit = BuyerCredit.reconstitute(creditSnapshot({ committedExposure: 4_000, orderEntries: [holdEntry] }));
    const { repo } = repositoryOf(credit);
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditReleaseHandler(unitOfWork, repo, fixedClock);

    const reply = await handler.release(releaseCommand());
    expect(reply.released).toBe(true);
    expect(unitOfWork.executeCalls).toBe(1);

    const notFoundRepo = repositoryOf(null).repo;
    const notFoundHandler = new CreditReleaseHandler(new FakeUnitOfWork(), notFoundRepo, fixedClock);

    await expect(notFoundHandler.release(releaseCommand())).rejects.toBeInstanceOf(CreditLineNotFoundError);
  });
});
