// The five dispatch-owed application events (design.md §5.5) — one per
// step-table row with a `commandAfter`, published by the owning fact
// `@CommandHandler` strictly AFTER commit (saga-fact.handlers.ts). Plain,
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
 * `credit.released.v1` processed while `credit_approved`/`confirmed` — owes
 * `stock.release` (feature 41's follow-up pass: the compensation release,
 * reverse order of acquisition, saga.md §4.3). A SEPARATE class from
 * `CreditRejectionRecorded` even though both ultimately map to the SAME
 * `IssueStockReleaseCommand` (`order.sagas.ts` merges both streams into
 * one) — the name stays honest about which fact and which precondition
 * actually owed the command; `credit.released.v1`'s OTHER variant
 * (precondition `paid`, R24) never reaches this event at all, since that
 * variant has no `commandAfter`.
 */
export class CreditReleasedForCancellationRecorded implements IEvent {
  constructor(
    readonly orderId: string,
    readonly correlationId: string,
  ) {}
}
