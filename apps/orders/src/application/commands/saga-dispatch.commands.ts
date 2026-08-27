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

/** Feature 41's follow-up pass — `CancelOrderHandler`'s fast-path hop for the `credit_approved`/`confirmed` branch, mirrors `IssueStockReleaseCommand` exactly. */
export class IssueCreditReleaseCommand extends Command<void> {
  constructor(readonly orderId: string) {
    super();
  }
}
