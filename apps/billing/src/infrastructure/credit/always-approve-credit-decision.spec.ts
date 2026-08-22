// BC15 — the adapter bound while no credit-check simulator exists.
import { describe, expect, it } from 'vitest';
import type { CreditDecisionRequest } from '../../application/ports/credit-decision.port.js';
import { AlwaysApproveCreditDecision } from './always-approve-credit-decision.js';

function request(overrides: Partial<CreditDecisionRequest> = {}): CreditDecisionRequest {
  return {
    orderReference: 'ORD-000001',
    retailerCode: 'RET-0001',
    companyCode: 'COM-0001',
    creditCode: 'CR-000001',
    amountMinorUnits: 4_000,
    currency: 'EUR',
    availableCreditMinorUnits: 6_000,
    ...overrides,
  };
}

describe('always-approve-credit-decision.spec — BC15', () => {
  it('approves every request, and is the only file feature 20 replaces to bind the simulator', () => {
    const adapter = new AlwaysApproveCreditDecision();

    expect(adapter.decide(request())).toEqual({ kind: 'approve' });
    expect(adapter.decide(request({ amountMinorUnits: 999_999_999 }))).toEqual({ kind: 'approve' });
    expect(adapter.decide(request({ currency: 'GBP' }))).toEqual({ kind: 'approve' });
  });

  it('never performs I/O and resolves synchronously', () => {
    const adapter = new AlwaysApproveCreditDecision();

    const result = adapter.decide(request());

    expect(result).not.toBeInstanceOf(Promise);
  });
});
