// The `BuyerCredit` aggregate root — domain-model.md §5.1, design.md §3.1.
// Mirrors `apps/fulfillment/src/domain/stock-item.ts`'s shape: a pure
// function of its inputs (no clock, no port — everything comes in through
// `CreditContext` or method arguments), and it PRESERVES `committedExposure`
// (the BC5 scalar) rather than recomputing it from everything it can see —
// it is reconstituted with the whole line's committed exposure plus only
// the entries of the ONE order the command names (design.md §3.1's "What
// the aggregate holds, honestly").
import { AggregateRoot, Money, type CreditLineReference, type DomainEventEnvelope, type OrderNumber, type UniqueId } from '@otc/shared-kernel';
import type { CurrencyCode } from '@otc/contracts';
import { CreditLedgerEntry, type CreditEntryType } from './credit-ledger-entry.js';
import type { BuyerCreditSnapshot } from './buyer-credit-snapshot.js';
import { summariseLedger, type LedgerSummary } from './credit-exposure.js';
import { creditApprovedEvent, creditRejectedEvent, creditReleasedEvent, type CreditReleaseReason, type CreditRejectionReason } from './credit-events.js';
import {
  CreditLimitExceededError,
  CreditRefusalMismatchError,
  CreditReleaseUnderflowError,
  FactAggregateMismatchError,
  InvalidBuyerCreditSnapshotError,
  NoActiveHoldError,
} from './credit-errors.js';

/** Time and causation in, nothing pulled — mirrors `apps/fulfillment/.../stock-item.ts`'s `StockContext`. */
export interface CreditContext {
  readonly occurredAt: Date;
  readonly causationId: UniqueId;
}

export interface HoldRequest {
  readonly orderReference: OrderNumber;
  /** The order total — integer minor units + currency. */
  readonly amount: Money;
  /** The order id, from `x-correlation-id`. */
  readonly correlationId: UniqueId;
}

export type HoldEvaluation =
  | { readonly kind: 'already_held'; readonly heldAmount: Money }
  | { readonly kind: 'currency_mismatch'; readonly expected: CurrencyCode }
  | { readonly kind: 'fits' }
  | { readonly kind: 'over_limit'; readonly availableCredit: Money };

interface BuyerCreditProps {
  readonly code: CreditLineReference;
  readonly retailerCode: string;
  readonly companyCode: string;
  readonly creditLimit: number;
  readonly currency: string;
  /** The BC5 scalar over the WHOLE line, kept in step with every appended entry — never recomputed from a full ledger scan inside the domain. */
  committedExposure: number;
  /** Entries the repository loaded — B2: never rewritten, only read. */
  readonly loadedEntries: readonly CreditLedgerEntry[];
  /** Entries appended during THIS instance's lifetime — what the repository inserts (`appendedEntries`). */
  appended: readonly CreditLedgerEntry[];
}

/** Every entry (loaded + appended) whose `orderReference` matches — evaluateHold/consumeHold/releaseHold never assume the loaded set is scoped to a single order, even though the repository (design.md §3.1) always loads it that way. */
function entriesOf(props: BuyerCreditProps, orderReference: OrderNumber): CreditLedgerEntry[] {
  return [...props.loadedEntries, ...props.appended].filter((entry) => entry.orderReference.equals(orderReference));
}

export class BuyerCredit extends AggregateRoot<BuyerCredit> {
  private constructor(
    id: UniqueId,
    private props: BuyerCreditProps,
  ) {
    super(id);
  }

  /**
   * Rebuilds a credit line from its stored `credits` row, the whole line's
   * `committedExposure` scalar and the loaded order's entries. Refuses
   * (`InvalidBuyerCreditSnapshotError`) a snapshot that already violates
   * **B1** (`committedExposure > creditLimit`) or **B3** (a loaded entry in
   * a currency other than the line's) — the two invariants a snapshot CAN
   * be checked against without the whole ledger.
   */
  static reconstitute(snapshot: BuyerCreditSnapshot): BuyerCredit {
    if (snapshot.creditLimit < 0) {
      throw new InvalidBuyerCreditSnapshotError(`creditLimit (${snapshot.creditLimit}) must be non-negative`, snapshot.id);
    }
    if (snapshot.committedExposure > snapshot.creditLimit) {
      throw new InvalidBuyerCreditSnapshotError(
        `committedExposure (${snapshot.committedExposure}) exceeds creditLimit (${snapshot.creditLimit}) — violates B1`,
        snapshot.id,
      );
    }
    for (const entry of snapshot.orderEntries) {
      if (entry.amount.currency !== snapshot.currency) {
        throw new InvalidBuyerCreditSnapshotError(
          `entry ${entry.id.value} currency (${entry.amount.currency}) does not match the line's currency (${snapshot.currency}) — violates B3`,
          snapshot.id,
        );
      }
    }

    return new BuyerCredit(snapshot.id, {
      code: snapshot.code,
      retailerCode: snapshot.retailerCode,
      companyCode: snapshot.companyCode,
      creditLimit: snapshot.creditLimit,
      currency: snapshot.currency,
      committedExposure: snapshot.committedExposure,
      loadedEntries: snapshot.orderEntries.map((entry) => CreditLedgerEntry.reconstitute(entry)),
      appended: [],
    });
  }

  get code(): CreditLineReference {
    return this.props.code;
  }

  get retailerCode(): string {
    return this.props.retailerCode;
  }

  get companyCode(): string {
    return this.props.companyCode;
  }

  get currency(): string {
    return this.props.currency;
  }

  get creditLimit(): Money {
    return Money.of(this.props.creditLimit, this.props.currency);
  }

  /** `creditLimit − committedExposure` (BC5). Never negative while B1 holds; `reconstitute` refuses a snapshot where it would be. */
  get availableCredit(): Money {
    return Money.of(this.props.creditLimit - this.props.committedExposure, this.props.currency);
  }

  /** The BC6 split for the orders this instance was loaded with. */
  get summary(): LedgerSummary {
    return summariseLedger([...this.props.loadedEntries, ...this.props.appended].map((entry) => entry.toSnapshot()));
  }

  /** The entries appended during this instance's lifetime — what the repository inserts. The loaded ones are never re-written (B2: append-only). */
  get appendedEntries(): readonly CreditLedgerEntry[] {
    return this.props.appended;
  }

  /** PURE, no mutation, no event, no port. The single decision function; the application layer consults the credit-decision port ONLY on `fits`. */
  evaluateHold(request: HoldRequest): HoldEvaluation {
    const existing = entriesOf(this.props, request.orderReference);
    const holdEntry = existing.find((entry) => entry.type === 'hold');
    if (holdEntry) {
      // BC7 — ANY recorded hold entry, whatever its net exposure is now.
      return { kind: 'already_held', heldAmount: holdEntry.amount };
    }
    if (request.amount.currency !== this.props.currency) {
      return { kind: 'currency_mismatch', expected: this.props.currency };
    }
    const available = this.props.creditLimit - this.props.committedExposure;
    if (request.amount.amount > available) {
      return { kind: 'over_limit', availableCredit: Money.of(available, this.props.currency) };
    }
    return { kind: 'fits' };
  }

  /**
   * Appends ONE `hold` entry and exactly one `credit.approved.v1` whose
   * `availableCreditAfter` is recomputed WITH the new entry (BC10). Throws
   * `CreditLimitExceededError` unless `evaluateHold` would answer `fits` —
   * a caller cannot bypass B1 by skipping the evaluation.
   */
  approveHold(request: HoldRequest, ctx: CreditContext, newId: () => UniqueId): CreditLedgerEntry {
    const evaluation = this.evaluateHold(request);
    if (evaluation.kind !== 'fits') {
      const available = this.props.creditLimit - this.props.committedExposure;
      throw new CreditLimitExceededError(request.amount.amount, available);
    }

    const entry = CreditLedgerEntry.create({
      id: newId(),
      orderReference: request.orderReference,
      amount: request.amount,
      type: 'hold',
      entryDate: ctx.occurredAt,
    });
    this.props = {
      ...this.props,
      committedExposure: this.props.committedExposure + request.amount.amount,
      appended: [...this.props.appended, entry],
    };

    const availableCreditAfter = this.props.creditLimit - this.props.committedExposure;
    const event = creditApprovedEvent(
      this,
      {
        orderReference: request.orderReference,
        retailerCode: this.props.retailerCode,
        companyCode: this.props.companyCode,
        currency: this.props.currency,
        heldAmount: request.amount.amount,
        availableCreditAfter,
      },
      request.correlationId,
      ctx,
    );
    this.appendFact(event);

    return entry;
  }

  /**
   * Appends NO entry and exactly one `credit.rejected.v1` carrying
   * `reason` (R39, B1). Throws `CreditRefusalMismatchError` if `reason` is
   * `over_limit` while the amount actually fits — a refusal must not lie
   * about why.
   */
  refuseHold(request: HoldRequest, reason: CreditRejectionReason, ctx: CreditContext): void {
    const available = this.props.creditLimit - this.props.committedExposure;
    if (reason === 'over_limit' && request.amount.amount <= available) {
      throw new CreditRefusalMismatchError(reason);
    }

    const event = creditRejectedEvent(
      this,
      {
        orderReference: request.orderReference,
        retailerCode: this.props.retailerCode,
        companyCode: this.props.companyCode,
        currency: this.props.currency,
        requestedAmount: request.amount.amount,
        availableCredit: available,
        reason,
      },
      request.correlationId,
      ctx,
    );
    this.appendFact(event);
  }

  /**
   * Appends ONE `release` entry for the order's outstanding exposure and
   * exactly one `credit.released.v1` with `reason`. Returns `null` — no
   * entry, no fact — when the order has no outstanding exposure (BC11,
   * B5). Throws `CreditReleaseUnderflowError` if the loaded ledger already
   * shows a negative exposure for the order (a corrupted snapshot).
   */
  releaseHold(
    input: { readonly orderReference: OrderNumber; readonly reason: CreditReleaseReason; readonly correlationId: UniqueId },
    ctx: CreditContext,
    newId: () => UniqueId,
  ): CreditLedgerEntry | null {
    const relevant = entriesOf(this.props, input.orderReference).map((entry) => entry.toSnapshot());
    const summary = summariseLedger(relevant);
    const outstanding = summary.byOrder.find((order) => order.orderReference === input.orderReference.value)?.exposure ?? 0;

    if (outstanding < 0) {
      throw new CreditReleaseUnderflowError(input.orderReference.value, outstanding);
    }
    if (outstanding === 0) {
      return null;
    }

    const amount = Money.of(outstanding, this.props.currency);
    const entry = CreditLedgerEntry.create({
      id: newId(),
      orderReference: input.orderReference,
      amount,
      type: 'release',
      entryDate: ctx.occurredAt,
    });
    this.props = {
      ...this.props,
      committedExposure: this.props.committedExposure - outstanding,
      appended: [...this.props.appended, entry],
    };

    const availableCreditAfter = this.props.creditLimit - this.props.committedExposure;
    const event = creditReleasedEvent(
      this,
      {
        orderReference: input.orderReference,
        retailerCode: this.props.retailerCode,
        companyCode: this.props.companyCode,
        currency: this.props.currency,
        releasedAmount: outstanding,
        availableCreditAfter,
        reason: input.reason,
      },
      input.correlationId,
      ctx,
    );
    this.appendFact(event);

    return entry;
  }

  /**
   * Appends ONE `consume` entry of the order's active hold. Emits NOTHING
   * — `invoice.issued.v1` is feature 21's Invoice fact (R40, BC12). Throws
   * `NoActiveHoldError` when the order holds nothing.
   */
  consumeHold(input: { readonly orderReference: OrderNumber }, ctx: CreditContext, newId: () => UniqueId): CreditLedgerEntry {
    const relevant = entriesOf(this.props, input.orderReference).map((entry) => entry.toSnapshot());
    const summary = summariseLedger(relevant);
    const activeHold = summary.byOrder.find((order) => order.orderReference === input.orderReference.value)?.activeHold ?? 0;

    if (activeHold <= 0) {
      throw new NoActiveHoldError(input.orderReference.value);
    }

    const amount = Money.of(activeHold, this.props.currency);
    const entry = CreditLedgerEntry.create({
      id: newId(),
      orderReference: input.orderReference,
      amount,
      type: 'consume',
      entryDate: ctx.occurredAt,
    });
    // `consume` is numerically neutral by construction (R40) — it never
    // touches `committedExposure`, which is computed only from `hold` and
    // `release` entries (credit-exposure.ts).
    this.props = { ...this.props, appended: [...this.props.appended, entry] };

    return entry;
  }

  toSnapshot(): BuyerCreditSnapshot {
    return {
      id: this.id,
      code: this.props.code,
      retailerCode: this.props.retailerCode,
      companyCode: this.props.companyCode,
      creditLimit: this.props.creditLimit,
      currency: this.props.currency,
      committedExposure: this.props.committedExposure,
      orderEntries: [...this.props.loadedEntries, ...this.props.appended].map((entry) => entry.toSnapshot()),
    };
  }

  /** Mirrors `apps/fulfillment/.../stock-item.ts`'s `recordOrderFact` guard (domain-model.md §8 rule 5) — every fact this aggregate builds names itself as `aggregateId`, so this can never actually fire; kept because every other aggregate in the trilogy pays the same one-line defence. */
  private appendFact(event: DomainEventEnvelope): void {
    if (!event.aggregateId.equals(this.id)) {
      throw new FactAggregateMismatchError(this.id, event.aggregateId);
    }
    this.addDomainEvent(event);
  }
}

// Re-exported so callers never need to import from `@otc/shared-kernel`
// just to name a `CreditEntryType` alongside `BuyerCredit`.
export type { CreditEntryType };
