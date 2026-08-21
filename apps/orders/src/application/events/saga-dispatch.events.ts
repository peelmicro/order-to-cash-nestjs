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
