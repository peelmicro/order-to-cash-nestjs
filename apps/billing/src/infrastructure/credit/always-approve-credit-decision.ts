// The adapter that was bound in `app.module.ts` before feature 20 landed
// (design.md §6.3). A pure, dependency-free class that approves every
// request it is asked about — every request it is asked about already
// fits the credit limit, because `CreditHoldHandler` consults this port
// only after the aggregate has answered `fits` (BC13).
//
// Feature 20 (`simulator-credit-decision.ts`, the `.99` rule and
// `CREDIT_FAILURE_RATE`) is now the binding in `app.module.ts` — this file
// stays in the tree, still implementing `CreditDecisionPort` and still
// covered by its own spec below, as a minimal reference adapter and for
// any harness that wants approve-everything behaviour without the
// simulator's rules. No domain file, no application file, no presentation
// file, no port, no DTO and no fact builder changed when feature 20
// landed — only `app.module.ts`'s `useFactory` for `CREDIT_DECISION`
// moved off this class.
import type { CreditDecision, CreditDecisionPort, CreditDecisionRequest } from '../../application/ports/credit-decision.port.js';

export class AlwaysApproveCreditDecision implements CreditDecisionPort {
  decide(_request: CreditDecisionRequest): CreditDecision {
    return { kind: 'approve' };
  }
}
