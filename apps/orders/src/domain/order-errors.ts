// The domain errors of the `Order` aggregate — design.md §7. Every class
// extends `DomainError` (`@otc/shared-kernel`), carries a stable `code` and
// the fields a caller (and a test) needs. Codes are the vocabulary the RPC
// error mapping (feature 15) and the HTTP problem mapping (feature 25) will
// translate; they are stable from here on.
import { DomainError, type Money, type UniqueId } from '@otc/shared-kernel';
import type { CancellationReason } from './order-cancellation-reason.js';
import type { OrderStatus } from './order-status.js';

/** R9 (**O5**, **O7**) — an attempted `(from, to)` pair absent from Table T-1. */
export class OrderTransitionNotAllowedError extends DomainError {
  readonly code = 'ORDER_TRANSITION_NOT_ALLOWED';

  constructor(
    readonly orderId: UniqueId,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`order ${orderId.value}: transition ${from} -> ${to} is not an edge of Table T-1`);
  }
}

/** R5 (**O1**) — an order with no lines, or the removal of the last remaining line. */
export class EmptyOrderError extends DomainError {
  readonly code = 'ORDER_HAS_NO_LINES';

  constructor(readonly orderId?: UniqueId) {
    super(
      orderId
        ? `order ${orderId.value}: an order always has at least one line`
        : 'an order always has at least one line',
    );
  }
}

/** R7 (**O4**) — a line mutation attempted while `status` is outside `LINES_MUTABLE_IN`. */
export class OrderLinesFrozenError extends DomainError {
  readonly code = 'ORDER_LINES_FROZEN';

  constructor(
    readonly orderId: UniqueId,
    readonly status: OrderStatus,
  ) {
    super(`order ${orderId.value}: lines are frozen in status ${status}`);
  }
}

/** R6 (**O3**) — totals would derive to a negative `totalAmount`. */
export class NegativeOrderTotalError extends DomainError {
  readonly code = 'ORDER_TOTAL_NEGATIVE';

  constructor(
    readonly totalAmount: Money,
    readonly orderId?: UniqueId,
  ) {
    super(
      `${orderId ? `order ${orderId.value}: ` : ''}total amount would be negative: ${totalAmount.toString()}`,
    );
  }
}

/** OA1 (**O2**) — a line's `unitPrice`/`lineDiscount` currency differs from the order currency. */
export class OrderLineCurrencyMismatchError extends DomainError {
  readonly code = 'ORDER_LINE_CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly orderId?: UniqueId,
    readonly lineId?: UniqueId,
  ) {
    super(
      `${orderId ? `order ${orderId.value}: ` : ''}line currency ${actual} does not match the order currency ${expected}`,
    );
  }
}

/** R6, R7 — a line id supplied to `removeLine`/`changeLineQuantity` that does not exist on the order. */
export class UnknownOrderLineError extends DomainError {
  readonly code = 'ORDER_LINE_NOT_FOUND';

  constructor(
    readonly orderId: UniqueId,
    readonly lineId: UniqueId,
  ) {
    super(`order ${orderId.value}: no line with id ${lineId.value}`);
  }
}

/** R10 (**O6**) — `cancel` called with no reason. */
export class CancellationReasonRequiredError extends DomainError {
  readonly code = 'ORDER_CANCELLATION_REASON_REQUIRED';

  constructor(readonly orderId: UniqueId) {
    super(`order ${orderId.value}: cancellation requires a reason`);
  }
}

/** R10 (**O6**) — `cancel` called with a reason outside the closed set. */
export class InvalidCancellationReasonError extends DomainError {
  readonly code = 'ORDER_CANCELLATION_REASON_INVALID';

  constructor(
    readonly orderId: UniqueId,
    readonly reason: string,
  ) {
    super(`order ${orderId.value}: "${reason}" is not a valid cancellation reason`);
  }
}

/** OA4 — a cancellation reason Table T-1 does not pair with the order's current status. */
export class CancellationReasonNotApplicableError extends DomainError {
  readonly code = 'ORDER_CANCELLATION_REASON_NOT_APPLICABLE';

  constructor(
    readonly orderId: UniqueId,
    readonly status: OrderStatus,
    readonly reason: CancellationReason,
  ) {
    super(`order ${orderId.value}: reason "${reason}" does not apply to status ${status}`);
  }
}

/** OA3 — `Order.reconstitute` given a snapshot that violates a domain invariant. */
export class InvalidOrderSnapshotError extends DomainError {
  readonly code = 'ORDER_SNAPSHOT_INVALID';

  constructor(
    readonly reason: string,
    readonly orderId?: UniqueId,
  ) {
    super(`${orderId ? `order ${orderId.value}: ` : ''}invalid snapshot: ${reason}`);
  }
}
