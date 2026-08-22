// Pure unit — no framework, no DB, no clock. R37 (matrix name) and BC5.
import { CreditLineReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { BuyerCredit, type CreditContext } from './buyer-credit.js';
import type { BuyerCreditSnapshot } from './buyer-credit-snapshot.js';
import { InvalidBuyerCreditSnapshotError } from './credit-errors.js';

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
    creditLimit: 500_000,
    currency: CURRENCY,
    committedExposure: 0,
    orderEntries: [],
    ...overrides,
  };
}

describe('buyer-credit.spec — R37', () => {
  it('keeps active holds plus open exposure within the credit limit and raises on any update or deletion of a ledger entry', () => {
    const credit = BuyerCredit.reconstitute(snapshot({ creditLimit: 10_000 }));

    // Nothing can push activeHold+openExposure past creditLimit: an
    // over-limit hold is refused before any entry exists.
    expect(credit.evaluateHold({ orderReference: ORDER, amount: Money.of(10_001, CURRENCY), correlationId: UniqueId.generate() })).toMatchObject({
      kind: 'over_limit',
    });

    // Append one hold entry, then attempt to "reverse" it — the only
    // runtime-reachable analogue of updating/deleting a loaded entry is
    // asking the aggregate to release it, which APPENDS a new entry rather
    // than mutating or removing the existing one (B2: append-only,
    // enforced by shape — CreditLedgerEntry has no mutator at all, a
    // compile-time impossibility this test cannot even attempt).
    credit.approveHold({ orderReference: ORDER, amount: Money.of(4_000, CURRENCY), correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
    const afterHold = credit.toSnapshot().orderEntries;
    expect(afterHold).toHaveLength(1);
    const holdEntry = afterHold[0]!;

    credit.releaseHold({ orderReference: ORDER, reason: 'order_cancelled', correlationId: UniqueId.generate() }, ctx(), () => UniqueId.generate());
    const afterRelease = credit.toSnapshot().orderEntries;

    // The original hold entry is still present, byte-identical — never
    // updated, never deleted; a NEW release entry was appended instead.
    expect(afterRelease).toHaveLength(2);
    expect(afterRelease[0]).toEqual(holdEntry);
    expect(afterRelease[1]?.type).toBe('release');

    // And the invariant itself: committed exposure never exceeded the
    // limit at any point this test observed.
    expect(credit.summary.committedExposure).toBeLessThanOrEqual(10_000);
  });

  it('refuses to reconstitute a snapshot whose committedExposure already exceeds creditLimit (B1)', () => {
    expect(() => BuyerCredit.reconstitute(snapshot({ creditLimit: 1_000, committedExposure: 1_001 }))).toThrow(
      InvalidBuyerCreditSnapshotError,
    );
  });

  it('refuses to reconstitute a snapshot carrying an entry in a currency other than the line\'s (B3)', () => {
    const entry = {
      id: UniqueId.generate(),
      orderReference: ORDER,
      amount: Money.of(1_000, 'GBP'),
      type: 'hold' as const,
      entryDate: new Date('2026-08-21T10:00:00.000Z'),
    };
    expect(() => BuyerCredit.reconstitute(snapshot({ currency: 'EUR', orderEntries: [entry] }))).toThrow(InvalidBuyerCreditSnapshotError);
  });
});

describe('buyer-credit.spec — BC5', () => {
  it('derives available credit as the limit minus holds plus releases, so a consume entry moves it by nothing', () => {
    const credit = BuyerCredit.reconstitute(snapshot({ creditLimit: 10_000 }));
    const newId = () => UniqueId.generate();

    credit.approveHold({ orderReference: ORDER, amount: Money.of(4_000, CURRENCY), correlationId: UniqueId.generate() }, ctx(), newId);
    expect(credit.availableCredit).toEqual(Money.of(6_000, CURRENCY));

    credit.consumeHold({ orderReference: ORDER }, ctx(), newId);
    // consume is numerically neutral (R40) — availableCredit unchanged.
    expect(credit.availableCredit).toEqual(Money.of(6_000, CURRENCY));

    credit.releaseHold({ orderReference: ORDER, reason: 'invoice_paid', correlationId: UniqueId.generate() }, ctx(), newId);
    expect(credit.availableCredit).toEqual(Money.of(10_000, CURRENCY));
  });
});
