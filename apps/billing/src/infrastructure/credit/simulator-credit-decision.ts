// Feature 20 — the credit-check SIMULATOR bound in place of
// `AlwaysApproveCreditDecision` (requirements.md §5.1, R42–R44). A DEMO
// DETERMINISM DEVICE, not a credit policy: it exists solely to make the
// compensation path reproducible on demand (place an order whose total
// ends in `.99`) without needing a retailer whose credit limit is nearly
// exhausted. It lives entirely behind `CreditDecisionPort` — no domain,
// application or presentation file changes for this feature.
//
// Precedence (documented because both rules could apply to the same
// request): the `.99` rule is checked FIRST and, if it matches, wins
// unconditionally — R42 requires the cents rule to reject "regardless of
// the retailer's available credit" and, by the same demo-determinism
// intent, regardless of the failure-rate draw too. A `.99` amount must
// therefore NEVER surface as `simulated_failure_rate` depending on which
// pseudo-random value happened to be drawn — see
// `simulator-credit-decision.spec.ts` › *the cents rule wins over the
// failure-rate rule when both could apply* for the test that pins this
// down, and the "armed deletion" note in
// `progress/impl_billing_credit_simulator.md` for the branch this
// ordering protects.
//
// No I/O — `decide` runs inside the credit line's row lock
// (credit-decision.port.ts). Randomness is injected (`random`, defaulting
// to `Math.random`) so the failure-rate branch is deterministic under
// test — nothing in this file calls `Math.random()` in a way a test
// cannot override.
import type { CreditDecision, CreditDecisionPort, CreditDecisionRequest } from '../../application/ports/credit-decision.port.js';

export interface CreditSimulatorConfig {
  /** Proportion of fitting hold requests refused with `simulated_failure_rate`, in the closed interval `[0, 1]` (R43). */
  readonly failureRate: number;
}

/**
 * Reads `CREDIT_FAILURE_RATE` from the process environment (see
 * .env.example § Billing). Defaults to `0` so behaviour is deterministic
 * unless a demo explicitly asks for noise (R43). An out-of-range or
 * non-numeric value is NOT clamped and NOT silently defaulted — doing
 * either would make a demo non-reproducible for invisible reasons — it
 * throws synchronously so `app.module.ts`'s `useFactory` fails Nest's
 * module compilation and the service fails to start, reporting the
 * offending value (R43's last clause).
 */
export function loadCreditSimulatorConfig(env: NodeJS.ProcessEnv = process.env): CreditSimulatorConfig {
  const raw = env.CREDIT_FAILURE_RATE;
  if (raw === undefined || raw === '') {
    return { failureRate: 0 };
  }
  const failureRate = Number(raw);
  if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) {
    throw new Error(`CREDIT_FAILURE_RATE must be a number in the closed interval [0, 1]; got ${JSON.stringify(raw)}`);
  }
  return { failureRate };
}

export class SimulatorCreditDecision implements CreditDecisionPort {
  constructor(
    private readonly config: CreditSimulatorConfig,
    /** Injectable so the failure-rate branch is deterministic under test — never call `Math.random()` directly elsewhere in this class. */
    private readonly random: () => number = Math.random,
  ) {}

  decide(request: CreditDecisionRequest): CreditDecision {
    // R42 — checked first, wins unconditionally when it matches (see the
    // precedence note in this file's header).
    if (request.amountMinorUnits % 100 === 99) {
      return { kind: 'refuse', reason: 'simulated_cents_rule' };
    }

    // R43 — a pseudo-random proportion equal to `CREDIT_FAILURE_RATE`.
    // `random()` is expected to return a value in `[0, 1)`, the same
    // contract `Math.random()` carries; `failureRate = 0` (the default)
    // can then never trigger this branch, and `failureRate = 1` always
    // does.
    if (this.random() < this.config.failureRate) {
      return { kind: 'refuse', reason: 'simulated_failure_rate' };
    }

    return { kind: 'approve' };
  }
}
