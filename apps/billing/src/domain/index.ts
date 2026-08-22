// The deliberate public surface of the Billing domain — design.md §2. The
// aggregate, its child entity, the pure exposure arithmetic, the fact
// builders, the domain errors and the snapshot shapes. Everything else in
// this directory stays internal and is reached only through what is
// exported here.
export { BuyerCredit, type CreditContext, type HoldEvaluation, type HoldRequest } from './buyer-credit.js';

export { CreditLedgerEntry, CREDIT_ENTRY_TYPES, type CreditEntryType } from './credit-ledger-entry.js';
export type { CreditLedgerEntrySnapshot } from './credit-ledger-entry.js';

export { summariseLedger, type LedgerSummary, type OrderExposure } from './credit-exposure.js';

export {
  creditApprovedEvent,
  creditRejectedEvent,
  creditReleasedEvent,
  type CreditRejectionReason,
  type CreditReleaseReason,
} from './credit-events.js';

export {
  CreditLimitExceededError,
  CreditRefusalMismatchError,
  CreditReleaseUnderflowError,
  FactAggregateMismatchError,
  InvalidBuyerCreditSnapshotError,
  NoActiveHoldError,
} from './credit-errors.js';

export type { BuyerCreditSnapshot } from './buyer-credit-snapshot.js';
