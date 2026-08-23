// One thin `@CommandHandler` class (design.md §5.1) — no logic beyond
// delegation, every dependency through `@Inject(TOKEN)` (CLAUDE.md's DI
// rule), registered as a class provider in `app.module.ts`.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { InvoiceIssueReplyPayload } from '@otc/contracts';
import { InvoiceIssueHandler } from '../invoice-issue.handler.js';
import { IssueInvoiceCommand } from './invoice.commands.js';

@CommandHandler(IssueInvoiceCommand)
export class IssueInvoiceHandler implements ICommandHandler<IssueInvoiceCommand, InvoiceIssueReplyPayload> {
  constructor(@Inject(InvoiceIssueHandler) private readonly handler: InvoiceIssueHandler) {}

  execute(command: IssueInvoiceCommand): Promise<InvoiceIssueReplyPayload> {
    return this.handler.issue(command);
  }
}

/** Every `@CommandHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const INVOICE_COMMAND_HANDLERS = [IssueInvoiceHandler] as const;
