// The ten `@CommandHandler` wrappers (design.md §5.1, §5.5) — one-line
// delegations to `SagaFactHandler`, the single transactional unit. Each
// publishes its matching dispatch-owed event on the `EventBus` ONLY when
// the outcome is `processed` WITH an enqueued command — i.e. strictly
// after the transaction committed, never on `duplicate` or `ignored`.
import { Inject } from '@nestjs/common';
import { CommandHandler, EventBus, type ICommandHandler } from '@nestjs/cqrs';
import { SagaFactHandler, type SagaFactResult } from '../saga-fact-handler';
import {
  CreditRejectionRecorded,
  LateCreditApprovalRecorded,
  OrderConfirmed,
  OrderMarkedDespatched,
  OrderMarkedStockReserved,
  OrderPlacedFactRecorded,
  StockReleasedForCancellationRecorded,
} from '../events/saga-dispatch.events';
import {
  HandleCreditApprovedFactCommand,
  HandleCreditReleasedFactCommand,
  HandleCreditRejectedFactCommand,
  HandleInvoiceIssuedFactCommand,
  HandleOrderDespatchedFactCommand,
  HandleOrderPlacedFactCommand,
  HandlePaymentReceivedFactCommand,
  HandleStockRejectedFactCommand,
  HandleStockReleasedFactCommand,
  HandleStockReservedFactCommand,
} from './saga-fact.commands';

@CommandHandler(HandleOrderPlacedFactCommand)
export class HandleOrderPlacedFactHandler implements ICommandHandler<HandleOrderPlacedFactCommand, SagaFactResult> {
  constructor(
    @Inject(SagaFactHandler) private readonly handler: SagaFactHandler,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  async execute(command: HandleOrderPlacedFactCommand): Promise<SagaFactResult> {
    const result = await this.handler.handle(command.envelope, command.topic);
    if (result.outcome === 'processed' && result.enqueued) {
      const orderId = command.envelope.correlationId;
      this.eventBus.publish(new OrderPlacedFactRecorded(orderId, command.envelope.correlationId));
    }
    return result;
  }
}

@CommandHandler(HandleStockReservedFactCommand)
export class HandleStockReservedFactHandler
  implements ICommandHandler<HandleStockReservedFactCommand, SagaFactResult>
{
  constructor(
    @Inject(SagaFactHandler) private readonly handler: SagaFactHandler,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  async execute(command: HandleStockReservedFactCommand): Promise<SagaFactResult> {
    const result = await this.handler.handle(command.envelope, command.topic);
    if (result.outcome === 'processed' && result.enqueued) {
      const orderId = command.envelope.correlationId;
      this.eventBus.publish(new OrderMarkedStockReserved(orderId, command.envelope.correlationId));
    }
    return result;
  }
}

@CommandHandler(HandleStockRejectedFactCommand)
export class HandleStockRejectedFactHandler
  implements ICommandHandler<HandleStockRejectedFactCommand, SagaFactResult>
{
  constructor(@Inject(SagaFactHandler) private readonly handler: SagaFactHandler) {}

  // Cancel path A (R26) — no command is ever owed, so no event to publish.
  async execute(command: HandleStockRejectedFactCommand): Promise<SagaFactResult> {
    return this.handler.handle(command.envelope, command.topic);
  }
}

@CommandHandler(HandleCreditApprovedFactCommand)
export class HandleCreditApprovedFactHandler
  implements ICommandHandler<HandleCreditApprovedFactCommand, SagaFactResult>
{
  constructor(
    @Inject(SagaFactHandler) private readonly handler: SagaFactHandler,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  /**
   * SA-4 — this is the ONE wrapper whose published event depends on WHICH
   * command was enqueued, not merely on whether one was. The ordinary path
   * confirms the order and owes `despatch.create` (`OrderConfirmed`); a
   * late `credit.approved.v1` for an order whose operator cancellation was
   * already accepted owes `credit.release` and performs no transition
   * (`LateCreditApprovalRecorded`). Keying off the fact type alone would
   * publish `OrderConfirmed` for the late case and issue a
   * `despatch.create` for an order that is being cancelled.
   */
  async execute(command: HandleCreditApprovedFactCommand): Promise<SagaFactResult> {
    const result = await this.handler.handle(command.envelope, command.topic);
    if (result.outcome === 'processed' && result.enqueued) {
      const orderId = command.envelope.correlationId;
      this.eventBus.publish(
        result.enqueued === 'credit.release'
          ? new LateCreditApprovalRecorded(orderId, command.envelope.correlationId)
          : new OrderConfirmed(orderId, command.envelope.correlationId),
      );
    }
    return result;
  }
}

@CommandHandler(HandleCreditRejectedFactCommand)
export class HandleCreditRejectedFactHandler
  implements ICommandHandler<HandleCreditRejectedFactCommand, SagaFactResult>
{
  constructor(
    @Inject(SagaFactHandler) private readonly handler: SagaFactHandler,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  async execute(command: HandleCreditRejectedFactCommand): Promise<SagaFactResult> {
    const result = await this.handler.handle(command.envelope, command.topic);
    if (result.outcome === 'processed' && result.enqueued) {
      const orderId = command.envelope.correlationId;
      this.eventBus.publish(new CreditRejectionRecorded(orderId, command.envelope.correlationId));
    }
    return result;
  }
}

@CommandHandler(HandleStockReleasedFactCommand)
export class HandleStockReleasedFactHandler
  implements ICommandHandler<HandleStockReleasedFactCommand, SagaFactResult>
{
  constructor(
    @Inject(SagaFactHandler) private readonly handler: SagaFactHandler,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  /**
   * `stock.released.v1` has THREE step-table variants (saga-steps.ts).
   * R28/SO7's `stock_reserved` variant is cancel path B's terminal fact and
   * owes NO command — `result.enqueued` stays `undefined` for it, exactly
   * as before SA-4. The `credit_approved`/`confirmed` variants owe
   * `credit.release` (the operator cancellation's stock release won
   * Fulfillment's lock), published as
   * `StockReleasedForCancellationRecorded` so `order.sagas.ts`'s fast path
   * can issue it — the same "publish only when `result.enqueued`" guard
   * every other dispatch-owed event uses.
   */
  async execute(command: HandleStockReleasedFactCommand): Promise<SagaFactResult> {
    const result = await this.handler.handle(command.envelope, command.topic);
    if (result.outcome === 'processed' && result.enqueued) {
      const orderId = command.envelope.correlationId;
      this.eventBus.publish(new StockReleasedForCancellationRecorded(orderId, command.envelope.correlationId));
    }
    return result;
  }
}

@CommandHandler(HandleOrderDespatchedFactCommand)
export class HandleOrderDespatchedFactHandler
  implements ICommandHandler<HandleOrderDespatchedFactCommand, SagaFactResult>
{
  constructor(
    @Inject(SagaFactHandler) private readonly handler: SagaFactHandler,
    @Inject(EventBus) private readonly eventBus: EventBus,
  ) {}

  async execute(command: HandleOrderDespatchedFactCommand): Promise<SagaFactResult> {
    const result = await this.handler.handle(command.envelope, command.topic);
    if (result.outcome === 'processed' && result.enqueued) {
      const orderId = command.envelope.correlationId;
      this.eventBus.publish(new OrderMarkedDespatched(orderId, command.envelope.correlationId));
    }
    return result;
  }
}

@CommandHandler(HandleInvoiceIssuedFactCommand)
export class HandleInvoiceIssuedFactHandler
  implements ICommandHandler<HandleInvoiceIssuedFactCommand, SagaFactResult>
{
  constructor(@Inject(SagaFactHandler) private readonly handler: SagaFactHandler) {}

  // R23 — the saga now waits for the outside world; no command is owed.
  async execute(command: HandleInvoiceIssuedFactCommand): Promise<SagaFactResult> {
    return this.handler.handle(command.envelope, command.topic);
  }
}

@CommandHandler(HandlePaymentReceivedFactCommand)
export class HandlePaymentReceivedFactHandler
  implements ICommandHandler<HandlePaymentReceivedFactCommand, SagaFactResult>
{
  constructor(@Inject(SagaFactHandler) private readonly handler: SagaFactHandler) {}

  async execute(command: HandlePaymentReceivedFactCommand): Promise<SagaFactResult> {
    return this.handler.handle(command.envelope, command.topic);
  }
}

@CommandHandler(HandleCreditReleasedFactCommand)
export class HandleCreditReleasedFactHandler
  implements ICommandHandler<HandleCreditReleasedFactCommand, SagaFactResult>
{
  constructor(@Inject(SagaFactHandler) private readonly handler: SagaFactHandler) {}

  /**
   * SA-4 — `credit.released.v1`'s three variants now owe NOTHING between
   * them, so this wrapper takes no `EventBus` at all (the same shape
   * `HandleStockRejectedFactHandler` above already has): R24's `paid`
   * variant closes the saga (`order.completed.v1`), and the
   * `credit_approved`/`confirmed` variants are the TERMINAL cancel of an
   * operator cancellation. Before SA-4 those two owed `stock.release` under
   * the superseded credit-first ordering; the command they owed moved to
   * `stock.released.v1`'s own variants.
   */
  async execute(command: HandleCreditReleasedFactCommand): Promise<SagaFactResult> {
    return this.handler.handle(command.envelope, command.topic);
  }
}

/** Every `@CommandHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const SAGA_FACT_COMMAND_HANDLERS = [
  HandleOrderPlacedFactHandler,
  HandleStockReservedFactHandler,
  HandleStockRejectedFactHandler,
  HandleCreditApprovedFactHandler,
  HandleCreditRejectedFactHandler,
  HandleStockReleasedFactHandler,
  HandleOrderDespatchedFactHandler,
  HandleInvoiceIssuedFactHandler,
  HandlePaymentReceivedFactHandler,
  HandleCreditReleasedFactHandler,
] as const;
