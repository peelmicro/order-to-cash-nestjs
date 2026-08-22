// The adapter bound in `app.module.ts` TODAY, in place of feature 20's
// simulator (design.md §6.3). A pure, dependency-free class that approves
// every request it is asked about — every request it is asked about
// already fits the credit limit, because `CreditHoldHandler` consults this
// port only after the aggregate has answered `fits` (BC13).
//
// **Feature 20's entire footprint is the ONE provider that replaces this
// file's binding.** It adds `simulator-credit-decision.ts` (the `.99` rule,
// `CREDIT_FAILURE_RATE`) and changes `app.module.ts`'s `useFactory` for
// `CREDIT_DECISION`. No domain file, no application file, no presentation
// file, no port, no DTO, no fact builder and no test of THIS feature
// changes — this file is the only thing feature 20 replaces.
import type { CreditDecision, CreditDecisionPort, CreditDecisionRequest } from '../../application/ports/credit-decision.port.js';

export class AlwaysApproveCreditDecision implements CreditDecisionPort {
  decide(_request: CreditDecisionRequest): CreditDecision {
    return { kind: 'approve' };
  }
}
