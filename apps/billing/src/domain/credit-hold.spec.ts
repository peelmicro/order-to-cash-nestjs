// Pure unit — no framework, no DB, no clock. R38, R39 (matrix names,
// verbatim), BC10's domain half, BC14's domain half (design.md §3.4, §6.4).
import { CreditLineReference, Money, OrderNumber, UniqueId } from '@otc/shared-kernel';
import type { DomainEventEnvelope } from '@otc/shared-kernel';
import { describe, expect, it } from 'vitest';
import { BuyerCredit, type CreditContext } from './buyer-credit.js';
import type { BuyerCreditSnapshot } from './buyer-credit-snapshot.js';
import { CreditLimitExceededError, CreditRefusalMismatchError } from './credit-errors.js';

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

describe('credit-hold.spec — R38', () => {
  it('appends a hold entry and emits exactly one credit.approved.v1 carrying the held amount and the resulting available credit', () => {
    const credit = BuyerCredit.reconstitute(snapshot());
    const request = { orderReference: ORDER, amount: Money.of(4_000, CURRENCY), correlationId: UniqueId.generate() };

    const entry = credit.approveHold(request, ctx(), () => UniqueId.generate());

    expect(entry.type).toBe('hold');
    expect(entry.amount).toEqual(Money.of(4_000, CURRENCY));
    expect(credit.appendedEntries).toHaveLength(1);

    const events = credit.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('credit.approved.v1');
    expect(events[0]?.payload).toMatchObject({
      orderReference: ORDER.value,
      heldAmount: 4_000,
      availableCreditAfter: 6_000,
    });
  });

  it('throws CreditLimitExceededError when asked to approve a hold evaluateHold would not answer fits for, and appends/emits nothing', () => {
    const credit = BuyerCredit.reconstitute(snapshot({ creditLimit: 1_000 }));
    const request = { orderReference: ORDER, amount: Money.of(2_000, CURRENCY), correlationId: UniqueId.generate() };

    expect(() => credit.approveHold(request, ctx(), () => UniqueId.generate())).toThrow(CreditLimitExceededError);
    expect(credit.appendedEntries).toHaveLength(0);
    expect(credit.pullDomainEvents()).toHaveLength(0);
  });
});

describe('credit-hold.spec — R39', () => {
  it('appends no ledger entry and emits credit.rejected.v1 with a machine-readable reason when the amount exceeds the available credit or the credit port refuses', () => {
    const overLimitCredit = BuyerCredit.reconstitute(snapshot({ creditLimit: 1_000 }));
    const overLimitRequest = { orderReference: ORDER, amount: Money.of(2_000, CURRENCY), correlationId: UniqueId.generate() };
    overLimitCredit.refuseHold(overLimitRequest, 'over_limit', ctx());

    expect(overLimitCredit.appendedEntries).toHaveLength(0);
    const overLimitEvents = overLimitCredit.pullDomainEvents();
    expect(overLimitEvents).toHaveLength(1);
    expect(overLimitEvents[0]?.eventType).toBe('credit.rejected.v1');
    expect(overLimitEvents[0]?.payload).toMatchObject({ reason: 'over_limit', requestedAmount: 2_000, availableCredit: 1_000 });
    expect(overLimitCredit.availableCredit).toEqual(Money.of(1_000, CURRENCY));

    const portRefusedCredit = BuyerCredit.reconstitute(snapshot({ creditLimit: 10_000 }));
    const fittingRequest = { orderReference: ORDER, amount: Money.of(4_000, CURRENCY), correlationId: UniqueId.generate() };
    portRefusedCredit.refuseHold(fittingRequest, 'simulated_cents_rule', ctx());

    expect(portRefusedCredit.appendedEntries).toHaveLength(0);
    const portRefusedEvents = portRefusedCredit.pullDomainEvents();
    expect(portRefusedEvents).toHaveLength(1);
    expect(portRefusedEvents[0]?.payload).toMatchObject({ reason: 'simulated_cents_rule' });
    expect(portRefusedCredit.availableCredit).toEqual(Money.of(10_000, CURRENCY));
  });

  it('refuses to refuse with reason over_limit when the amount actually fits — a refusal must not lie about why', () => {
    const credit = BuyerCredit.reconstitute(snapshot({ creditLimit: 10_000 }));
    const request = { orderReference: ORDER, amount: Money.of(4_000, CURRENCY), correlationId: UniqueId.generate() };

    expect(() => credit.refuseHold(request, 'over_limit', ctx())).toThrow(CreditRefusalMismatchError);
  });
});

describe('credit-hold.spec — BC10', () => {
  it('reports availableCreditAfter recomputed with the appended hold, never the pre-hold value', () => {
    const credit = BuyerCredit.reconstitute(snapshot({ creditLimit: 10_000, committedExposure: 3_000 }));
    const request = { orderReference: ORDER, amount: Money.of(2_000, CURRENCY), correlationId: UniqueId.generate() };
    const preHoldAvailable = credit.availableCredit.amount;

    credit.approveHold(request, ctx(), () => UniqueId.generate());

    const [event] = credit.pullDomainEvents();
    const payload = event!.payload as { availableCreditAfter: number };
    expect(payload.availableCreditAfter).not.toBe(preHoldAvailable);
    expect(payload.availableCreditAfter).toBe(10_000 - 3_000 - 2_000);
  });
});

describe('credit-hold.spec — BC14', () => {
  it('emits a credit.rejected.v1 for an adapter refusal that differs from the over-limit refusal in the reason field and in nothing else', () => {
    const fixedCtx = ctx();
    // ONE fixture — same credit line state, same requested amount — fed
    // into two otherwise-identical instances, refused with two different
    // reasons. `over_limit` is only accepted by `refuseHold` when the
    // amount genuinely does not fit, so the request is deliberately over
    // the line's limit for both.
    const fixture = snapshot({ creditLimit: 1_000, code: CreditLineReference.fromSequence(9) });
    const request = { orderReference: ORDER, amount: Money.of(2_000, CURRENCY), correlationId: UniqueId.generate() };

    const overLimitCredit = BuyerCredit.reconstitute(fixture);
    overLimitCredit.refuseHold(request, 'over_limit', fixedCtx);
    const [overLimitEvent] = overLimitCredit.pullDomainEvents();

    const adapterRefusedCredit = BuyerCredit.reconstitute(fixture);
    adapterRefusedCredit.refuseHold(request, 'simulated_cents_rule', fixedCtx);
    const [adapterEvent] = adapterRefusedCredit.pullDomainEvents();

    function normalise(event: DomainEventEnvelope): unknown {
      const { eventId, occurredAt, payload, ...rest } = event;
      const { reason, ...payloadRest } = payload as Record<string, unknown>;
      void eventId;
      void occurredAt;
      void reason;
      return { ...rest, payload: payloadRest };
    }

    expect(normalise(adapterEvent!)).toEqual(normalise(overLimitEvent!));
    expect(overLimitEvent!.eventType).toBe('credit.rejected.v1');
    expect(adapterEvent!.eventType).toBe('credit.rejected.v1');
    expect(overLimitEvent!.payload.reason).toBe('over_limit');
    expect(adapterEvent!.payload.reason).toBe('simulated_cents_rule');
  });
});
