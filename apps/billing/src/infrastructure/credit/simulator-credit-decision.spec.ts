// R42, R43 — pure unit, no I/O, deterministic randomness via injection.
// Mirrors always-approve-credit-decision.spec.ts's fixture shape.
import { describe, expect, it } from 'vitest';
import type { CreditDecisionRequest } from '../../application/ports/credit-decision.port.js';
import { SimulatorCreditDecision, loadCreditSimulatorConfig } from './simulator-credit-decision.js';

function request(overrides: Partial<CreditDecisionRequest> = {}): CreditDecisionRequest {
  return {
    orderReference: 'ORD-000001',
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    creditCode: 'CR-000001',
    amountMinorUnits: 4_000,
    currency: 'EUR',
    availableCreditMinorUnits: 999_999_999,
    ...overrides,
  };
}

describe('simulator-credit-decision.spec — R42', () => {
  it('rejects a total whose minor units end in 99 with reason simulated_cents_rule even when the retailer has ample credit', () => {
    const adapter = new SimulatorCreditDecision({ failureRate: 0 }, () => 0);

    const decision = adapter.decide(request({ amountMinorUnits: 24_999, availableCreditMinorUnits: 999_999_999 }));

    expect(decision).toEqual({ kind: 'refuse', reason: 'simulated_cents_rule' });
  });

  it('approves an amount that does not end in 99 when the failure rate is zero', () => {
    const adapter = new SimulatorCreditDecision({ failureRate: 0 }, () => 0);

    expect(adapter.decide(request({ amountMinorUnits: 25_000 }))).toEqual({ kind: 'approve' });
  });

  it('never performs I/O and resolves synchronously', () => {
    const adapter = new SimulatorCreditDecision({ failureRate: 0 });

    const result = adapter.decide(request());

    expect(result).not.toBeInstanceOf(Promise);
  });

  it('the cents rule wins over the failure-rate rule when both could apply', () => {
    // failureRate = 1 and random() = 0 would ALSO refuse via
    // simulated_failure_rate if the cents check did not run first — this
    // pins the precedence documented in simulator-credit-decision.ts's
    // header so the `.99` rule is never randomly reported as the other
    // reason (R42's "regardless of" clause, read as "regardless of
    // anything else the adapter might otherwise decide").
    const adapter = new SimulatorCreditDecision({ failureRate: 1 }, () => 0);

    const decision = adapter.decide(request({ amountMinorUnits: 24_999 }));

    expect(decision).toEqual({ kind: 'refuse', reason: 'simulated_cents_rule' });
  });
});

describe('simulator-credit-decision.spec — R43', () => {
  it('defaults the failure rate to zero, rejects a configured proportion when set, and fails to start reporting the offending value when it is outside the closed interval zero to one', () => {
    expect(loadCreditSimulatorConfig({})).toEqual({ failureRate: 0 });
    expect(loadCreditSimulatorConfig({ CREDIT_FAILURE_RATE: '' })).toEqual({ failureRate: 0 });
    expect(loadCreditSimulatorConfig({ CREDIT_FAILURE_RATE: '0.25' })).toEqual({ failureRate: 0.25 });
    expect(loadCreditSimulatorConfig({ CREDIT_FAILURE_RATE: '0' })).toEqual({ failureRate: 0 });
    expect(loadCreditSimulatorConfig({ CREDIT_FAILURE_RATE: '1' })).toEqual({ failureRate: 1 });

    for (const offending of ['1.5', '-0.1', 'not-a-number', 'NaN', 'Infinity']) {
      expect(() => loadCreditSimulatorConfig({ CREDIT_FAILURE_RATE: offending })).toThrow(offending);
    }
  });

  it('rejects a non-99 amount with reason simulated_failure_rate only when the random draw falls below the configured rate, and never at a zero rate', () => {
    const belowThreshold = new SimulatorCreditDecision({ failureRate: 0.5 }, () => 0.4);
    const atOrAboveThreshold = new SimulatorCreditDecision({ failureRate: 0.5 }, () => 0.5);
    const zeroRateAtLowestDraw = new SimulatorCreditDecision({ failureRate: 0 }, () => 0);

    expect(belowThreshold.decide(request({ amountMinorUnits: 25_000 }))).toEqual({ kind: 'refuse', reason: 'simulated_failure_rate' });
    expect(atOrAboveThreshold.decide(request({ amountMinorUnits: 25_000 }))).toEqual({ kind: 'approve' });
    expect(zeroRateAtLowestDraw.decide(request({ amountMinorUnits: 25_000 }))).toEqual({ kind: 'approve' });
  });

  it('a failure rate of 1 rejects every non-99 amount', () => {
    const adapter = new SimulatorCreditDecision({ failureRate: 1 }, () => 0.999);

    expect(adapter.decide(request({ amountMinorUnits: 25_000 }))).toEqual({ kind: 'refuse', reason: 'simulated_failure_rate' });
  });
});
