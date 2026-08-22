// The credit-decision port — feature 20's seam, fixed now (design.md §6).
// Not a method on the repository and not a parameter of the aggregate: a
// separate port so feature 20's whole footprint can be one provider
// (`useFactory`) with no change to any domain, application or presentation
// file (§6.3).
//
// Two guarantees this file states in types, not just in prose:
//   1. The port is consulted ONLY after `BuyerCredit.evaluateHold` has
//      already answered `fits` (BC13) — enforced by the application layer's
//      call ordering (credit-hold.handler.ts), not by this file.
//   2. The port MUST NOT return `over_limit` — `AdapterRejectionReason`
//      structurally excludes it, so an adapter is INCAPABLE of claiming the
//      aggregate's own word (BC14). It can only ever narrow an approval,
//      never widen one.
// The port must not perform I/O — it runs inside the credit line's row
// lock (design.md §5.5).
import type { CreditRejectionReason } from '../../domain/credit-events.js';

export const CREDIT_DECISION = Symbol('CreditDecision');

/** Everything an adapter may see. It is told the amount and the credit line's state; it is NOT given the aggregate, the repository, the transaction or the clock. */
export interface CreditDecisionRequest {
  readonly orderReference: string;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly creditCode: string;
  /** The order total — integer minor units. */
  readonly amountMinorUnits: number;
  readonly currency: string;
  /** BEFORE the hold, AFTER the aggregate found it fits. */
  readonly availableCreditMinorUnits: number;
}

/** `over_limit` is deliberately excluded: it is the aggregate's word, and only the aggregate may say it (BC14). */
export type AdapterRejectionReason = Exclude<CreditRejectionReason, 'over_limit'>;

export type CreditDecision = { readonly kind: 'approve' } | { readonly kind: 'refuse'; readonly reason: AdapterRejectionReason };

export interface CreditDecisionPort {
  /** Called ONCE per hold, and ONLY when the aggregate has already answered `fits` (BC13). Synchronous or not; must not perform I/O — it runs inside the credit line's row lock. */
  decide(request: CreditDecisionRequest): CreditDecision | Promise<CreditDecision>;
}
