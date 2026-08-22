// Pure unit — no framework, no DB, no clock. R40, R41 (matrix names,
// verbatim), BC6's domain half, BC11, BC12 (design.md §3.1, §3.3).
import { CreditLineReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { BuyerCredit, type CreditContext } from './buyer-credit.js';
import type { BuyerCreditSnapshot } from './buyer-credit-snapshot.js';
import { CreditReleaseUnderflowError, NoActiveHoldError } from './credit-errors.js';
import type { CreditLedgerEntrySnapshot } from './credit-ledger-entry.js';

const CURRENCY = 'EUR';
const ORDER = OrderNumber.fromSequence(1);

function ctx(overrides: Partial<CreditContext> = {}): CreditContext {
  return { occurredAt: new Date('2026-08-21T10:00:00.000Z'), causationId: UniqueId.generate(), ...overrides };
}

function snapshot(overrides: Partial<BuyerCreditSnapshot> = {}): BuyerCreditSnapshot {
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

function held(credit: BuyerCredit, amount = 4_000): void {
  credit.approveHold({ orderReference: ORDER, amount: Money.of(amount, CURRENCY), correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
  credit.pullDomainEvents();
}

describe('credit-ledger.spec — R40', () => {
  it('appends a consume entry at invoice issue that leaves available credit numerically unchanged and emits no fact', () => {
    const credit = BuyerCredit.reconstitute(snapshot());
    held(credit);
    const before = credit.availableCredit;

    const entry = credit.consumeHold({ orderReference: ORDER }, ctx(), () => UniqueId.generate());

    expect(entry.type).toBe('consume');
    expect(credit.availableCredit).toEqual(before);
    expect(credit.pullDomainEvents()).toHaveLength(0);
  });
});

describe('credit-ledger.spec — R41', () => {
  it('releases with reason invoice_paid on payment and with reason order_cancelled on cancellation, restoring available credit without going below zero', () => {
    const paidCredit = BuyerCredit.reconstitute(snapshot());
    held(paidCredit);
    const paidEntry = paidCredit.releaseHold({ orderReference: ORDER, reason: 'invoice_paid', correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
    expect(paidEntry?.type).toBe('release');
    expect(paidCredit.availableCredit).toEqual(Money.of(10_000, CURRENCY));
    const [paidEvent] = paidCredit.pullDomainEvents();
    expect(paidEvent?.payload).toMatchObject({ reason: 'invoice_paid' });

    const cancelledCredit = BuyerCredit.reconstitute(snapshot());
    held(cancelledCredit);
    const cancelledEntry = cancelledCredit.releaseHold(
      { orderReference: ORDER, reason: 'order_cancelled', correlationId: UniqueId.generate() },
      ctx(),
      () => UniqueId.generate(),
    );
    expect(cancelledEntry?.type).toBe('release');
    expect(cancelledCredit.availableCredit).toEqual(Money.of(10_000, CURRENCY));
    expect(cancelledCredit.availableCredit.amount).toBeLessThanOrEqual(cancelledCredit.creditLimit.amount);
    const [cancelledEvent] = cancelledCredit.pullDomainEvents();
    expect(cancelledEvent?.payload).toMatchObject({ reason: 'order_cancelled' });
  });
});

describe('credit-ledger.spec — BC6', () => {
  it('splits outstanding exposure into active holds and open invoice exposure whose sum always equals the limit minus available credit', () => {
    const fixtures: { build: (credit: BuyerCredit) => void }[] = [
      { build: (credit) => held(credit) }, // held only
      {
        build: (credit) => {
          held(credit);
          credit.consumeHold({ orderReference: ORDER }, ctx(), () => UniqueId.generate());
        },
      }, // held + consumed
      {
        build: (credit) => {
          held(credit);
          credit.releaseHold({ orderReference: ORDER, reason: 'order_cancelled', correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
        },
      }, // held + released
    ];

    for (const fixture of fixtures) {
      const credit = BuyerCredit.reconstitute(snapshot());
      fixture.build(credit);
      const summary = credit.summary;
      const limitMinusAvailable = credit.creditLimit.amount - credit.availableCredit.amount;
      expect(summary.activeHolds + summary.openExposure).toBe(limitMinusAvailable);
    }
  });
});

describe('credit-ledger.spec — BC11', () => {
  it('releases the order\'s outstanding exposure once, reports a no-op on a second release, and refuses a release that would drive exposure below zero', () => {
    const credit = BuyerCredit.reconstitute(snapshot());
    held(credit, 4_000);

    const first = credit.releaseHold({ orderReference: ORDER, reason: 'invoice_paid', correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
    expect(first?.amount).toEqual(Money.of(4_000, CURRENCY));
    credit.pullDomainEvents();

    const second = credit.releaseHold({ orderReference: ORDER, reason: 'invoice_paid', correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
    expect(second).toBeNull();
    expect(credit.pullDomainEvents()).toHaveLength(0);

    // A corrupted ledger (release already exceeds hold) — the loaded
    // snapshot itself already violates B5 for this order; reconstitute
    // only checks B1/B3, so this is the one place the underflow can be
    // observed.
    const corruptOrder = OrderNumber.fromSequence(2);
    const corruptEntries: CreditLedgerEntrySnapshot[] = [
      { id: UniqueId.generate(), orderReference: corruptOrder, amount: Money.of(1_000, CURRENCY), type: 'hold', entryDate: new Date() },
      { id: UniqueId.generate(), orderReference: corruptOrder, amount: Money.of(1_500, CURRENCY), type: 'release', entryDate: new Date() },
    ];
    const corruptCredit = BuyerCredit.reconstitute(snapshot({ committedExposure: -500, orderEntries: corruptEntries }));

    expect(() =>
      corruptCredit.releaseHold({ orderReference: corruptOrder, reason: 'invoice_paid', correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate()),
    ).toThrow(CreditReleaseUnderflowError);
  });
});

describe('credit-ledger.spec — BC12', () => {
  it('appends a consume entry that leaves available credit unchanged and emits no fact, and refuses to consume an order with no active hold', () => {
    const credit = BuyerCredit.reconstitute(snapshot());
    held(credit, 4_000);
    const before = credit.availableCredit;

    const entry = credit.consumeHold({ orderReference: ORDER }, ctx(), () => UniqueId.generate());
    expect(entry.amount).toEqual(Money.of(4_000, CURRENCY));
    expect(credit.availableCredit).toEqual(before);
    expect(credit.pullDomainEvents()).toHaveLength(0);

    const neverHeld = BuyerCredit.reconstitute(snapshot());
    expect(() => neverHeld.consumeHold({ orderReference: ORDER }, ctx(), () => UniqueId.generate())).toThrow(NoActiveHoldError);
  });
});
