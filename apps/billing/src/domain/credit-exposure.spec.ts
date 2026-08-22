// Pure unit — no framework, no DB, no clock. The BC5/BC6 identities as
// properties of `summariseLedger`, including the cancelled-before-invoice
// case `domain-model.md` §5.1's literal formula gets wrong (design.md
// §3.3).
import { Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { summariseLedger } from './credit-exposure.js';
import type { CreditLedgerEntrySnapshot } from './credit-ledger-entry.js';
import type { CreditEntryType } from './credit-ledger-entry.js';

const ORDER = OrderNumber.fromSequence(1);
const CURRENCY = 'EUR';

function entry(type: CreditEntryType, amount: number, order: OrderNumber = ORDER): CreditLedgerEntrySnapshot {
  return {
    id: UniqueId.generate(),
    orderReference: order,
    amount: Money.of(amount, CURRENCY),
    type,
    entryDate: new Date('2026-08-21T10:00:00.000Z'),
  };
}

describe('credit-exposure.spec — the BC5/BC6 identities', () => {
  it('a consume entry moves committedExposure (and therefore availableCredit) by nothing — R40 as a property of the formula', () => {
    const withoutConsume = summariseLedger([entry('hold', 10_000)]);
    const withConsume = summariseLedger([entry('hold', 10_000), entry('consume', 10_000)]);

    expect(withConsume.committedExposure).toBe(withoutConsume.committedExposure);
  });

  it('activeHolds + openExposure = committedExposure for every fixture (the BC6 reconciliation identity)', () => {
    const fixtures: CreditLedgerEntrySnapshot[][] = [
      [entry('hold', 10_000)],
      [entry('hold', 10_000), entry('consume', 4_000)],
      [entry('hold', 10_000), entry('consume', 10_000)],
      [entry('hold', 10_000), entry('release', 10_000)],
      [entry('hold', 10_000), entry('consume', 10_000), entry('release', 10_000)],
    ];

    for (const fixture of fixtures) {
      const summary = summariseLedger(fixture);
      expect(summary.activeHolds + summary.openExposure).toBe(summary.committedExposure);
    }
  });

  it('the cancelled-before-invoice case (hold, then release, no consume) yields exposure 0, openExposure 0, activeHold 0 and never a negative — the case the literal §5.1 formula gets wrong', () => {
    const summary = summariseLedger([entry('hold', 10_000), entry('release', 10_000)]);

    expect(summary.byOrder[0]).toMatchObject({ exposure: 0, openExposure: 0, activeHold: 0 });
    expect(summary.committedExposure).toBe(0);
    expect(summary.activeHolds).toBe(0);
    expect(summary.openExposure).toBe(0);
  });

  it('hasHoldEntry stays true even after the hold is fully released — BC7\'s idempotency predicate', () => {
    const summary = summariseLedger([entry('hold', 10_000), entry('release', 10_000)]);

    expect(summary.byOrder[0]?.hasHoldEntry).toBe(true);
  });

  it('committedExposure sums exposure across every distinct order on the line', () => {
    const otherOrder = OrderNumber.fromSequence(2);
    const summary = summariseLedger([entry('hold', 10_000), entry('hold', 5_000, otherOrder), entry('release', 2_000, otherOrder)]);

    expect(summary.committedExposure).toBe(10_000 + (5_000 - 2_000));
    expect(summary.byOrder).toHaveLength(2);
  });

  it('an order with no entries at all is simply absent from byOrder — an empty ledger summarises to all zeros', () => {
    const summary = summariseLedger([]);

    expect(summary).toEqual({ byOrder: [], committedExposure: 0, activeHolds: 0, openExposure: 0 });
  });
});
