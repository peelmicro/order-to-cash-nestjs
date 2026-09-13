// The dispatch-owed application events (design.md §5.5) — one per
// step-table row with a `commandAfter`, plus SA-4's late-credit-approval
// case, published by the owning fact `@CommandHandler` strictly AFTER
// commit (saga-fact.handlers.ts). Plain,
// framework-free classes (only `IEvent`'s empty marker interface is
// satisfied structurally) — the in-process currency `OrderSagas` maps,
// distinct from the aggregate's own `DomainEventEnvelope` facts that
// travel via the outbox.
import type { IEvent } from '@nestjs/cqrs';

/** `order.placed.v1` processed — owes `stock.reserve`. */
export class OrderPlacedFactRecorded implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}

/** `stock.reserved.v1` processed — owes `credit.hold`. */
export class OrderMarkedStockReserved implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}

/** `credit.rejected.v1` processed — owes `stock.release` (compensation path B, R27). */
export class CreditRejectionRecorded implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}

/** `credit.approved.v1` processed through to `confirmed` — owes `despatch.create`. */
export class OrderConfirmed implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}

/** `order.despatched.v1` processed — owes `invoice.issue`. */
export class OrderMarkedDespatched implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}

/**
 * SA-4 — `stock.released.v1` processed while `credit_approved`/`confirmed`:
 * the operator cancellation's stock release WON Fulfillment's one lock
 * against the `despatch.create` already in flight, so the credit hold may
 * now be returned — owes `credit.release` (saga.md §4.3). A SEPARATE class
 * from `LateCreditApprovalRecorded` below even though both map to the SAME
 * `IssueCreditReleaseCommand` (`order.sagas.ts` merges both streams) — the
 * name stays honest about which fact and which precondition actually owed
 * the command. `stock.released.v1`'s OTHER variant (precondition
 * `stock_reserved`, R28/SO7) never reaches this event: it is a terminal
 * `cancel` step with no `commandAfter`.
 *
 * (Before SA-4 this class was `CreditReleasedForCancellationRecorded` and
 * owed `stock.release` — the superseded credit-first ordering. The two
 * facts swapped roles, so the event did too.)
 */
export class StockReleasedForCancellationRecorded implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}

/**
 * SA-4 — `credit.approved.v1` processed for an order whose operator
 * cancellation was already ACCEPTED (saga.md §4.3, "A credit approval that
 * arrives after the cancellation"): owes `credit.release` and nothing else,
 * with no transition and therefore no `OrderConfirmed`. The ordinary
 * `credit.approved.v1` path still publishes `OrderConfirmed` above; which
 * of the two is published is decided by `result.enqueued`, never by the
 * fact type alone — publishing `OrderConfirmed` here would issue a
 * `despatch.create` for an order that is being cancelled.
 */
export class LateCreditApprovalRecorded implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}
