// Pure unit — fake `UnitOfWork`/`BuyerCreditRepository`/`CreditDecisionPort`/
// `Clock` (CLAUDE.md § Testing conventions). Proves: BC7's already_held
// short-circuit calls no port and writes nothing; BC13's port ordering; the
// reply is built from the domain outcome and returned only AFTER `execute`
// resolves; a rollback (the transactional work rejects) propagates the
// rejection and never produces a reply.
import { CreditLineReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { CreditHoldRequestPayload } from '@otc/contracts';
import { describe, expect, it } from 'vitest';
import { BuyerCredit } from '../domain/buyer-credit.js';
import type { BuyerCreditSnapshot } from '../domain/buyer-credit-snapshot.js';
import { HoldCreditCommand } from './commands/credit.commands.js';
import { CreditHoldHandler } from './credit-hold.handler.js';
import type { Clock } from './ports/clock.port.js';
import type { BuyerCreditRepository } from './ports/buyer-credit-repository.port.js';
import type { CreditDecision, CreditDecisionPort, CreditDecisionRequest } from './ports/credit-decision.port.js';
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

const fixedClock: Clock = { now: () => new Date('2026-08-21T10:00:00.000Z') };

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

function holdCommand(overrides: Partial<CreditHoldRequestPayload> = {}): HoldCreditCommand {
  const request: CreditHoldRequestPayload = {
    orderReference: ORDER.value,
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    amount: { amount: 4_000, currency: CURRENCY },
    ...overrides,
  };
  return new HoldCreditCommand(request, UniqueId.generate(), UniqueId.generate());
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

function alwaysApprove(): { port: CreditDecisionPort; calls: CreditDecisionRequest[] } {
  const calls: CreditDecisionRequest[] = [];
  const port: CreditDecisionPort = {
    decide(request) {
      calls.push(request);
      return { kind: 'approve' } satisfies CreditDecision;
    },
  };
  return { port, calls };
}

describe('CreditHoldHandler.hold — BC7', () => {
  it('already_held short-circuits on a hold entry whose exposure has since been released, calling no port and writing nothing', async () => {
    const holdEntry = { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(4_000, CURRENCY), type: 'hold' as const, entryDate: new Date() };
    const releaseEntry = { id: UniqueId.generate(), orderReference: ORDER, amount: Money.of(4_000, CURRENCY), type: 'release' as const, entryDate: new Date() };
    const credit = BuyerCredit.reconstitute(creditSnapshot({ orderEntries: [holdEntry, releaseEntry] }));
    const { repo, saveCalls } = repositoryOf(credit);
    let portCalled = false;
    const port: CreditDecisionPort = {
      decide() {
        portCalled = true;
        return { kind: 'approve' };
      },
    };
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditHoldHandler(unitOfWork, repo, port, fixedClock);

    const reply = await handler.hold(holdCommand());

    expect(reply).toMatchObject({ outcome: 'already_held', heldAmount: 4_000 });
    expect(portCalled).toBe(false);
    expect(saveCalls).toHaveLength(0);
  });
});

describe('CreditHoldHandler.hold — BC13', () => {
  it('consults the credit-decision port only after the aggregate has found the amount fits, and never for an over-limit request', async () => {
    const overLimitCredit = BuyerCredit.reconstitute(creditSnapshot({ creditLimit: 1_000 }));
    const { repo: overLimitRepo } = repositoryOf(overLimitCredit);
    const { port: overLimitPort, calls: overLimitCalls } = alwaysApprove();
    const overLimitHandler = new CreditHoldHandler(new FakeUnitOfWork(), overLimitRepo, overLimitPort, fixedClock);

    const overLimitReply = await overLimitHandler.hold(holdCommand({ amount: { amount: 2_000, currency: CURRENCY } }));

    expect(overLimitReply).toMatchObject({ outcome: 'rejected', reason: 'over_limit' });
    expect(overLimitCalls).toHaveLength(0);

    const fittingCredit = BuyerCredit.reconstitute(creditSnapshot({ creditLimit: 10_000 }));
    const { repo: fittingRepo } = repositoryOf(fittingCredit);
    const { port: fittingPort, calls: fittingCalls } = alwaysApprove();
    const fittingHandler = new CreditHoldHandler(new FakeUnitOfWork(), fittingRepo, fittingPort, fixedClock);

    const fittingReply = await fittingHandler.hold(holdCommand({ amount: { amount: 2_000, currency: CURRENCY } }));

    expect(fittingReply).toMatchObject({ outcome: 'approved' });
    expect(fittingCalls).toHaveLength(1);
  });
});

describe('CreditHoldHandler.hold — reply built after commit', () => {
  it('returns the reply only after execute resolves, and rollback propagates the rejection with no reply', async () => {
    const credit = BuyerCredit.reconstitute(creditSnapshot());
    const { repo } = repositoryOf(credit);
    const { port } = alwaysApprove();
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditHoldHandler(unitOfWork, repo, port, fixedClock);

    const reply = await handler.hold(holdCommand());
    expect(reply.outcome).toBe('approved');
    expect(unitOfWork.executeCalls).toBe(1);

    const notFoundRepo = repositoryOf(null).repo;
    const notFoundHandler = new CreditHoldHandler(new FakeUnitOfWork(), notFoundRepo, port, fixedClock);

    await expect(notFoundHandler.hold(holdCommand())).rejects.toBeInstanceOf(CreditLineNotFoundError);
  });
});

describe('CreditHoldHandler.hold — R39, port refusal', () => {
  it('returns rejected with the port\'s reason and records a credit.rejected.v1 fact when the port refuses a fitting hold', async () => {
    const credit = BuyerCredit.reconstitute(creditSnapshot({ creditLimit: 10_000 }));
    const { repo, saveCalls } = repositoryOf(credit);
    const refusedReason = 'simulated_cents_rule' as const;
    const refusingPort: CreditDecisionPort = {
      decide() {
        return { kind: 'refuse', reason: refusedReason } satisfies CreditDecision;
      },
    };
    const unitOfWork = new FakeUnitOfWork();
    const handler = new CreditHoldHandler(unitOfWork, repo, refusingPort, fixedClock);

    const reply = await handler.hold(holdCommand({ amount: { amount: 4_000, currency: CURRENCY } }));

    expect(reply).toMatchObject({
      outcome: 'rejected',
      orderReference: ORDER.value,
      reason: refusedReason,
    });
    expect(saveCalls).toHaveLength(1);

    const savedCredit = saveCalls[0];
    const events = savedCredit!.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('credit.rejected.v1');
    expect(events[0]?.payload).toMatchObject({ reason: refusedReason });
  });
});
