// One thin `@CommandHandler` class (design.md §5.1) — no logic beyond
// delegation, every dependency through `@Inject(TOKEN)` (CLAUDE.md's DI
// rule), registered as a class provider in `app.module.ts`.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { CreditHoldReplyPayload } from '@otc/contracts';
import { CreditHoldHandler } from '../credit-hold.handler.js';
import { HoldCreditCommand } from './credit.commands.js';

@CommandHandler(HoldCreditCommand)
export class HoldCreditHandler implements ICommandHandler<HoldCreditCommand, CreditHoldReplyPayload> {
  constructor(@Inject(CreditHoldHandler) private readonly handler: CreditHoldHandler) {}

  execute(command: HoldCreditCommand): Promise<CreditHoldReplyPayload> {
    return this.handler.hold(command);
  }
}

/** Every `@CommandHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const CREDIT_COMMAND_HANDLERS = [HoldCreditHandler] as const;
