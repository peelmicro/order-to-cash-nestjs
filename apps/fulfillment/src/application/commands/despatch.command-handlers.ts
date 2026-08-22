// The one `@CommandHandler` class of this feature (mirrors
// `stock.command-handlers.ts` §5.1) — thin: delegates to
// `DespatchCreationHandler`, the plain class that owns the whole
// transactional flow. Explicit `@Inject(TOKEN)` (CLAUDE.md DI rule).
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { DespatchCreateReplyPayload } from '@otc/contracts';
import { DespatchCreationHandler } from '../despatch-creation.handler.js';
import { CreateDespatchCommand } from './despatch.commands.js';

@CommandHandler(CreateDespatchCommand)
export class CreateDespatchHandler implements ICommandHandler<
  CreateDespatchCommand,
  DespatchCreateReplyPayload
> {
  constructor(@Inject(DespatchCreationHandler) private readonly handler: DespatchCreationHandler) {}

  execute(command: CreateDespatchCommand): Promise<DespatchCreateReplyPayload> {
    return this.handler.create(command);
  }
}

/** Every `@CommandHandler` class this module declares — for `app.module.ts`'s class-provider list. */
export const DESPATCH_COMMAND_HANDLERS = [CreateDespatchHandler] as const;
