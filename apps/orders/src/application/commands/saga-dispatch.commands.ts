// The five `Issue…Command`s (design.md §5.5) — the `OrderSagas` `@Saga`
// stream's output. Each handler (saga-dispatch.handlers.ts) delegates to
// `SagaCommandDispatcher.dispatch(orderId, command)`.
import { Command } from '@nestjs/cqrs';

export class IssueStockReserveCommand extends Command<void> {
  constructor(readonly orderId: string) {
    super();
  }
}

export class IssueCreditHoldCommand extends Command<void> {
  constructor(readonly orderId: string) {
    super();
  }
}

export class IssueStockReleaseCommand extends Command<void> {
  constructor(readonly orderId: string) {
    super();
  }
}

export class IssueDespatchCreateCommand extends Command<void> {
  constructor(readonly orderId: string) {
    super();
  }
}

export class IssueInvoiceIssueCommand extends Command<void> {
  constructor(readonly orderId: string) {
    super();
  }
}

/** The fast-path hop for `credit.release`, mirroring `IssueStockReleaseCommand` exactly. SA-4 moved its SOURCE: it is no longer issued by `CancelOrderHandler` (which now enqueues `stock.release` for every operator cancellation) but by the fact-driven fast path — `StockReleasedForCancellationRecorded` and `LateCreditApprovalRecorded` (`order.sagas.ts`). */
export class IssueCreditReleaseCommand extends Command<void> {
  constructor(readonly orderId: string) {
    super();
  }
}
