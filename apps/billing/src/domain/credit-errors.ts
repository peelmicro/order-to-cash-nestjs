// The domain errors of the `BuyerCredit` aggregate and its `CreditLedgerEntry`
// child entity — design.md §3.5. Every class extends `DomainError`
// (`@otc/shared-kernel`), carries a stable `code` and the fields a caller
// (and a test) needs, the same shape `apps/fulfillment/src/domain/stock-errors.ts`
// established. Codes are the vocabulary `rpc-error-mapper.ts` (§4.4)
// translates into the AsyncAPI `RpcError.code` vocabulary.
import { DomainError, type UniqueId } from '@otc/shared-kernel';

/** B1 (`R37`) — `approveHold` called for an amount that does not actually fit; a caller cannot bypass B1 by skipping `evaluateHold`. */
export class CreditLimitExceededError extends DomainError {
  readonly code = 'CREDIT_LIMIT_EXCEEDED';

  constructor(
    readonly requested: number,
    readonly available: number,
  ) {
    super(`requested ${requested} minor unit(s) but only ${available} available (invariant B1)`);
  }
}

/** `refuseHold` called with `reason: 'over_limit'` for an amount that actually fits — a refusal must not lie about why (design.md §3.1). */
export class CreditRefusalMismatchError extends DomainError {
  readonly code = 'CREDIT_REFUSAL_MISMATCH';

  constructor(readonly reason: string) {
    super(`refuseHold called with reason "${reason}" but the amount actually fits within the credit limit`);
  }
}

/** B5 — defensive: `releaseHold` always releases exactly the order's outstanding exposure, so this fires only if the loaded ledger already violates B5 (a corrupted snapshot `reconstitute` does not check per order — design.md §3.1). */
export class CreditReleaseUnderflowError extends DomainError {
  readonly code = 'CREDIT_RELEASE_UNDERFLOW';

  constructor(
    readonly orderReference: string,
    readonly exposure: number,
  ) {
    super(`order ${orderReference}: outstanding exposure is already negative (${exposure}) — invariant B5 violated`);
  }
}

/** `consumeHold` called for an order holding no active hold (R40's precondition). */
export class NoActiveHoldError extends DomainError {
  readonly code = 'NO_ACTIVE_HOLD';

  constructor(readonly orderReference: string) {
    super(`order ${orderReference}: no active hold to consume`);
  }
}

/** `BuyerCredit.reconstitute` given a snapshot that already violates B1 (`committedExposure > creditLimit`) or carries a negative counter. */
export class InvalidBuyerCreditSnapshotError extends DomainError {
  readonly code = 'INVALID_BUYER_CREDIT_SNAPSHOT';

  constructor(
    readonly reason: string,
    readonly creditId?: UniqueId,
  ) {
    super(`${creditId ? `credit line ${creditId.value}: ` : ''}invalid snapshot: ${reason}`);
  }
}

/** Defensive guard mirroring `apps/fulfillment/src/domain/stock-item.ts`'s `recordOrderFact` — kept for symmetry with the reference implementation even though this aggregate builds its own facts internally and never accepts an externally-built envelope. */
export class FactAggregateMismatchError extends DomainError {
  readonly code = 'FACT_AGGREGATE_MISMATCH';

  constructor(
    readonly creditId: UniqueId,
    readonly eventAggregateId: UniqueId,
  ) {
    super(`credit line ${creditId.value}: refuses to record a fact whose aggregateId (${eventAggregateId.value}) is not its own`);
  }
}
