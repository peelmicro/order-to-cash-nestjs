// One thin `@CommandHandler` class (mirrors `invoice.command-handlers.ts`)
// — no logic beyond delegation, every dependency through `@Inject(TOKEN)`
// (CLAUDE.md's DI rule), registered as a class provider in `app.module.ts`.
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { PaymentRegisterReplyPayload } from '@otc/contracts';
import { PaymentRegisterHandler } from '../payment-register.handler.js';
import { RegisterPaymentCommand } from './payment.commands.js';

@CommandHandler(RegisterPaymentCommand)
export class RegisterPaymentHandler implements ICommandHandler<RegisterPaymentCommand, PaymentRegisterReplyPayload> {
  constructor(@Inject(PaymentRegisterHandler) private readonly handler: PaymentRegisterHandler) {}

  execute(command: RegisterPaymentCommand): Promise<PaymentRegisterReplyPayload> {
    return this.handler.register(command);
  }
}

/** Every `@CommandHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const PAYMENT_COMMAND_HANDLERS = [RegisterPaymentHandler] as const;
