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
  OrderConfirmed,
  OrderMarkedDespatched,
  OrderMarkedStockReserved,
  OrderPlacedFactRecorded,
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
    const result = await this.handler.handle(command.envelope);
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
    const result = await this.handler.handle(command.envelope);
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
    return this.handler.handle(command.envelope);
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

  async execute(command: HandleCreditApprovedFactCommand): Promise<SagaFactResult> {
    const result = await this.handler.handle(command.envelope);
    if (result.outcome === 'processed' && result.enqueued) {
      const orderId = command.envelope.correlationId;
      this.eventBus.publish(new OrderConfirmed(orderId, command.envelope.correlationId));
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
    const result = await this.handler.handle(command.envelope);
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
  constructor(@Inject(SagaFactHandler) private readonly handler: SagaFactHandler) {}

  // Cancel path B's terminal fact (R27/R28) — no command is ever owed.
  async execute(command: HandleStockReleasedFactCommand): Promise<SagaFactResult> {
    return this.handler.handle(command.envelope);
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
    const result = await this.handler.handle(command.envelope);
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
    return this.handler.handle(command.envelope);
  }
}

@CommandHandler(HandlePaymentReceivedFactCommand)
export class HandlePaymentReceivedFactHandler
  implements ICommandHandler<HandlePaymentReceivedFactCommand, SagaFactResult>
{
  constructor(@Inject(SagaFactHandler) private readonly handler: SagaFactHandler) {}

  async execute(command: HandlePaymentReceivedFactCommand): Promise<SagaFactResult> {
    return this.handler.handle(command.envelope);
  }
}

@CommandHandler(HandleCreditReleasedFactCommand)
export class HandleCreditReleasedFactHandler
  implements ICommandHandler<HandleCreditReleasedFactCommand, SagaFactResult>
{
  constructor(@Inject(SagaFactHandler) private readonly handler: SagaFactHandler) {}

  // R24 — closes the saga (order.completed.v1); no further command is owed.
  async execute(command: HandleCreditReleasedFactCommand): Promise<SagaFactResult> {
    return this.handler.handle(command.envelope);
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
