// Seven `@CommandHandler`s — one per notified fact, each a one-line
// delegation to `NotificationDispatchService.dispatch` (same "thin
// CommandHandler, ONE generic transactional/dispatch unit behind it" shape
// apps/orders/src/application/commands/saga-fact.handlers.ts establishes
// for `SagaFactHandler`). Each handler supplies the fact-specific template
// builder and nothing else — deleting a `dispatch(...)` call here is
// exactly the "fact-emission guard" CLAUDE.md's testing conventions
// require every branch that emits a fact to be protected against; see
// notify.command-handlers.spec.ts's armed-deletion records in
// progress/impl_notifications_service.md.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { NotificationDispatchService } from '../notification-dispatch.service';
import { buildInvoiceIssuedMessage } from '../../infrastructure/templates/invoice-issued.template';
import { buildOrderCancelledMessage } from '../../infrastructure/templates/order-cancelled.template';
import { buildOrderCompletedMessage } from '../../infrastructure/templates/order-completed.template';
import { buildOrderConfirmedMessage } from '../../infrastructure/templates/order-confirmed.template';
import { buildOrderDespatchedMessage } from '../../infrastructure/templates/order-despatched.template';
import { buildOrderPlacedMessage } from '../../infrastructure/templates/order-placed.template';
import { buildPaymentReceivedMessage } from '../../infrastructure/templates/payment-received.template';
import {
  NotifyInvoiceIssuedCommand,
  NotifyOrderCancelledCommand,
  NotifyOrderCompletedCommand,
  NotifyOrderConfirmedCommand,
  NotifyOrderDespatchedCommand,
  NotifyOrderPlacedCommand,
  NotifyPaymentReceivedCommand,
} from './notify.commands';

@CommandHandler(NotifyOrderPlacedCommand)
export class NotifyOrderPlacedHandler implements ICommandHandler<NotifyOrderPlacedCommand> {
  constructor(@Inject(NotificationDispatchService) private readonly dispatcher: NotificationDispatchService) {}

  async execute(command: NotifyOrderPlacedCommand): Promise<void> {
    await this.dispatcher.dispatch(command.envelope, buildOrderPlacedMessage);
  }
}

@CommandHandler(NotifyOrderConfirmedCommand)
export class NotifyOrderConfirmedHandler implements ICommandHandler<NotifyOrderConfirmedCommand> {
  constructor(@Inject(NotificationDispatchService) private readonly dispatcher: NotificationDispatchService) {}

  async execute(command: NotifyOrderConfirmedCommand): Promise<void> {
    await this.dispatcher.dispatch(command.envelope, buildOrderConfirmedMessage);
  }
}

@CommandHandler(NotifyOrderDespatchedCommand)
export class NotifyOrderDespatchedHandler implements ICommandHandler<NotifyOrderDespatchedCommand> {
  constructor(@Inject(NotificationDispatchService) private readonly dispatcher: NotificationDispatchService) {}

  async execute(command: NotifyOrderDespatchedCommand): Promise<void> {
    await this.dispatcher.dispatch(command.envelope, buildOrderDespatchedMessage);
  }
}

@CommandHandler(NotifyInvoiceIssuedCommand)
export class NotifyInvoiceIssuedHandler implements ICommandHandler<NotifyInvoiceIssuedCommand> {
  constructor(@Inject(NotificationDispatchService) private readonly dispatcher: NotificationDispatchService) {}

  async execute(command: NotifyInvoiceIssuedCommand): Promise<void> {
    await this.dispatcher.dispatch(command.envelope, buildInvoiceIssuedMessage);
  }
}

@CommandHandler(NotifyPaymentReceivedCommand)
export class NotifyPaymentReceivedHandler implements ICommandHandler<NotifyPaymentReceivedCommand> {
  constructor(@Inject(NotificationDispatchService) private readonly dispatcher: NotificationDispatchService) {}

  async execute(command: NotifyPaymentReceivedCommand): Promise<void> {
    await this.dispatcher.dispatch(command.envelope, buildPaymentReceivedMessage);
  }
}

@CommandHandler(NotifyOrderCompletedCommand)
export class NotifyOrderCompletedHandler implements ICommandHandler<NotifyOrderCompletedCommand> {
  constructor(@Inject(NotificationDispatchService) private readonly dispatcher: NotificationDispatchService) {}

  async execute(command: NotifyOrderCompletedCommand): Promise<void> {
    await this.dispatcher.dispatch(command.envelope, buildOrderCompletedMessage);
  }
}

@CommandHandler(NotifyOrderCancelledCommand)
export class NotifyOrderCancelledHandler implements ICommandHandler<NotifyOrderCancelledCommand> {
  constructor(@Inject(NotificationDispatchService) private readonly dispatcher: NotificationDispatchService) {}

  async execute(command: NotifyOrderCancelledCommand): Promise<void> {
    await this.dispatcher.dispatch(command.envelope, buildOrderCancelledMessage);
  }
}

export const NOTIFY_COMMAND_HANDLERS = [
  NotifyOrderPlacedHandler,
  NotifyOrderConfirmedHandler,
  NotifyOrderDespatchedHandler,
  NotifyInvoiceIssuedHandler,
  NotifyPaymentReceivedHandler,
  NotifyOrderCompletedHandler,
  NotifyOrderCancelledHandler,
];
