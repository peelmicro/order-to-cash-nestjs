// The five `@CommandHandler` wrappers for the `Issue…Command`s (design.md
// §5.5) — each delegates to `SagaCommandDispatcher.dispatch(orderId,
// command)`, decoupled from the concrete dispatcher class via the narrow
// `DispatchesSagaCommand` surface so a unit test needs no real store/port.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { UniqueId } from '@otc/shared-kernel';
import { SAGA_COMMAND_DISPATCHER, type DispatchesSagaCommands } from '../../infrastructure/saga/saga-command-dispatcher';
import {
  IssueCreditHoldCommand,
  IssueDespatchCreateCommand,
  IssueInvoiceIssueCommand,
  IssueStockReleaseCommand,
  IssueStockReserveCommand,
} from './saga-dispatch.commands';

@CommandHandler(IssueStockReserveCommand)
export class IssueStockReserveHandler implements ICommandHandler<IssueStockReserveCommand, void> {
  constructor(@Inject(SAGA_COMMAND_DISPATCHER) private readonly dispatcher: DispatchesSagaCommands) {}

  async execute(command: IssueStockReserveCommand): Promise<void> {
    await this.dispatcher.dispatch(UniqueId.from(command.orderId), 'stock.reserve');
  }
}

@CommandHandler(IssueCreditHoldCommand)
export class IssueCreditHoldHandler implements ICommandHandler<IssueCreditHoldCommand, void> {
  constructor(@Inject(SAGA_COMMAND_DISPATCHER) private readonly dispatcher: DispatchesSagaCommands) {}

  async execute(command: IssueCreditHoldCommand): Promise<void> {
    await this.dispatcher.dispatch(UniqueId.from(command.orderId), 'credit.hold');
  }
}

@CommandHandler(IssueStockReleaseCommand)
export class IssueStockReleaseHandler implements ICommandHandler<IssueStockReleaseCommand, void> {
  constructor(@Inject(SAGA_COMMAND_DISPATCHER) private readonly dispatcher: DispatchesSagaCommands) {}

  async execute(command: IssueStockReleaseCommand): Promise<void> {
    await this.dispatcher.dispatch(UniqueId.from(command.orderId), 'stock.release');
  }
}

@CommandHandler(IssueDespatchCreateCommand)
export class IssueDespatchCreateHandler implements ICommandHandler<IssueDespatchCreateCommand, void> {
  constructor(@Inject(SAGA_COMMAND_DISPATCHER) private readonly dispatcher: DispatchesSagaCommands) {}

  async execute(command: IssueDespatchCreateCommand): Promise<void> {
    await this.dispatcher.dispatch(UniqueId.from(command.orderId), 'despatch.create');
  }
}

@CommandHandler(IssueInvoiceIssueCommand)
export class IssueInvoiceIssueHandler implements ICommandHandler<IssueInvoiceIssueCommand, void> {
  constructor(@Inject(SAGA_COMMAND_DISPATCHER) private readonly dispatcher: DispatchesSagaCommands) {}

  async execute(command: IssueInvoiceIssueCommand): Promise<void> {
    await this.dispatcher.dispatch(UniqueId.from(command.orderId), 'invoice.issue');
  }
}

/** Every `@CommandHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const SAGA_DISPATCH_COMMAND_HANDLERS = [
  IssueStockReserveHandler,
  IssueCreditHoldHandler,
  IssueStockReleaseHandler,
  IssueDespatchCreateHandler,
  IssueInvoiceIssueHandler,
] as const;
